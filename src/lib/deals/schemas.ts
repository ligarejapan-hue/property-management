import { z } from "zod";
import {
  BANK_ACCOUNT_TYPES, BASE_PROPERTY_KINDS, DEAL_BUSINESS_TYPES, DEAL_PARTY_ROLES, DEAL_PARTY_TYPES,
  DEAL_STATUSES, DEAL_TRADE_SIDES, LAND_RIGHTS,
} from "./constants";
import { text, yenInt } from "./schema-parts";
import { fundingInputsSchema } from "./funding-schema";
import { businessInputsSchema } from "./business-schema";
import { sectionMatrixSchema } from "./business-sections";

export { text, yenInt };

const isoDateTime = z.string().datetime({ offset: true }).nullable();
const userRef = z.string().uuid().nullable();

export const propertySnapshotSchema = z.object({
  buildingName: text(200),
  roomNo: text(50),
  address: text(300),
  lotNumber: text(300),
  buildingNumber: text(100),
  propertyTypeLabel: text(50),
  structure: text(100),
  builtYear: z.number().int().min(1800).max(2200).nullable(),
  builtMonth: z.number().int().min(1).max(12).nullable(),
  floorArea: z.number().nonnegative().max(10_000_000).nullable(),
  landArea: z.number().nonnegative().max(10_000_000).nullable(),
  landRight: z.enum(LAND_RIGHTS).nullable(),
  access: text(500),
  layout: text(50),
}).strict();
export type PropertySnapshot = z.output<typeof propertySnapshotSchema>;
export const EMPTY_SNAPSHOT: PropertySnapshot = {
  buildingName: null, roomNo: null, address: null, lotNumber: null, buildingNumber: null, propertyTypeLabel: null,
  structure: null, builtYear: null, builtMonth: null, floorArea: null, landArea: null, landRight: null, access: null, layout: null,
};

export const counterpartyBrokerSchema = z.object({ company: text(200), staff: text(100), tel: text(50) }).strict();
export type CounterpartyBroker = z.output<typeof counterpartyBrokerSchema>;
export const EMPTY_BROKER: CounterpartyBroker = { company: null, staff: null, tel: null };

export const bankAccountSchema = z.object({
  bankName: text(100),
  branchName: text(100),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable(),
  accountNumber: z.string().trim().regex(/^\d{0,7}$/).nullable().transform((v) => (v ? v : null)),
  accountHolder: text(100),
}).strict();
export type BankAccount = z.output<typeof bankAccountSchema>;
export const EMPTY_BANK_ACCOUNT: BankAccount = { bankName: null, branchName: null, accountType: null, accountNumber: null, accountHolder: null };

const propertyKindSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,30}$/),
  label: z.string().trim().min(1).max(30),
  base: z.enum(BASE_PROPERTY_KINDS),
}).strict();
export const propertyKindsSchema = z.array(propertyKindSchema).min(4).max(20)
  .refine((ks) => new Set(ks.map((k) => k.key)).size === ks.length, "物件種別の鍵が重なっています")
  .refine((ks) => BASE_PROPERTY_KINDS.every((b) => ks.some((k) => k.key === b)), "基本の4種別は消せません")
  .refine((ks) => ks.every((k) => !(BASE_PROPERTY_KINDS as readonly string[]).includes(k.key) || k.base === k.key), "基本の4種別の元の種別は変えられません");

// ---- 段2(計算)の入力。取引の JSONB 列に入れる(設計 §2.1)。----

export const assessmentsSchema = z.object({
  rows: z.array(z.object({
    building: yenInt, land: yenInt,
    shareNum: z.number().int().positive(), shareDen: z.number().int().positive(),
  }).strict().refine((r) => r.shareNum <= r.shareDen, "持分は分子≦分母")).max(50),
  /** 土地評価額に掛ける割合(借地権など)。1/100 %・初期値 100%。 */
  landRatioBp: z.number().int().min(0).max(10000),
}).strict();
export type Assessments = z.output<typeof assessmentsSchema>;
export const DEFAULT_ASSESSMENTS: Assessments = { rows: [], landRatioBp: 10000 };

