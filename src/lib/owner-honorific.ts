/**
 * owner-honorific.ts (DQ-05)
 *
 * DM 宛名の敬称を「エンティティ種別」から決める純関数群（I/O なし・ユニットテスト可）。
 * 既存 owner-name-quality.ts / corporate-number-cleanup.ts と同じスタイル（純関数・
 * NFKC 正規化・保守的・戻り値はコード/敬称文字列のみで氏名生値を返さない）。
 *
 * 背景（22B-dq-02-04-05-design.md DQ-05 節）:
 * - 既存 `honorific(corporateNumber)`（dm-export.ts:54 / property-dm-export.ts:53）は
 *   **法人番号の有無だけ** で敬称を決める（非空 -> 御中 / 空 -> 様）。
 * - そのため法人番号を持たない組織（管理組合・自治会・町内会・○○管理会社・
 *   財団/社団の任意団体・「○○会」等）に「様」が付き、DM 宛名が
 *   「○○管理組合 様」のように不適切になる。逆に個人名は「様」で正しい。
 * - 本ライブラリは法人番号シグナルに **名称ベースの組織判定** を加える。
 *
 * 配線方針（本ライブラリは検出のみ・dm-export への配線は後続タスク）:
 * - 敬称は DM 出力時に算出される派生値で DB 保存されない（保存データ無変更・低リスク）。
 * - owner.name 自体は変更しない（名前に敬称を埋め込まない）。
 *
 * 誤検出回避の核心（design §4）:
 * - **語尾一致を基本**にする（「…管理組合」で終わる）。中間一致は「○○管理組合ビル」等の
 *   建物名で誤検出するため採用しない（owner.name に限定＋語尾優先）。
 * - 「会」「組合」などの **裸の単独サフィックスは採用しない**（「田中会計」「組合せ」等の誤爆）。
 *   最小長・既知の閉じた語彙のみ。
 * - 法人格を明示する強い語（株式会社・各種法人・㈱ 等）は前株/後株の双方があるため
 *   **語中含有** で検出する（これらは個人名にまず現れない閉じた語彙）。
 * - 後方互換: 法人番号がある owner は従来どおり「御中」（判定順 1）。改修で挙動が変わるのは
 *   「法人番号なし＋組織名」だけ＝影響範囲が限定的。
 */

/** 敬称算出のためのエンティティ種別。corp/org は御中、person は様。 */
export type HonorificKind = "corp" | "org" | "person";

/** 個人向け敬称。 */
export const HONORIFIC_RESPECT = "様";
/** 法人 / 組織向け敬称。 */
export const HONORIFIC_ORG = "御中";

/**
 * 法人格を明示する強いマーカ語。これらは個人名にほぼ現れない閉じた語彙のため、
 * 前株/後株の双方に対応するよう **語中含有** で判定する（例: 「株式会社○○」「○○株式会社」）。
 * NFKC 正規化後に判定するため、（株）/ (株) は「株式会社」相当の㈱・株とは別に
 * 明示パターンとして併記する（NFKC で ㈱ -> (株)、全角括弧 -> 半角括弧へ畳まれる）。
 *
 * 注: owner-name-quality.ts の CORP_WORD_RE と語彙を揃えつつ、DQ-05 用に
 * 連合会・商店会・管理会社・各種「会」型団体を design の ORG_NAME_SUFFIXES に従い拡張する。
 * （本ライブラリは独立した純関数で、当該定数を import しない＝共有ファイル無改変。）
 */
const CORP_MARKER_RE =
  /(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|㈱|㈲|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|宗教法人|医療法人|学校法人|特定非営利活動法人|独立行政法人|国立大学法人|地方独立行政法人)/u;

/**
 * 組織種別を示す **語尾サフィックス**（語尾一致のみで判定）。
 * 建物名等の中間一致（「○○管理組合ビル」）を避けるため、`name` の末尾一致だけ採用する。
 * design の ORG_NAME_SUFFIXES に対応。「会」「組合」単独は誤爆源のため含めない。
 */
