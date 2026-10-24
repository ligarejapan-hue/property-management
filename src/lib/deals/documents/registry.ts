import { z } from "zod";
import type { BusinessDocContext, ValueRow } from "./business/common";
import { partiesOf } from "./business/common";
import { buildSettlementStatement } from "./business/settlement-statement";
import { DEFAULT_BELONGINGS, buildSettlementGuide, defaultPayee, settlementGuideOptionsSchema } from "./business/settlement-guide";
import {
  RECEIPT_KINDS, buildReceipt, issuerChoices, receiptAmount, receiptOptionsSchema, receiptSides,
  type IssuerChoice, type ReceiptKind,
} from "./business/receipts";

/**
 * 業務書類の一覧表(設計 §4.1・計画 段5a)。書類ごとに1行:
 * 出す条件・必要な項目(空欄の名前を返す)・発行のときに選ぶもの(形・初期値・選べる値)・組み立て。
 * 書類を足すときは、組み立ての関数を1つとこの表の1行を足す。
 */
export interface BusinessDocDef {
  key: string;
  label: string;
  /** この取引で出せるか(書類タブに出すか)。 */
  applies(c: BusinessDocContext): boolean;
  /** 必要な項目のうち空欄のもの(出す前の確認に出す)。 */
  missing(c: BusinessDocContext): string[];
  options: z.ZodType<Record<string, unknown>>;
  /** 発行のときに選ぶものの初期値と選べる値(画面に渡す)。 */
  defaults(c: BusinessDocContext): { values: Record<string, unknown>; issuers?: IssuerChoice[] };
  /** 組み立て。html = PDF にするもの。compactHtml があれば、html が 2 ページ以上のときにそちらで作り直す。 */
  build(c: BusinessDocContext, options: Record<string, unknown>): { html: string; compactHtml?: string; rows: ValueRow[] };
}

const emptyOptions = z.object({}).strict();
const need = (pairs: [string, unknown][]) => pairs.filter(([, v]) => v === null || v === undefined || v === "").map(([k]) => k);
const hasParty = (c: BusinessDocContext, role: "seller" | "buyer") => (partiesOf(c.deal, role).length ? "ok" : null);

function receiptDef(kind: ReceiptKind): BusinessDocDef {
  return {
    key: kind,
    label: RECEIPT_KINDS[kind].label,
    // 精算金は差引が 0 のときは出さない(計画の読み替え 8)。手付金・残金はいつも出す(金額が無ければ確認に出す)。
    applies: (c) => kind !== "settlement_receipt" || receiptSides(kind, c) !== null,
    missing: (c) => need([
      [`${RECEIPT_KINDS[kind].purpose}の金額`, receiptAmount(kind, c)], ["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")],
    ]),
    options: receiptOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => {
      const { choices, initial } = issuerChoices(kind, c);
      return { values: { issuer: initial, exempt: null, receivedOn: null }, issuers: choices };
    },
    build: (c, o) => buildReceipt(kind, c, receiptOptionsSchema.parse(o)),
  };
}

export const BUSINESS_DOCS: BusinessDocDef[] = [
  {
    key: "settlement_statement",
    label: "精算書",
    applies: () => true,
    missing: (c) => need([
      ["決済日時", c.deal.settlementAt], ["売買価格", c.deal.price], ["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")],
    ]),
    options: emptyOptions,
    defaults: () => ({ values: {} }),
    build: (c) => buildSettlementStatement(c),
  },
  {
    key: "settlement_guide",
    label: "残金決済のご案内",
    applies: () => true,
    missing: (c) => need([
      ["決済日時", c.deal.settlementAt], ["決済場所", c.deal.settlementPlace], ["売買価格", c.deal.price], ["買主", hasParty(c, "buyer")],
    ]),
    options: settlementGuideOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { payee: defaultPayee(c), belongings: DEFAULT_BELONGINGS } }),
    build: (c, o) => buildSettlementGuide(c, settlementGuideOptionsSchema.parse(o)),
  },
  receiptDef("deposit_receipt"),
  receiptDef("balance_receipt"),
  receiptDef("settlement_receipt"),
];

export const BUSINESS_DOC_KEYS = BUSINESS_DOCS.map((d) => d.key);
export const businessDocOf = (key: string) => BUSINESS_DOCS.find((d) => d.key === key) ?? null;