const otherCostSchema = z.object({ label: z.string().trim().min(1).max(50), amount: yenInt }).strict();
export const costsSchema = z.object({
  scrivener: z.object({ name: text(100), address: text(300), tel: text(50), staff: text(100) }).strict(),
  registrationFee: yenInt.nullable(),
  cancellationFee: yenInt.nullable(),
  surveyFee: yenInt.nullable(),
  others: z.array(otherCostSchema).max(20),
  /** 低廉な空家等の特例(依頼書 3.1)。 */
  lowCostSpecial: z.boolean(),
}).strict();
export type Costs = z.output<typeof costsSchema>;
export const DEFAULT_COSTS: Costs = {
  scrivener: { name: null, address: null, tel: null, staff: null },
  registrationFee: null, cancellationFee: null, surveyFee: null, others: [], lowCostSpecial: false,
};

const otherSettlementSchema = z.object({
  label: z.string().trim().min(1).max(50), sellerToBuyer: yenInt, buyerToSeller: yenInt,
}).strict();
export const settlementTermsSchema = z.object({
  fixedAssetTax: yenInt.nullable(),
  cityPlanningTax: yenInt.nullable(),
  taxStart: z.enum(["01-01", "04-01"]),
  managementFee: yenInt.nullable(),
  repairReserve: yenInt.nullable(),
  otherMonthly: yenInt.nullable(),
  managementPrepaidMonths: z.number().int().min(0).max(12),
  rentPrepaidMonths: z.number().int().min(0).max(12),
  depositMode: z.enum(["offset", "separate"]),
  others: z.array(otherSettlementSchema).max(20),
}).strict();
export type SettlementTerms = z.output<typeof settlementTermsSchema>;
export const DEFAULT_TERMS: SettlementTerms = {
  fixedAssetTax: null, cityPlanningTax: null, taxStart: "01-01", managementFee: null, repairReserve: null, otherMonthly: null,
  managementPrepaidMonths: 0, rentPrepaidMonths: 0, depositMode: "offset", others: [],
};

export const leaseSchema = z.object({
  room: text(30), tenant: text(100), contractType: z.enum(["ordinary", "fixed_term"]), period: text(100),
  rent: yenInt, commonFee: yenInt, parking: yenInt, other: yenInt, deposit: yenInt,
  arrears: z.boolean(), arrearsAmount: yenInt, manager: text(100),
}).strict();
export type Lease = z.output<typeof leaseSchema>;
export const leasesSchema = z.array(leaseSchema).max(200);

/** 手で直せる計算値の鍵(表示 = 上書き ?? 計算)。 */
export const OVERRIDE_KEYS = [
  "brokerageFee", "buildingPrice", "buildingTax", "settlement.propertyTax", "settlement.management", "settlement.rent",
] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export const overridesSchema = z.partialRecord(z.enum(OVERRIDE_KEYS), yenInt);
export type Overrides = z.output<typeof overridesSchema>;

export const dealCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  businessType: z.enum(DEAL_BUSINESS_TYPES),
  tradeSide: z.enum(DEAL_TRADE_SIDES).nullable().optional(),
  propertyId: z.string().uuid().nullable().optional(),
  propertyKind: z.string().min(1).max(30).nullable().optional(),
  hasOc: z.boolean().optional(),
  propertySnapshot: propertySnapshotSchema.optional(),
}).strict();
export type DealCreateInput = z.output<typeof dealCreateSchema>;

