import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { prisma } from "@/lib/prisma";
import { extractTextFromPdf, isPdfBuffer, isLikelyScannedPdf } from "@/lib/pdf-extract";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { judgeDuplicates, type ExistingProperty } from "@/lib/paste-import/find-duplicates";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { MAX_FILE_SIZE } from "@/lib/storage";
import { buildOwnerDedupKey } from "@/lib/owner-dedup";
import { normalizeName } from "@/lib/normalize";

/**
 * 所有者候補の DB 検索で広めに取る件数。
 * ⚠本番実測(2026-08-26): 姓の先頭1文字で前方一致すると、多い姓(例:佐藤)は
 *   何十件も返りうる。正規化一致で最終的に絞り込む前提で厚めに取る。
 *   この値を変えたら test の固定値テストも直すこと。
 */
const OWNER_CANDIDATE_FETCH_LIMIT = 200;

// ---- 所有者検索の前方一致に使う「先頭1文字」の幅(全角/半角)変換 ----
// ⚠normalizeName の NFKC 正規化は「空白の除去」と「全角/半角の統一」を両方
//   行うが、DB への startsWith はその**正規化後**の1文字を**正規化前(生)**の
//   DB値に対してかけるため、正規化で幅が変わる文字(英数字・カナ)は
//   取りこぼす。例: 貼り付け「ABC商事」(半角)→ normalizeName後も"A"のまま
//   (NFKC は全角→半角へ寄せる)。DB「ＡＢＣ商事」(全角)の生値は"Ａ"で始まる
//   ため startsWith("A") は不一致になり、JS側の正規化一致フィルタに
//   **到達する前に**候補から脱落する。本番実測(2026-08-26): is_archived=false
//   1,312件中、氏名の先頭が全角英数5件・全角カナ24件(半角は0件)。
//   → 先頭1文字を1つに決め打ちせず、全角/半角の両方の表記を集めて OR で
//   startsWith してから、JS側の normalizeName 完全一致で絞り込む。

/** 半角カナの符号位置(全角カナへの正規化対応表を実行時に作る際の範囲)。 */
const HALF_WIDTH_KATAKANA_START = 0xff61;
const HALF_WIDTH_KATAKANA_END = 0xff9f;

/**
 * 全角カナ(1文字)→半角カナ(1文字)の対応表。
 * ⚠手書きの対応表は書き間違いの元なので、逆方向(半角→全角)は
 *   String.prototype.normalize("NFKC") が正しく変換できることを使って
 *   実行時に自動生成する(半角カナの正規分解は全角カナ)。濁点/半濁点を
 *   別文字として持つ結合(例: "ｶﾞ"=2文字)は1文字変換の対象外
 *   (氏名の先頭1文字だけを広げる用途では十分)。
 */
const FULL_WIDTH_TO_HALF_WIDTH_KATAKANA: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (let code = HALF_WIDTH_KATAKANA_START; code <= HALF_WIDTH_KATAKANA_END; code++) {
    const half = String.fromCharCode(code);
    const full = half.normalize("NFKC");
    if (full.length === 1 && full !== half) {
      map.set(full, half);
    }
  }
  return map;
})();

/** 文字列の先頭1文字（サロゲートペアを割らない）。空文字なら空文字。 */
function firstCodePoint(s: string): string {
  return Array.from(s)[0] ?? "";
}

/** 1文字を半角へ(全角英数記号・全角カナが対象。それ以外はそのまま)。 */
function toHalfWidthChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return FULL_WIDTH_TO_HALF_WIDTH_KATAKANA.get(c) ?? c;
}

/** 1文字を全角へ(半角英数記号・半角カナが対象。それ以外はそのまま)。 */
function toFullWidthChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code >= 0x0021 && code <= 0x007e) return String.fromCharCode(code + 0xfee0);
  if (code >= HALF_WIDTH_KATAKANA_START && code <= HALF_WIDTH_KATAKANA_END) {
    return c.normalize("NFKC");
  }
  return c;
}