const ORG_NAME_SUFFIXES: readonly string[] = [
  // 管理組合・地縁団体
  "管理組合法人",
  "管理組合",
  "管理会社",
  "自治会",
  "町内会",
  "町会",
  "区会",
  // 法人格（語尾型・CORP_MARKER と重複してもよい＝堅牢性のため）
  "管理組合連合会",
  "協同組合連合会",
  "事業協同組合",
  "協同組合",
  "生活協同組合",
  "連合会",
  "商店会",
  "商店街振興組合",
] as const;

/**
 * 名称の正規化（比較専用・保存値は変えない）。
 *  - NFKC（全角英数・㈱・全角括弧などを畳む）
 *  - 連続する空白（半角/全角/タブ/改行）を除去
 *  - 前後 trim
 * owner-name-quality.ts と同じく raw を破壊せず比較用の値のみ生成する。
 */
function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\s　]+/gu, "")
    .trim();
}

/**
 * 名称が組織名サフィックスのいずれかで終わるか（語尾一致）。
 * 正規化後の文字列に対して判定する。空文字は false。
 */
function endsWithOrgSuffix(normalized: string): boolean {
  if (normalized.length === 0) return false;
  return ORG_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * 法人番号シグナルが立っているか（非空文字列か）。
 * 既存 honorific(corporateNumber) の「typeof string かつ length>0」と整合させつつ、
 * 空白のみの法人番号は無効として扱う（trim 後に空なら false）。
 */
function hasCorporateNumberSignal(
  corporateNumber: string | null | undefined,
): boolean {
  return typeof corporateNumber === "string" && corporateNumber.trim().length > 0;
}

/**
 * エンティティ種別を判定する（design §2 の判定順）。
 *  1. 法人番号が非空 -> "corp"（名称に関係なく・後方互換）
 *  2. 名称が法人格マーカ語を含む、または組織名サフィックスで終わる -> "org"
 *  3. それ以外 -> "person"
 *
 * 保守的: 名称が空/null/空白のみ、または個人名は "person"（誤って組織に倒さない）。
 *
 * @param name 所有者名（生値）。null/undefined/空可。
 * @param corporateNumber 法人番号など法人シグナル（13桁/12桁いずれも非空なら corp）。
 */
export function classifyHonorificKind(
  name: string | null | undefined,
  corporateNumber: string | null | undefined,
): HonorificKind {
  // 判定順 1: 法人番号シグナル（最優先・後方互換）
  if (hasCorporateNumberSignal(corporateNumber)) return "corp";

  // 判定順 2: 名称ベースの組織判定
  if (typeof name === "string") {
    const normalized = normalizeName(name);
    if (normalized.length > 0) {
      if (CORP_MARKER_RE.test(normalized) || endsWithOrgSuffix(normalized)) {
        return "org";
      }
    }
  }

  // 判定順 3: それ以外（個人・不明）は person
  return "person";
}

/**
 * 種別 -> 敬称文字列。corp / org -> 御中、person -> 様。
 */
export function honorificFor(kind: HonorificKind): string {
  return kind === "person" ? HONORIFIC_RESPECT : HONORIFIC_ORG;
}

/**
 * 所有者名（＋任意で法人番号の有無）から敬称を直接返す上位互換 API。
 * 既存 honorific(corporateNumber) のドロップイン上位互換:
 *  - hasCorporateNumber=true -> 御中（従来どおり）。
 *  - それ以外は名称ベースで判定（管理組合・自治会・法人格名 -> 御中 / 個人名 -> 様）。
 *
 * 配線時は dm-export 側の `corporateNumber` の有無を hasCorporateNumber に渡し、
 * 併せて name を渡すだけで「法人番号なしの組織名 -> 御中」を救える。
 *
 * @param name 所有者名（生値）。null/undefined/空は person 扱い（様）。
 * @param hasCorporateNumber 法人番号シグナルの有無（省略時 false = 名称ベース判定）。
 */
export function honorificForOwner(
  name: string | null | undefined,
  hasCorporateNumber = false,
): string {
  // 既存 honorific と整合: 法人番号があれば名称に関係なく御中。
  const kind = classifyHonorificKind(
    name,
    hasCorporateNumber ? "1" : null,
  );
  return honorificFor(kind);
}