export const dealUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  businessType: z.enum(DEAL_BUSINESS_TYPES).optional(),
  tradeSide: z.enum(DEAL_TRADE_SIDES).nullable().optional(),
  status: z.enum(DEAL_STATUSES).optional(),
  assigneeId: userRef.optional(),
  licensedAgentId: userRef.optional(),
  salesStaffId: userRef.optional(),
  opsStaffId: userRef.optional(),
  propertyKind: z.string().min(1).max(30).nullable().optional(),
  hasOc: z.boolean().optional(),
  contractAt: isoDateTime.optional(),
  contractPlace: text(200).optional(),
  settlementAt: isoDateTime.optional(),
  settlementPlace: text(200).optional(),
  propertySnapshot: propertySnapshotSchema.optional(),
  counterpartyBroker: counterpartyBrokerSchema.optional(),
  price: yenInt.nullable().optional(),
  deposit: yenInt.nullable().optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  assessments: assessmentsSchema.optional(),
  costs: costsSchema.optional(),
  settlementTerms: settlementTermsSchema.optional(),
  leases: leasesSchema.optional(),
  overrides: overridesSchema.optional(),
  /** 資金計画表の入力(`plan_inputs.funding` だけを差し替える)。 */
  fundingPlan: fundingInputsSchema.optional(),
  /** 事業計画書の入力(`plan_inputs.business` だけを差し替える・買取再販だけ)。 */
  businessPlan: businessInputsSchema.optional(),
}).strict();
export type DealUpdateInput = z.output<typeof dealUpdateSchema>;

const partyFields = {
  role: z.enum(DEAL_PARTY_ROLES),
  partyType: z.enum(DEAL_PARTY_TYPES),
  name: z.string().trim().min(1).max(200),
  representative: text(100).optional(),
  address: text(300).optional(),
  phone: text(50).optional(),
  shareNum: z.number().int().positive().nullable().optional(),
  shareDen: z.number().int().positive().nullable().optional(),
};
type Share = { shareNum?: number | null; shareDen?: number | null };
const shareOk = (v: Share) => {
  const n = v.shareNum ?? null;
  const d = v.shareDen ?? null;
  if (n === null && d === null) return true;
  return n !== null && d !== null && n <= d;
};
const SHARE_MESSAGE = "持分は分子と分母の両方を入れてください(分子は分母以下)";

export const partyInputSchema = z.object({ ...partyFields, isSelf: z.boolean().default(false) }).strict()
  .refine(shareOk, SHARE_MESSAGE);
export type PartyInput = z.output<typeof partyInputSchema>;

export const partyUpdateSchema = z.object({
  version: z.number().int().positive(),
  role: partyFields.role.optional(),
  partyType: partyFields.partyType.optional(),
  name: partyFields.name.optional(),
  representative: partyFields.representative,
  address: partyFields.address,
  phone: partyFields.phone,
  shareNum: partyFields.shareNum,
  shareDen: partyFields.shareDen,
  isSelf: z.boolean().optional(),
}).strict()
  // 持分は片方だけ直すと組がずれるので、直すときは両方送る。
  .refine((v) => (v.shareNum === undefined) === (v.shareDen === undefined), SHARE_MESSAGE)
  .refine((v) => v.shareNum === undefined || shareOk(v), SHARE_MESSAGE);

/** 書類ごとの文面(設計 §2.4)。あいさつ文は書類の頭、注意事項は末尾に出す。改行はそのまま。 */
export const DEAL_TEXT_LIMITS = { greeting: 400, notes: 1000 } as const;
const docTextSchema = z.object({ greeting: text(DEAL_TEXT_LIMITS.greeting), notes: text(DEAL_TEXT_LIMITS.notes) }).strict();
export type DealDocText = z.infer<typeof docTextSchema>;
/** 文面を持つ書類。書類を足すときはここに1行足す。 */
export const dealTextsSchema = z.object({ funding_plan: docTextSchema.optional() }).strict();
export type DealTexts = z.infer<typeof dealTextsSchema>;

export const dealSettingsUpdateSchema = z.object({
  /** 0 = まだ設定の行が無い(初めての保存)。 */
  version: z.number().int().min(0),
  representativeTitle: text(50).optional(),
  representativeName: text(100).optional(),
  bankAccount: bankAccountSchema.optional(),
  propertyKinds: propertyKindsSchema.optional(),
  texts: dealTextsSchema.optional(),
  /** 事業計画書の種別×セクションの表。 */
  sectionMatrix: sectionMatrixSchema.optional(),
}).strict();
