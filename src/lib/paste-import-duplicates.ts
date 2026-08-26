/**
 * 「貼り付けて物件化」の**重複の見立て**（物件・所有者）を1か所にまとめたもの。
 *
 * ⚠下書きAPI (`POST /api/import/paste`) と、確認画面で人が直したあとの
 *   見直しAPI (`POST /api/import/paste/recheck`) の**両方がここを呼ぶ**。
 *   判定ロジックを二重に書かない（片方だけ直る食い違いを作らない）。
 *
 * ⚠**権限・表示レベル・レコードスコープの扱いもここに閉じ込める**。
 *   ここが呼び出し側ごとに緩むと、塞いだはずの検索オラクルが別の口から開く
 *   （全体レビュー Critical 2 の再発）。呼び出し側は session と perms を渡すだけ。
 *
 * ⚠純関数ではない（Prisma を触る）。だから `src/lib/paste-import/` には置かない
 *   （あちらは「DB・ネットワーク・ファイルに触らない」ことを約束したディレクトリ）。
 */
import { getOwnerDisplayConfig, type PermissionEntry } from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { prisma } from "@/lib/prisma";
import {
  judgeDuplicates,
  type DuplicateVerdict,
  type ExistingProperty,
} from "@/lib/paste-import/find-duplicates";
import { buildOwnerDedupKey } from "@/lib/owner-dedup";
import { addressSearchPrefix, toFullWidth } from "@/lib/paste-import/normalize";
import { normalizeName } from "@/lib/normalize";

/**
 * 所有者候補の DB 検索で広めに取る件数。
 * ⚠本番実測(2026-08-26): 姓の先頭1文字で前方一致すると、多い姓(例:佐藤)は
 *   何十件も返りうる。正規化一致で最終的に絞り込む前提で厚めに取る。
 *   この値を変えたら test の固定値テストも直すこと。
 */
const OWNER_CANDIDATE_FETCH_LIMIT = 200;

/**
 * 住所の重複候補を DB から取る件数。
 * ⚠本番実測(2026-08-26): properties の is_archived=false は669件。町名までの
 *   前方一致は選択性が高いが、「東京都」までしか CJK が続かない書式では広く当たる。
 *   最終的な同一判定は judgeDuplicates(normalizeForCompare の完全一致)が行うので、
 *   ここは広めに取る。⚠ここで切られた行は「似ています」警告に出ない
 *   (登録は止めない警告なので影響は警告の取りこぼしに限られる。**登録を止める
 *   外部キー一致は別クエリで take を掛けていない**)。
 */
const ADDRESS_CANDIDATE_FETCH_LIMIT = 300;

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
/**
 * 法人名の接頭辞（正規化後の表記）。
 * ⚠**本番実測(2026-08-26): 「株式会社」で始まる所有者は1,312件中33件**。
 *   いまは take:200 に余裕があるが、法人が増えれば「株」に集中するのは構造的で、
 *   上限を超えた瞬間に**実在する完全一致が候補から漏れ、重複作成へ誘導**される。
 *   → 接頭辞を落とした**実質部分**の先頭文字も種にする
 *   (「株式会社田中工務店」なら「田」)。
 * ⚠normalizeName は NFKC + 空白除去なので、㈱ は "(株)" になっている。
 */
const CORPORATE_NAME_PREFIXES: readonly string[] = [
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "医療法人",
  "宗教法人",
  "(株)",
  "(有)",
];

/**
 * 法人接頭辞を落とした「実質部分」。落とした結果が空なら**元の名前を返す**
 * （「株式会社」だけ、のような異常値で空の絞り込みを作らない）。
 */
export function stripCorporatePrefix(normalizedName: string): string {
  let rest = normalizedName;
  // 「株式会社(株)…」のような二重表記も落とす。
  for (let i = 0; i < 3; i++) {
    const hit = CORPORATE_NAME_PREFIXES.find((prefix) => rest.startsWith(prefix));
    if (!hit) break;
    rest = rest.slice(hit.length);
  }
  return rest === "" ? normalizedName : rest;
}

