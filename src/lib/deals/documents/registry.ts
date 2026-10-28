import { z } from "zod";
import type { BusinessDocContext, ValueRow } from "./business/common";
import { partiesOf, type Choice } from "./business/common";
import { buildSettlementStatement } from "./business/settlement-statement";
import {
  DEFAULT_BELONGINGS, DEFAULT_SELLER_BELONGINGS, buildSellerSettlementGuide, buildSettlementGuide, defaultPayee, defaultSellerCosts,
  sellerGuideOptionsSchema, settlementGuideOptionsSchema,
} from "./business/settlement-guide";
import {
  RECEIPT_KINDS, buildReceipt, issuerChoices, receiptAmount, receiptOptionsSchema, receiptSides,
  type IssuerChoice, type ReceiptKind,
} from "./business/receipts";
import { POA_MATTERS, buildPowerOfAttorney, poaChoices, poaOptionsSchema } from "./business/power-of-attorney";
import { buildKeyReceipt, keyReceiptOptionsSchema, keyReceiverChoices } from "./business/key-receipt";
import {
  buildHandoverChecklist, buildLandlordChangeNotice, buildOcPurchaseConsult, buildTenantSurvey, landlordChangeDefaults,
  landlordChangeOptionsSchema, occupiedLeases,
} from "./business/oc-docs";
import { buildChecklistDoc, checklistDefaults, checklistMissing, checklistOptionsSchema } from "./business/checklist-doc";
import {
  addresseeChoices, addresseeMissingChoices, buildContractGuide, contractGuideMissing, contractGuideOptionsSchema, defaultAddressee, defaultContractBelongings,
} from "./business/contract-guide";
import type { FormDef } from "./forms/types";
import { SELLER_SURVEY_FORM } from "./forms/seller-survey";
import { MEDIATION_FORM } from "./forms/mediation";
import { buildMediation, mediationClientMissing, mediationDefaults, mediationMissing } from "./business/mediation";
import { buildSaleGuide } from "./business/sale-guide";
import { DISCLOSURE_FORM } from "./forms/disclosure";
import { buildDisclosure, disclosureDefaults, disclosureMissing } from "./business/disclosure";
import { EQUIPMENT_FORM } from "./forms/equipment";
import { buildEquipment, equipmentApplies, equipmentDefaults, equipmentMissing } from "./business/equipment";
import { formValuesSchema } from "./forms/schema";
import {
  SELLER_SURVEY_TITLE, buildSellerSurvey, sellerSurveyDefaults, sellerSurveyMissing, sellerSurveyOptionsSchema,
} from "./business/seller-survey";
import {
  buildPrepChecklist, defaultPrepKind, prepChecklistMissing, prepChecklistOptionsSchema, prepKindChoices,
} from "./business/prep-checklist";
import { buildCompletion, completionMissing, completionOptionsSchema, defaultHandover } from "./business/completion";
import type { ChecklistPhase } from "../checklist";

/**
 * 業務書類の一覧表(設計 §4.1・計画 段5a)。書類ごとに1行:
 * 出す条件・必要な項目(空欄の名前を返す)・発行のときに選ぶもの(形・初期値・選べる値)・組み立て。
 * 書類を足すときは、組み立ての関数を1つとこの表の1行を足す。
 */
