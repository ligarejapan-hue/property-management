// 国税庁 lookup 結果(法人名/所在地)と既存 Owner(名/住所)の「明らかな不一致」を判定する純関数。
//
// 方針(誤検知=正当な反映を妨げるのを避ける):
//  - 法人名を主信号とする。住所は表記揺れ・移転で大きく変わるため、住所単独では conflict にしない。
//  - 法人名が明らかに不一致 → "conflict"。一致(法人種別語・全半角・記号差を吸収) → "match"。
//  - 法人名が判定不能(どちらか空 / field 不可視で null)のときのみ住所で補助:
//      住所が一致 → "match"、それ以外 → "unknown"。
//  - 入力の生値(名称/住所)は返さない。返すのは 3 値の分類フラグのみ(ログ/audit も同様)。

export type CorporateLookupConflict = "match" | "conflict" | "unknown";

/** 法人種別語(比較時に除去して名寄せする)。NFKC 後の表記で持つ。 */
const COMPANY_NAME_NOISE = [
  "株式会社",
  "有限会社",
  "合同会社",
  "合名会社",
  "合資会社",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "特定非営利活動法人",
  "医療法人",
  "社会福祉法人",
  "学校法人",
  "宗教法人",
  "(株)",
  "(有)",
  "(資)",
  "(名)",
];

/** 比較用に法人名を正規化する。NFKC→法人種別語除去→空白/記号除去→小文字化。 */
function normalizeCompanyNameForCompare(s: string): string {
  let r = s.normalize("NFKC");
  for (const noise of COMPANY_NAME_NOISE) {
    if (r.includes(noise)) r = r.split(noise).join("");
  }
  // 空白・中黒・各種括弧/区切り・ハイフン類を除去
  r = r.replace(
    /[\s　・,，、.。･()（）「」『』【】\-‐‑‒–—―ー－−]/g,
    "",
  );
  return r.toLowerCase();
}

/** 比較用に住所を正規化する。NFKC→空白除去→丁目/番地/番/号→ハイフン化→小文字化。 */
function normalizeAddressForCompare(s: string): string {
  let r = s.normalize("NFKC");
  r = r.replace(/[\s　]/g, "");
  r = r.replace(/丁目|番地|番|号/g, "-");
  r = r.replace(/[‐‑‒–—―ー－−]/g, "-");
  r = r.replace(/-+/g, "-");
  return r.toLowerCase();
}

function nameSignal(
  ownerName: string | null | undefined,
  recordName: string | null | undefined,
): "match" | "mismatch" | "unknown" {
  if (!ownerName || !recordName) return "unknown";
  const a = normalizeCompanyNameForCompare(ownerName);
  const b = normalizeCompanyNameForCompare(recordName);
  if (a === "" || b === "") return "unknown";
  if (a === b || a.includes(b) || b.includes(a)) return "match";
  return "mismatch";
}

const ADDRESS_PREFIX_MATCH_LEN = 6;

function addressSignal(
  ownerAddr: string | null | undefined,
  recordAddr: string | null | undefined,
): "match" | "mismatch" | "unknown" {
  if (!ownerAddr || !recordAddr) return "unknown";
  const a = normalizeAddressForCompare(ownerAddr);
  const b = normalizeAddressForCompare(recordAddr);
  if (a === "" || b === "") return "unknown";
  if (a === b || a.startsWith(b) || b.startsWith(a)) return "match";
  const minLen = Math.min(a.length, b.length);
  if (
    minLen >= ADDRESS_PREFIX_MATCH_LEN &&
    a.slice(0, ADDRESS_PREFIX_MATCH_LEN) === b.slice(0, ADDRESS_PREFIX_MATCH_LEN)
  ) {
    return "match";
  }
  return "mismatch";
}

/**
 * 国税庁 lookup 結果と既存 Owner の不一致を判定する。
 *  - 法人名が明らかに不一致 → "conflict"
 *  - 法人名一致 → "match"
 *  - 法人名判定不能だが住所一致 → "match"
 *  - それ以外(情報不足) → "unknown"
 *
 * field 不可視等で値を渡せない場合は null を渡す(その信号は unknown 扱い)。
 * 住所単独の不一致では conflict にしない(移転・表記揺れによる誤検知を避ける)。
 */
export function assessCorporateLookupConflict(
  owner: { name: string | null; address: string | null },
  record: { name: string | null; address: string | null },
): CorporateLookupConflict {
  const ns = nameSignal(owner.name, record.name);
  if (ns === "mismatch") return "conflict";
  if (ns === "match") return "match";
  // 法人名が判定不能 → 住所で補助(match のみ採用・mismatch では conflict にしない)
  if (addressSignal(owner.address, record.address) === "match") return "match";
  return "unknown";
}