/**
 * 所有者検索の DB 前方一致に使う「先頭1文字」の候補集合を作る。
 * 生の氏名の先頭1文字・正規化後の氏名の先頭1文字、それぞれの全角/半角版を
 * 集めて重複を除く(漢字など幅変換の対象外の文字は変換前後で同じ値になり
 * 自然に1つへ畳まれる)。
 */
function ownerSearchPrefixCandidates(rawName: string, normalizedName: string): string[] {
  // ⚠先頭1文字は **コードポイント単位**で取る（全体レビュー m-1）。
  //   slice(0,1) はサロゲートペア（例:「𠮷田」の「𠮷」）を半分に割り、
  //   壊れた片割れで startsWith するため候補が**無言で0件**になる。
  const seeds = [firstCodePoint(rawName), firstCodePoint(normalizedName)].filter((c) => c !== "");
  const variants = new Set<string>();
  for (const c of seeds) {
    variants.add(c);
    variants.add(toHalfWidthChar(c));
    variants.add(toFullWidthChar(c));
  }
  return Array.from(variants);
}

/** 所有者の重複候補として返す1件。氏名/一致の種類のみ(電話・メール・住所そのものは返さない)。 */
interface OwnerCandidate {
  id: string;
  name: string;
  /**
   * 一致の種類。address/currentAddress は意味が違う(登記上/連絡先)ので混ぜない。
   *   current_address = 貼り付けの現住所 == 既存の Owner.currentAddress(連絡先住所が一致)
   *   registry_address = 貼り付けの現住所 == 既存の Owner.address(登記上の住所と一致)
   *   name_only        = 氏名だけ一致(同姓同名の別人かもしれない)
   * 優先順位: current_address > registry_address > name_only(1件が複数に該当するときは強い方)。
   */
  matchKind: "current_address" | "registry_address" | "name_only";
}

/**
 * 重複候補として DB から引く物件1件。
 * ⚠createdBy / assignedTo は canAccessPropertyRecord に渡すためだけに持つ。
 *   **レスポンスには絶対に載せない**。
 */
type CandidateProperty = ExistingProperty & {
  createdBy: string;
  assignedTo: string | null;
};

/**
 * 表示レベルのうち「その項目で**検索してよい**」もの。
 * ⚠この集合は src/app/api/owners/route.ts の SEARCHABLE_LEVELS と同一。
 *   独自のしきい値を作らない(3入口で同じ規則であること)。
 */
const SEARCHABLE_LEVELS = new Set(["edit", "full", "read"]);

// ---------- POST /api/import/paste ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary
//   application/json    → { text }
//
// 貼り付けたテキスト(または PDF から抽出したテキスト)から下書きを組み立て、
// 既存物件との重複を判定して返す。まだ何も保存しない(確認画面はここから先)。

/** 貼り付けの上限。実サンプルは334文字と約900文字なので3桁の余裕がある。 */
const MAX_CHARS = 200_000;
/**
 * PDF の上限。⚠**確定側(/api/import/paste/commit)と同じ定数**を使う
 * (全体レビュー I-2)。ここだけ 10MB にしていたため、9MB の PDF は読み取りに
 * 成功して人が10項目直したあと、登録の瞬間に 8MB 超で弾かれていた。
 * 案内文言も同じ定数から組み立て、数字を二重管理しない。
 */