export interface BusinessDocDef {
  key: string;
  label: string;
  /** 書類タブのまとまり(契約・媒介の書類/決済の書類/そのほかの書類/OC の書類/書類確認書)。 */
  group: "contract" | "settlement" | "other" | "oc" | "checklist";
  /** 前回発行したときの入力を、次の発行の初めの値にする(設計 第2段階 §3.2)。 */
  remember?: boolean;
  /** 謄本の登記の状況を使う(発行のときにも謄本を読む・書類確認書と同じ読み方)。 */
  usesRegistry?: boolean;
  /** 項目の表(入力画面と PDF をこの表から作る・設計 第2段階 §3.3)。画面へそのまま渡す。 */
  form?: FormDef;
  /** この取引で出せるか(書類タブに出すか)。 */
  applies(c: BusinessDocContext): boolean;
  /** 必要な項目のうち空欄のもの(出す前の確認に出す)。values = 画面に渡す初めの値(前回の入力を含む)。 */
  missing(c: BusinessDocContext, values?: Record<string, unknown>): string[];
  /** 空欄のままでは組み立てられない項目(「空欄のまま出す」を止める・最終レビュー)。 */
  blocking(c: BusinessDocContext): string[];
  options: z.ZodType<Record<string, unknown>>;
  /** 発行のときに選ぶものの初期値と選べる値(画面に渡す)。 */
  defaults(c: BusinessDocContext): { values: Record<string, unknown>; issuers?: IssuerChoice[]; choices?: Record<string, Choice[]> };
  /** 組み立て。html = PDF にするもの。compactHtml があれば、html が 2 ページ以上のときにそちらで作り直す。 */
  build(c: BusinessDocContext, options: Record<string, unknown>): { html: string; compactHtml?: string; rows: ValueRow[]; issuerName?: string };
}

const emptyOptions = z.object({}).strict();
const mediationOptionsSchema = formValuesSchema(MEDIATION_FORM);
const disclosureOptionsSchema = formValuesSchema(DISCLOSURE_FORM);
const equipmentOptionsSchema = formValuesSchema(EQUIPMENT_FORM);
const need = (pairs: [string, unknown][]) => pairs.filter(([, v]) => v === null || v === undefined || v === "").map(([k]) => k);
const hasParty = (c: BusinessDocContext, role: "seller" | "buyer") => (partiesOf(c.deal, role).length ? "ok" : null);

/** 賃借人のいる部屋が無ければ、お知らせ・調査書は組み立てられない(空のページになる)。 */
const needTenants = (c: BusinessDocContext) => (occupiedLeases(c).length ? [] : ["賃借人(賃貸条件)"]);

/** OC ありの取引だけに出す書類(選ぶもの無し。お知らせは上書きする)。 */
function ocDef(key: string, label: string, d: Pick<BusinessDocDef, "missing" | "blocking" | "build">): BusinessDocDef {
  return { key, label, group: "oc", applies: (c) => c.deal.hasOc, options: emptyOptions, defaults: () => ({ values: {} }), ...d };
}

/** 書類確認書(契約時・決済時・計画 段5c-1)。どの取引でも出す。止める項目は無い(空欄は「—」で出す)。 */
function checklistDef(phase: ChecklistPhase, key: string, label: string): BusinessDocDef {
  return {
    key, label, group: "checklist", applies: () => true,
    missing: (c) => checklistMissing(phase, c), blocking: () => [],
    options: checklistOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => checklistDefaults(phase, c),
    build: (c, o) => buildChecklistDoc(phase, c, checklistOptionsSchema.parse(o)),
  };
}

function receiptDef(kind: ReceiptKind): BusinessDocDef {
  return {
    key: kind,
    label: RECEIPT_KINDS[kind].label,
    group: "settlement",
    // 精算金は差引が 0 のときは出さない(計画の読み替え 8)。手付金・残金はいつも出す(金額が無ければ確認に出す)。
    applies: (c) => kind !== "settlement_receipt" || receiptSides(kind, c) !== null,
    missing: (c) => need([
      [`${RECEIPT_KINDS[kind].purpose}の金額`, receiptAmount(kind, c)], ["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")],
    ]),
    blocking: (c) => need([[`${RECEIPT_KINDS[kind].purpose}の金額`, receiptAmount(kind, c)]]),
    options: receiptOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => {
      const { choices, initial } = issuerChoices(kind, c);
      return { values: { issuer: initial, exempt: null, receivedOn: null }, issuers: choices };
    },
    build: (c, o) => {
      const r = buildReceipt(kind, c, receiptOptionsSchema.parse(o));
      return { html: r.html, rows: r.rows, issuerName: r.issuerLabel };
    },
  };
}

