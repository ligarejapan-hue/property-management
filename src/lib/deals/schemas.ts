import { z } from "zod";
import {
  BANK_ACCOUNT_TYPES, BASE_PROPERTY_KINDS, DEAL_BUSINESS_TYPES, DEAL_PARTY_ROLES, DEAL_PARTY_TYPES,
  DEAL_STATUSES, DEAL_TRADE_SIDES, LAND_RIGHTS,
} from "./constants";

/** 文字の欄: 前後の空白を落とし、空なら null。 */
const text = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === "" ? null : v));
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
  .refine((ks) => BASE_PROPERTY_KINDS.every((b) => ks.some((k) => k.key === b)), "基本の4種別は消せません");

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

export const dealSettingsUpdateSchema = z.object({
  /** 0 = まだ設定の行が無い(初めての保存)。 */
  version: z.number().int().min(0),
  representativeTitle: text(50).optional(),
  representativeName: text(100).optional(),
  bankAccount: bankAccountSchema.optional(),
  propertyKinds: propertyKindsSchema.optional(),
}).strict();
