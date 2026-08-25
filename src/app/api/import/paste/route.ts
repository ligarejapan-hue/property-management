import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { judgeDuplicates, type ExistingProperty } from "@/lib/paste-import/find-duplicates";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
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
  const seeds = [rawName.slice(0, 1), normalizedName.slice(0, 1)].filter((c) => c !== "");
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

// ---------- POST /api/import/paste ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary
//   application/json    → { text }
//
// 貼り付けたテキスト(または PDF から抽出したテキスト)から下書きを組み立て、
// 既存物件との重複を判定して返す。まだ何も保存しない(確認画面はここから先)。

/** 貼り付けの上限。実サンプルは334文字と約900文字なので3桁の余裕がある。 */
const MAX_CHARS = 200_000;
/** PDF の上限（10MB）。 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ApiError(400, "PDFファイルが見つかりません", "BAD_REQUEST");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new ApiError(400, "PDFが大きすぎます（10MBまで）", "BAD_REQUEST");
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
      }
      text = await extractTextFromPdf(buffer);
      if (text.trim() === "") {
        // ⚠無言で空の下書きを返さない。スキャン画像の PDF はここに来る。
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
      throw new ApiError(
        400,
        `貼り付けた文章が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`,
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
    const select = { id: true, address: true, lotNumber: true, externalLinkKey: true } as const;
    const candidateMap = new Map<string, ExistingProperty>();

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

    const candidates: ExistingProperty[] = Array.from(candidateMap.values());

    const duplicates = judgeDuplicates(
      {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
      },
      candidates,
    );

    const similar = candidates
      .filter((c) => duplicates.similarPropertyIds.includes(c.id))
      .map((c) => ({ id: c.id, address: c.address, lotNumber: c.lotNumber }));

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
    const ownerNameRaw = draft.owner?.name.value?.trim() ?? "";
    const normalizedOwnerName = normalizeName(ownerNameRaw);
    let ownerCandidates: OwnerCandidate[] = [];
    if (normalizedOwnerName !== "") {
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
        return { id: row.id, name: row.name, matchKind };
      });
    }

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。所有者候補も電話・メール・住所そのものは
    //   返さず、id/氏名/一致の種類だけに絞る。デバッグ用フィールドも一切足さない。
    return apiResponse({
      draft,
      duplicates,
      similar,
      ownerCandidates,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