const MAX_PDF_BYTES = MAX_FILE_SIZE;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // ⚠取込系 route は例外なく import:write を先に要求する（全体レビュー I-1）。
    //   src/app/api/import/** の他の全 route と同じ順序・同じ文言に揃える。
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    // 入口(貼り付け / PDF)で案内文言を変える。人が取った経路の言葉で伝える。
    const isPdfPath = contentType.includes("multipart/form-data");

    if (isPdfPath) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ApiError(400, "PDFファイルが見つかりません", "BAD_REQUEST");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new ApiError(
          400,
          `PDFが大きすぎます（${MAX_PDF_BYTES / 1024 / 1024}MBまで）`,
          "BAD_REQUEST",
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
      }
      text = await extractTextFromPdf(buffer);
      if (isLikelyScannedPdf(text)) {
        // ⚠無言で空の下書きを返さない。スキャン画像の PDF はここに来る。
        // ⚠判定は既存の isLikelyScannedPdf(@/lib/pdf-extract・50文字未満)を使う
        //   (全体レビュー m-2)。`trim() === ""` だと、雑音を数文字だけ吐く
        //   スキャンPDFが「読めた」ことになり、空同然の下書きが出ていた。
        throw new ApiError(
          400,
          "このPDFには文字が入っていません（画像として保存されたPDFの可能性があります）。画面をコピーして貼り付けてください。",
          "BAD_REQUEST",
        );
      }
    } else {
      // request.json() で body 全体をバッファする前に過大サイズを弾く
      // (registry-pdf/route.ts と同じ姿勢。2026-08-02 是正済みの非対称を再発させない)。
      assertImportJsonBodySize(request);
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string") {
        throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
      }
      text = body.text;
    }

    if (text.length > MAX_CHARS) {
      // ⚠通った経路の言葉で伝える（全体レビュー m-6）。PDF を投入した人に
      //   「貼り付けた文章が長すぎます」と言っても心当たりがない。
      throw new ApiError(
        400,
        isPdfPath
          ? `PDFの文字数が多すぎます（${MAX_CHARS.toLocaleString()}文字まで）`
          : `貼り付けた文章が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`,
        "BAD_REQUEST",
      );
    }
    if (text.trim() === "") {
      throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
    }

    const draft = buildPasteDraft(text);

    // 重複の手がかり: 外部キー一致と住所の前方一致は**別クエリ**で引く。
    // ⚠1つの OR に混ぜて take で切ると、同じ建物の多数戸が既に登録されている
    //   ときに住所一致だけで take を埋めてしまい、ブロックすべき唯一の外部キー
    //   一致行が結果から漏れる(=二重登録を防げない)。外部キー一致は完全一致
    //   なので件数は少なく、take で切らない。住所の前方一致だけ take:50 を掛け、
    //   最後に id で重複を除いて合流する。
    // ⚠createdBy / assignedTo は **レコード単位のスコープ判定にだけ**使う
    //   (レスポンスには載せない)。物件一覧・詳細と同じ規則
    //   (src/lib/property-access.ts のヘッダ参照) をこの入口にも適用する
    //   (全体レビュー Critical 2)。これが無いと field_staff に担当外物件の
    //   住所(PII)と id がそのまま返っていた。
    const select = {
      id: true,
      address: true,
      lotNumber: true,
      externalLinkKey: true,
      createdBy: true,
      assignedTo: true,
    } as const;
    const candidateMap = new Map<string, CandidateProperty>();

    if (draft.externalLinkKey) {
      const keyRows = await prisma.property.findMany({
        where: { externalLinkKey: draft.externalLinkKey, isArchived: false },
        select,
      });
      for (const row of keyRows) candidateMap.set(row.id, row);
    }

    if (draft.property.address.value) {
      const addressRows = await prisma.property.findMany({
        where: {
          address: { contains: draft.property.address.value.slice(0, 20) },
          isArchived: false,
        },
        select,
        take: 50,
      });
      for (const row of addressRows) candidateMap.set(row.id, row);
    }

    const candidates: CandidateProperty[] = Array.from(candidateMap.values());

    const duplicates = judgeDuplicates(
      {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
      },
      candidates,
    );

    // ⚠「似た物件」は**この人が開ける物件だけ**に絞る。担当外の住所を
    //   ここから覗けてしまうと、物件一覧・詳細で絞っている意味が無くなる。
    const similar = candidates
      .filter((c) => duplicates.similarPropertyIds.includes(c.id))
      .filter((c) => canAccessPropertyRecord(session, c))
      .map((c) => ({ id: c.id, address: c.address, lotNumber: c.lotNumber }));

    // ⚠止める判断(blocked)は**担当外の物件が相手でも必ず残す**。
    //   「もう登録されている」ことは伝えないと二重登録が起きる。
    //   ただし開けない物件の id は渡さない(押しても403になるリンクを見せない)。
    const blockedBy = duplicates.blockedByPropertyId;
    const blockedByAccessible =
      blockedBy !== null &&
      candidates.some((c) => c.id === blockedBy && canAccessPropertyRecord(session, c));
    const scopedDuplicates = {
      ...duplicates,
      blockedByPropertyId: blockedByAccessible ? blockedBy : null,
      similarPropertyIds: similar.map((sp) => sp.id),
    };

    // ---- 所有者の重複候補(設計書 §6: 氏名+住所が一致すれば候補を並べて選ばせる) ----
    // ⚠draft.owner.currentAddress は「現住所」(貼り付け元はこれしか持たない)。
    //   既存 Owner 側は currentAddress(連絡先住所)と address(登記上住所)の
    //   2つの欄を持ち、意味が別(設計 2026-08-10-owner-current-address-design.md)。
    //   ⚠本番実測(2026-08-26): is_archived=false の所有者1,312件中、
    //   currentAddress が入っているのは0件・address(登記上住所)は1,309件。
    //   現住所どうしだけを比べると本番データでは強い一致が事実上発火しない
    //   (ほぼ全員が登記由来の取込で、現住所欄が空のまま)。よって貼り付けの
    //   現住所は Owner.currentAddress と Owner.address の**両方**に照合し、
    //   どちらに当たったかを区別して返す(意味の違う欄を混ぜて「同じ」と
    //   言わない・「登記上の住所と一致」「連絡先住所が一致」を人が見分けられる
    //   ようにする)。優先順位は current_address(連絡先) > registry_address(登記) >
    //   name_only(氏名のみ)。住所そのものはレスポンスに含めない。
    //
    // ⚠氏名の突き合わせは完全一致(where: { name: ownerName })では引けない。
    //   本番実測(2026-08-26): is_archived=false 1,312件中、氏名に空白が入って
    //   いるのは全角1件・半角3件だけでほぼ全員「空白なし」。一方 貼り付け元
    //   (HOME4U 査定依頼)の実サンプルは「佐藤　花子」のように全角空白入りが
    //   典型。where の完全一致だと候補が0件になり、この機能が本番で機能しない。
    //   → 案B(姓の先頭1文字で前方一致→JS側で normalizeName 一致)を採用。
    //   案A(表記を有限列挙して in で引く)は、貼り付け側に空白が無く DB 側に
    //   ある「逆」のケース(例: 貼り付け「佐藤花子」/DB「佐藤　花子」)で、
    //   どこに空白を挿し込むべきかを機械的に決められず取りこぼす
    //   (姓と名の境界は文字列からは分からない)。案Bは正規化後の完全一致で
    //   判定するため、どちらの向きの表記ゆれも取りこぼさない。
    //   ⚠ただし先頭1文字を正規化後の1文字**だけ**で startsWith すると、
    //   今度は全角/半角の**幅**の違いで取りこぼす(下の
    //   ownerSearchPrefixCandidates のコメント参照・本番実測あり)。
    //   そのため先頭1文字は複数の幅表記を OR で並べて広く取り、
    //   正確な判定は JS 側の normalizeName 完全一致に委ねる(広く取って
    //   正確に絞る、の「広く取る」側だけを変える)。
    //
    // ⚠**ここは所有者検索の入口である**(全体レビュー Critical 2)。このリポジトリは
    //   所有者検索を3入口(owners / owners/search / properties/suggest)に限り、
    //   3つとも同じ規則に揃えている(src/app/api/owners/route.ts のコメント)。
    //   この route も同じ規則に従う:
    //     ① owner:read が無ければ**DBを引かない**(空で返す)
    //     ② 表示レベルがマスクされている項目では**検索しない**
    //        (ヒットの有無から見えないはずの値を当てられる=検索オラクル)。
    //        氏名で前方一致し、住所で一致の種類を出し分ける経路なので、
    //        **氏名と住所の両方**が検索可能なときだけ引く。
    //     ③ 返す氏名は maskValue を通す(owners と同じ通し方)。
    //   ⚠既定の field_staff テンプレート(prisma/seed.ts)は owner_address: partial
    //     のため②で止まる。以前はこの人に「山田太郎 / 登記上の住所と一致」を
    //     返しており、**市までしか見せていない住所の一致を確定させていた**。
    const ownerNameRaw = draft.owner?.name.value?.trim() ?? "";
    const normalizedOwnerName = normalizeName(ownerNameRaw);
    let ownerCandidates: OwnerCandidate[] = [];

    const canReadOwner = hasPermission(perms, "owner", "read");
    const ownerDisplayConfig = canReadOwner
      ? await getOwnerDisplayConfig(session.id, perms)
      : null;
    const ownerSearchAllowed =
      ownerDisplayConfig !== null &&
      SEARCHABLE_LEVELS.has(ownerDisplayConfig.name) &&
      SEARCHABLE_LEVELS.has(ownerDisplayConfig.address);

    if (ownerSearchAllowed && normalizedOwnerName !== "") {
      const prefixCandidates = ownerSearchPrefixCandidates(ownerNameRaw, normalizedOwnerName);
      const ownerRows = await prisma.owner.findMany({
        where: {
          OR: prefixCandidates.map((prefix) => ({ name: { startsWith: prefix } })),
          isArchived: false,
        },
        select: { id: true, name: true, currentAddress: true, address: true },
        take: OWNER_CANDIDATE_FETCH_LIMIT,
      });
      const matchedRows = ownerRows.filter(
        (row) => normalizeName(row.name) === normalizedOwnerName,
      );

      const draftAddress = draft.owner?.currentAddress.value?.trim() ?? "";
      const draftKey = draftAddress
        ? buildOwnerDedupKey(normalizedOwnerName, draftAddress)
        : null;

      const nameLevel = ownerDisplayConfig.name;
      ownerCandidates = matchedRows.map((row) => {
        let matchKind: OwnerCandidate["matchKind"] = "name_only";
        if (draftKey !== null) {
          const currentAddr = row.currentAddress?.trim() ?? "";
          const registryAddr = row.address?.trim() ?? "";
          const currentHit =
            currentAddr !== "" && buildOwnerDedupKey(row.name, currentAddr) === draftKey;
          const registryHit =
            registryAddr !== "" && buildOwnerDedupKey(row.name, registryAddr) === draftKey;
          if (currentHit) {
            matchKind = "current_address";
          } else if (registryHit) {
            matchKind = "registry_address";
          }
        }
        // ⚠氏名は owners と同じく maskValue を通してから返す。
        //   (上の②で searchable なレベルに限っているため現状は素通しだが、
        //    レベルの集合が将来広がったときに素の値が漏れる口を残さない。)
        return { id: row.id, name: maskValue(row.name, nameLevel), matchKind };
      })
      // 名前を出せない候補は「どれのことか」を人が選べないので返さない。
      .filter((c): c is OwnerCandidate => c.name !== null);
    }

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。所有者候補も電話・メール・住所そのものは
    //   返さず、id/氏名/一致の種類だけに絞る。デバッグ用フィールドも一切足さない。
    return apiResponse({
      draft,
      duplicates: scopedDuplicates,
      similar,
      ownerCandidates,
      // ⚠PDF を投入したときだけ、抽出した本文を返す(全体レビュー I-5)。
      //   PDF の人は原文を手元に持っていないため、返さないと確認画面の左側に
      //   突き合わせる材料が何も無い(以前は「（PDF: ファイル名）」だけだった)。
      //   貼り付け経路では画面が原文を持っているので**返さない**(往復させると
      //   ログ・履歴に PII を増やすだけ)。
      extractedText: isPdfPath ? text : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