function ownerSearchPrefixCandidates(rawName: string, normalizedName: string): string[] {
  // ⚠先頭1文字は **コードポイント単位**で取る（全体レビュー m-1）。
  //   slice(0,1) はサロゲートペア（例:「𠮷田」の「𠮷」）を半分に割り、
  //   壊れた片割れで startsWith するため候補が**無言で0件**になる。
  // ⚠法人接頭辞を落とした実質部分の先頭文字も種に加える(@codex PR#414 21巡目 ②)。
  //   「株」に集中して take 上限を食い潰すのを避ける。
  const seeds = [
    firstCodePoint(rawName),
    firstCodePoint(normalizedName),
    firstCodePoint(stripCorporatePrefix(normalizedName)),
  ].filter((c) => c !== "");
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
  /**
   * 表示レベルを通した住所（連絡先住所があればそれ、無ければ登記上住所）。
   *
   * ⚠**同姓同名を見分けるために要る**(@codex PR#414 8巡目 ②)。氏名と一致種別しか
   *   返していなかったため、同じ氏名・同じ種別の候補が複数あると選択肢が
   *   **すべて同じ文字**に見え、どれを選んでいるか分からないまま選ぶことになった。
   *   別人に紐付ければ**他人にDMが届く**。
   * ⚠必ず `maskValue` を通す(生の住所を返さない)。これは repo の既存の所有者API
   *   (/api/owners) が返しているのと**同じ扱い**で、「線に載せない」原則の本体
   *   =「利用者が見てよい範囲に限る」は保たれる。
   */
  address: string | null;
  /**
   * 上の `address` が**どちらの欄のものか**。
   * ⚠`matchKind` と**必ず対応させる**(@codex PR#414 11巡目 ③)。
   *   「登記上の住所と一致」の札の隣に連絡先住所を並べると、利用者は
   *   「この住所が一致したのか」と読み、**別人に紐付ける誘導**になる。
   *   name_only のときはどちらを出しているかをこの値で示す。
   */
  addressKind: "current" | "registry" | null;
  /**
   * その所有者に紐づく物件の件数。**個人情報ではない識別の手がかり**。
   * ⚠住所が伏せられる表示レベルの利用者でも選択肢を区別できるように、
   *   住所とは別に必ず添える。
   */
  propertyCount: number;
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

/** 見立ての入力。下書きの値でも、人が直したあとの値でも同じ形で渡す。 */
export interface PasteDuplicateLookupInput {
  address: string | null;
  lotNumber: string | null;
  externalLinkKey: string | null;
  ownerName: string | null;
  /** 貼り付け元が持つのは「現住所」だけ（登記上住所ではない）。 */
  ownerCurrentAddress: string | null;
}

export interface PasteDuplicateLookupResult {
  duplicates: DuplicateVerdict;
  similar: { id: string; address: string | null; lotNumber: string | null }[];
  ownerCandidates: OwnerCandidate[];
  /**
   * 所有者候補が**取得上限に達して確認しきれなかった**。
   * ⚠true のときは `ownerCandidates` を空で返す。「候補なし」と区別できるよう、
   *   画面はこのフラグを見て**確認できなかった旨**を出す(21巡目 ②)。
   */
  ownerCandidatesTruncated: boolean;
}

export async function lookupPasteDuplicates(
  session: { id: string; role: string },
  perms: PermissionEntry[],
  input: PasteDuplicateLookupInput,
): Promise<PasteDuplicateLookupResult> {
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

  // ⚠**物件を読む権限**を要求する(@codex PR#414 7巡目 ①)。所有者側で owner:read を
  //   足したのに、物件側で同じことをしていなかった(同種の穴を全箇所洗う原則の
  //   取りこぼし)。canAccessPropertyRecord は**行単位のスコープ**であって
  //   **権限ゲートの代わりにはならない**(別の役割)。これが無いと、管理者が個別に
  //   property:read を落とした利用者が、通常のAPI(properties / properties/[id])では
  //   拒否される物件データ(id・住所・地番)をこの口から探れる。
  const canReadProperty = hasPermission(perms, "property", "read");

  // ⚠**住所での検索は property:read が無ければ一切行わない**。ここが
  //   「住所を入れて既存の物件を探す」口そのものだから。
  // ⚠一方、外部キーの**完全一致の存在確認だけ**は権限に関わらず行う。理由:
  //   同じ指示の後半「blocked の真偽は残す」を満たすには、登録済みかどうかを
  //   知る必要がある。これは利用者が自分で入力した番号について「もう登録されて
  //   いるか」の真偽が返るだけで、住所や id は返さない(下で similar=[] /
  //   blockedByPropertyId=null に落とす)。伝えないと二重登録が起きるため、
  //   担当外の物件でも blocked を残すのと同じ考え方。
  if (input.externalLinkKey) {
    // ⚠**全角形も見る**(@codex PR#414 2巡目 P2)。CSV取込
    //   (src/app/api/import/csv/route.ts) は externalLinkKey を生値のまま保存する
    //   ため、全角で入った既存行は正規化後(半角)の完全一致では見つからない。
    //   下書きの externalLinkKey は build-draft.ts で正規化済み(半角)。
    const keyVariants = Array.from(
      new Set([input.externalLinkKey, toFullWidth(input.externalLinkKey)]),
    );
    const keyRows = await prisma.property.findMany({
      where: { externalLinkKey: { in: keyVariants }, isArchived: false },
      select,
    });
    for (const row of keyRows) candidateMap.set(row.id, row);
  }

  // ⚠住所は**生の値で contains してはいけない**(@codex PR#414 P2)。
  //   本番実測(2026-08-26・is_archived=false 669件): 全角英数を含む物件が
  //   665件(99.4%)・全角ハイフン類が659件。一方 貼り付け元(Webフォーム)の住所は
  //   半角。生値の contains では**ほぼ1件も候補にならず**、住所による重複警告が
  //   実質的に機能していなかった(査定ナンバーが無い「空き家相談」の書式では
  //   住所が唯一の手がかり = その経路の二重登録が無警告で通っていた)。
  //   → 氏名で採ったのと同じ形にする: 幅の別が存在しない**先頭のCJK部分**で
  //   広めに前方一致し、正確な判定は judgeDuplicates(normalizeForCompare の
  //   完全一致)に委ねる。
  if (canReadProperty && input.address) {
    const addressValue = input.address;
    const prefix = addressSearchPrefix(addressValue);
    const addressRows = await prisma.property.findMany({
      where: {
        // ⚠**貼られた生の値ではなく、幅の別が無いCJK部分**で引く。
        //   ⚠startsWith ではなく contains にしている(@codex PR#414 5巡目 ②)。
        //   DB 側の住所が `〒123-4567 東京都…` のように郵便番号で**始まっている**と、
        //   前方一致では当たらない(郵便番号はこちらの文字列からは落とせても、
        //   DB の列からは SQL 関数なしに落とせない)。本番は669件と小さく、
        //   最終判定は judgeDuplicates の正規化一致が行うので contains で広く取る。
        //   先頭がCJKでない書式(実データでは想定外)だけ、生の先頭20文字へ落とす保険。
        address: prefix === null ? { contains: addressValue.slice(0, 20) } : { contains: prefix },
        isArchived: false,
      },
      select,
      take: ADDRESS_CANDIDATE_FETCH_LIMIT,
    });
    for (const row of addressRows) candidateMap.set(row.id, row);
  }

  const candidates: CandidateProperty[] = Array.from(candidateMap.values());

  const duplicates = judgeDuplicates(
    {
      address: input.address,
      lotNumber: input.lotNumber,
      externalLinkKey: input.externalLinkKey,
    },
    candidates,
  );

  // ⚠「似た物件」は**この人が開ける物件だけ**に絞る。担当外の住所を
  //   ここから覗けてしまうと、物件一覧・詳細で絞っている意味が無くなる。
  const similar = !canReadProperty
    ? []
    : candidates
        .filter((c) => duplicates.similarPropertyIds.includes(c.id))
        .filter((c) => canAccessPropertyRecord(session, c))
        .map((c) => ({ id: c.id, address: c.address, lotNumber: c.lotNumber }));

  // ⚠止める判断(blocked)は**担当外の物件が相手でも必ず残す**。
  //   「もう登録されている」ことは伝えないと二重登録が起きる。
  //   ただし開けない物件の id は渡さない(押しても403になるリンクを見せない)。
  const blockedBy = duplicates.blockedByPropertyId;
  const blockedByAccessible =
    canReadProperty &&
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
  const ownerNameRaw = input.ownerName?.trim() ?? "";
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
        // ⚠**startsWith ではなく contains**(21巡目 ②)。法人接頭辞を落とした
        //   実質部分は名前の**途中**に来る(「株式会社田中工務店」の「田」)。
        //   広く取って、正確な判定は下の normalizeName 完全一致に委ねる構造は不変。
        OR: prefixCandidates.map((seed) => ({ name: { contains: seed } })),
        isArchived: false,
      },
      select: {
        id: true,
        name: true,
        currentAddress: true,
        address: true,
        // 所有物件の件数(非個人情報の識別子)。氏名も住所も同じ候補を見分けるため。
        _count: { select: { propertyOwners: true } },
      },
      take: OWNER_CANDIDATE_FETCH_LIMIT,
    });
    // ⚠**上限到達を無言にしない**(@codex PR#414 21巡目 ②)。取り切れていないのに
    //   「候補なし」と同じ顔をするのが一番危険。候補の代わりに警告のフラグを返す。
    if (ownerRows.length >= OWNER_CANDIDATE_FETCH_LIMIT) {
      return {
        duplicates: scopedDuplicates,
        similar,
        ownerCandidates: [],
        ownerCandidatesTruncated: true,
      };
    }

    const matchedRows = ownerRows.filter(
      (row) => normalizeName(row.name) === normalizedOwnerName,
    );

    const draftAddress = input.ownerCurrentAddress?.trim() ?? "";
    const draftKey = draftAddress
      ? buildOwnerDedupKey(normalizedOwnerName, draftAddress)
      : null;

    const nameLevel = ownerDisplayConfig.name;
    const addressLevel = ownerDisplayConfig.address;
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
      // ⚠**実際に一致した方の住所**を出す(@codex PR#414 11巡目 ③)。
      //   両方の住所を持つ所有者で登記上住所が一致したのに連絡先住所を並べると、
      //   「登記上の住所と一致」の札の隣に**一致していない住所**が並び、
      //   利用者は「この住所が一致したのか」と読む＝別人への紐付けを誘導する。
      //   name_only(どちらも一致していない)ときだけ、連絡先→登記上の順で参考として
      //   出し、**どちらを出したか**を addressKind で示す。
      const currentAddr = row.currentAddress?.trim() || null;
      const registryAddr = row.address?.trim() || null;
      let shownAddressRaw: string | null;
      let addressKind: OwnerCandidate["addressKind"];
      if (matchKind === "current_address") {
        shownAddressRaw = currentAddr;
        addressKind = currentAddr === null ? null : "current";
      } else if (matchKind === "registry_address") {
        shownAddressRaw = registryAddr;
        addressKind = registryAddr === null ? null : "registry";
      } else if (currentAddr !== null) {
        shownAddressRaw = currentAddr;
        addressKind = "current";
      } else {
        shownAddressRaw = registryAddr;
        addressKind = registryAddr === null ? null : "registry";
      }
      const shownAddress = maskValue(shownAddressRaw, addressLevel);
      return {
        id: row.id,
        name: maskValue(row.name, nameLevel),
        matchKind,
        address: shownAddress,
        // マスクで消えたときは種別も出さない(空の札を残さない)。
        addressKind: shownAddress === null ? null : addressKind,
        propertyCount: row._count?.propertyOwners ?? 0,
      };
    })
    // 名前を出せない候補は「どれのことか」を人が選べないので返さない。
    .filter((c): c is OwnerCandidate => c.name !== null);
  }

  return {
    duplicates: scopedDuplicates,
    similar,
    ownerCandidates,
    ownerCandidatesTruncated: false,
  };
}
