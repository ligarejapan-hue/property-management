import { DEFAULT_PROPERTY_KINDS, type PropertyKindDef } from "./constants";
import { EMPTY_BANK_ACCOUNT, bankAccountSchema, propertyKindsSchema, type BankAccount } from "./schemas";

export const DEAL_SETTINGS_ID = "singleton";

export interface DealSettingsRow {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: unknown;
  propertyKinds: unknown;
  version: number;
  updatedAt: Date;
}

export interface DealSettingsView {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: BankAccount;
  propertyKinds: PropertyKindDef[];
  /** 0 = 行がまだ無い。 */
  version: number;
  updatedAt: string | null;
}

/** DB の行 → 画面・API で使う形。欠けた・壊れた値は初期値で補う。 */
export function resolveDealSettings(row: DealSettingsRow | null): DealSettingsView {
  if (!row) {
    return { representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT, propertyKinds: DEFAULT_PROPERTY_KINDS, version: 0, updatedAt: null };
  }
  const kinds = propertyKindsSchema.safeParse(row.propertyKinds);
  const bank = bankAccountSchema.safeParse({ ...EMPTY_BANK_ACCOUNT, ...(row.bankAccount && typeof row.bankAccount === "object" ? row.bankAccount : {}) });
  return {
    representativeTitle: row.representativeTitle,
    representativeName: row.representativeName,
    bankAccount: bank.success ? bank.data : EMPTY_BANK_ACCOUNT,
    propertyKinds: kinds.success ? kinds.data : DEFAULT_PROPERTY_KINDS,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isKnownPropertyKind(s: DealSettingsView, kind: string | null | undefined): boolean {
  return kind === null || kind === undefined || s.propertyKinds.some((k) => k.key === kind);
}