export const BUSINESS_DOCS: BusinessDocDef[] = [
  {
    key: "contract_guide",
    label: "契約のご案内",
    group: "contract",
    remember: true,
    applies: () => true,
    missing: (c, v) => contractGuideMissing(c, v?.addressee),
    blocking: () => [],
    options: contractGuideOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({
      values: { addressee: defaultAddressee(c), belongings: defaultContractBelongings(c), notes: null },
      choices: { addressee: addresseeChoices(c), addresseeMissing: addresseeMissingChoices(c) },
    }),
    build: (c, o) => buildContractGuide(c, contractGuideOptionsSchema.parse(o)),
  },
  {
    key: "seller_survey",
    label: SELLER_SURVEY_TITLE,
    group: "contract",
    remember: true,
    usesRegistry: true,
    form: SELLER_SURVEY_FORM,
    applies: (c) => partiesOf(c.deal, "seller").length > 0,
    missing: (c) => sellerSurveyMissing(c),
    blocking: () => [],
    options: sellerSurveyOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: sellerSurveyDefaults(c) }),
    build: (c, o) => buildSellerSurvey(c, sellerSurveyOptionsSchema.parse(o)),
  },
  {
    key: "mediation",
    label: "媒介契約書",
    group: "contract",
    remember: true,
    form: MEDIATION_FORM,
    applies: (c) => c.deal.businessType === "brokerage",
    missing: (c, v) => mediationMissing(c, v),
    blocking: () => [],
    options: mediationOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: mediationDefaults(c), choices: { clientMissing: mediationClientMissing(c) } }),
    build: (c, o) => buildMediation(c, mediationOptionsSchema.parse(o)),
  },
  {
    key: "sale_guide",
    label: "媒介契約の前の説明書(売却用)",
    group: "contract",
    applies: (c) => c.deal.businessType === "brokerage" && (c.deal.tradeSide === "seller" || c.deal.tradeSide === "both"),
    missing: () => [],
    blocking: () => [],
    options: emptyOptions,
    defaults: () => ({ values: {} }),
    build: (c) => buildSaleGuide(c),
  },
  {
    key: "disclosure",
    label: "物件状況確認書(告知書)",
    group: "contract",
    remember: true,
    form: DISCLOSURE_FORM,
    applies: () => true,
    missing: (c) => disclosureMissing(c),
    blocking: () => [],
    options: disclosureOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: disclosureDefaults(c) }),
    build: (c, o) => buildDisclosure(c, disclosureOptionsSchema.parse(o)),
  },
  {
    key: "equipment",
    label: "付帯設備表",
    group: "contract",
    remember: true,
    form: EQUIPMENT_FORM,
    applies: (c) => equipmentApplies(c),
    missing: (c) => equipmentMissing(c),
    blocking: () => [],
    options: equipmentOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: equipmentDefaults(c) }),
    build: (c, o) => buildEquipment(c, equipmentOptionsSchema.parse(o)),
  },
  {
    key: "settlement_statement",
    label: "精算書",
    group: "settlement",
    applies: () => true,
    missing: (c) => need([
      ["決済日時", c.deal.settlementAt], ["売買価格", c.deal.price], ["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")],
    ]),
    blocking: () => [],
    options: emptyOptions,
    defaults: () => ({ values: {} }),
    build: (c) => buildSettlementStatement(c),
  },
  {
    key: "settlement_guide",
    label: "残金決済のご案内",
    group: "settlement",
    applies: () => true,
    missing: (c) => need([
      ["決済日時", c.deal.settlementAt], ["決済場所", c.deal.settlementPlace], ["売買価格", c.deal.price], ["買主", hasParty(c, "buyer")],
    ]),
    blocking: () => [],
    options: settlementGuideOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { payee: defaultPayee(c), belongings: DEFAULT_BELONGINGS } }),
    build: (c, o) => buildSettlementGuide(c, settlementGuideOptionsSchema.parse(o)),
  },
  {
    key: "settlement_guide_seller",
    label: "残金決済のご案内(売主様)",
    group: "settlement",
    applies: () => true,
    missing: (c) => need([
      ["決済日時", c.deal.settlementAt], ["決済場所", c.deal.settlementPlace], ["売買価格", c.deal.price], ["売主", hasParty(c, "seller")],
    ]),
    blocking: () => [],
    options: sellerGuideOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { costs: defaultSellerCosts(c), receiveTo: null, belongings: DEFAULT_SELLER_BELONGINGS } }),
    build: (c, o) => buildSellerSettlementGuide(c, sellerGuideOptionsSchema.parse(o)),
  },
  receiptDef("deposit_receipt"),
  receiptDef("balance_receipt"),
  receiptDef("settlement_receipt"),
  {
    key: "completion_confirmation",
    label: "取引完了確認書",
    group: "settlement",
    remember: true,
    applies: () => true,
    missing: (c) => completionMissing(c),
    blocking: () => [],
    options: completionOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { handover: defaultHandover(c) } }),
    build: (c, o) => buildCompletion(c, completionOptionsSchema.parse(o)),
  },
  {
    key: "power_of_attorney",
    label: "委任状",
    group: "other",
    applies: () => true,
    missing: (c) => need([["物件", c.deal.propertySnapshot.address || c.deal.propertySnapshot.buildingName]]),
    blocking: (c) => (poaChoices(c).initialPrincipal ? [] : ["委任する人(売主・買主)"]),
    options: poaOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => {
      const ch = poaChoices(c);
      return {
        values: { principal: ch.initialPrincipal, agent: "self", matters: [], otherMatter: null, signedOn: null },
        choices: { principal: ch.principal, agent: ch.agent, matters: Object.entries(POA_MATTERS).map(([value, label]) => ({ value, label })) },
      };
    },
    build: (c, o) => buildPowerOfAttorney(c, poaOptionsSchema.parse(o)),
  },
  {
    key: "key_receipt",
    label: "鍵受領書",
    group: "other",
    applies: () => true,
    missing: (c) => need([["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")]]),
    blocking: () => [],
    options: keyReceiptOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => {
      const { choices, initial } = keyReceiverChoices(c);
      return { values: { receiver: initial, keys: [], receivedOn: null }, choices: { receiver: choices } };
    },
    build: (c, o) => buildKeyReceipt(c, keyReceiptOptionsSchema.parse(o)),
  },
  ocDef("oc_purchase_consult", "仕入相談表", {
    missing: (c) => need([["売買価格", c.deal.price], ["賃貸条件", c.deal.leases.length ? "ok" : null]]),
    blocking: () => [],
    build: (c) => buildOcPurchaseConsult(c),
  }),
  ocDef("tenant_survey", "賃借人属性調査書", { missing: () => [], blocking: needTenants, build: (c) => buildTenantSurvey(c) }),
  {
    ...ocDef("landlord_change_notice", "賃貸人変更のお知らせ", {
      missing: (c) => need([["決済日時(変更日)", c.deal.settlementAt], ["売主", hasParty(c, "seller")], ["買主", hasParty(c, "buyer")]]),
      blocking: needTenants,
      build: (c, o) => buildLandlordChangeNotice(c, landlordChangeOptionsSchema.parse(o)),
    }),
    options: landlordChangeOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: landlordChangeDefaults(c) }),
  },
  ocDef("handover_checklist", "引継書類チェックリスト", {
    missing: (c) => need([["賃貸条件", c.deal.leases.length ? "ok" : null]]),
    blocking: () => [],
    build: (c) => buildHandoverChecklist(c),
  }),
  checklistDef("contract", "checklist_contract", "書類確認書(契約時)"),
  checklistDef("settlement", "checklist_settlement", "書類確認書(決済時)"),
  {
    key: "prep_checklist",
    label: "準備チェックリスト",
    group: "checklist",
    applies: () => true,
    missing: (c) => prepChecklistMissing(c),
    blocking: () => [],
    options: prepChecklistOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { kind: defaultPrepKind(c) }, choices: { kind: prepKindChoices() } }),
    build: (c, o) => buildPrepChecklist(c, prepChecklistOptionsSchema.parse(o)),
  },
];

export const BUSINESS_DOC_KEYS = BUSINESS_DOCS.map((d) => d.key);
export const businessDocOf = (key: string) => BUSINESS_DOCS.find((d) => d.key === key) ?? null;
