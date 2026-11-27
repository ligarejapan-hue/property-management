/**
 * やりかた(howto-entries.ts)→ 取り扱いマニュアル(public/docs/manual.html)の節の印。
 * 「困ったらここ」の答えの下に「マニュアルで見る」を出し、その節を別のタブで開く(2026-11-27 発注者)。
 * ⚠印はマニュアルの id="…" と同じにする(テストで、全件の印がマニュアルにあることを確かめる)。
 *   マニュアルの見出しを直すときは印(id)を変えない。
 */
export const MANUAL_PATH = "/docs/manual.html";

export const HOWTO_MANUAL_SECTION: Record<string, string> = {
  // 物件(s2)
  "property-search": "s2",
  "property-register": "s2",
  "property-edit": "s2",
  "registry-fetch": "s2",
  "registry-reflect": "s2",
  "property-attach": "s2",
  investigation: "s2",
  "key-box-register": "key-box",
  "key-box-view": "key-box",
  // 反響の受付
  "inquiry-desk": "inquiry-desk",
  "material-send": "material-send",
  // 所有者(s3)
  "owner-edit": "s3",
  "registry-owner-review": "s3",
  "owner-duplicate": "s3",
  // 写真(s4)・販売図面(s5)・現地調査(s6)・CSV(s7)・取り込み(s8)・DM(s9)
  "property-photos": "s4",
  "sales-sheet": "s5",
  "field-survey": "s6",
  "field-survey-candidates": "s6",
  "csv-export": "s7",
  "report-inbox": "s8",
  "import-drop": "s8",
  "import-paste": "s8",
  "dm-address-csv": "s9",
  "sale-dm": "s9",
  "dm-reaction": "s9",
  "sale-dm-inquiries": "s9",
  "mail-settings": "s10",
  // 取引
  "deal-create": "deals",
  "deal-dates": "deals",
  "deal-parties": "deals",
  "deal-money": "deals",
  "deal-assessed-value": "deals",
  "deal-tax-settlement": "deals",
  "deal-payments": "deals",
  "deal-oc": "deals",
  "deal-mailbox": "deal-keys",
  "deal-keys": "deal-keys",
  "doc-key-receipt": "deal-keys",
  "doc-receipts": "deals",
  "doc-settlement-statement": "deals",
  "doc-settlement-guide": "deals",
  "doc-completion": "deals",
  "doc-mediation": "deals",
  "doc-contract-guide": "deals",
  "doc-power-of-attorney": "deals",
  "doc-checklist": "deals",
  "doc-oc": "deals",
  "doc-seller-survey": "deals",
  "doc-funding-plan": "deals",
  "doc-business-plan": "deals",
  "deal-doc-history": "deals",
  "deal-customer-upload": "deals",
  "deal-timeline": "deals",
  "deal-settings": "deals",
  // 管理者(s10)・困ったとき(s12)
  "user-add": "s10",
  "permission-template": "s10",
  "audit-log": "s10",
  "company-settings": "s10",
  "password-change": "s12",
};

/** やりかたの「マニュアルで見る」の行き先。つないでいないもの(マニュアルそのもの)は undefined。 */
export function manualHrefFor(howtoId: string): string | undefined {
  const sec = HOWTO_MANUAL_SECTION[howtoId];
  return sec ? `${MANUAL_PATH}#${sec}` : undefined;
}
