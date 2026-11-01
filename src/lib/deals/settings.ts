import { DEFAULT_PROPERTY_KINDS, type PropertyKindDef } from "./constants";
import { resolveSectionMatrix, type SectionMatrix } from "./business-sections";
import { DEFAULT_CHECKLIST_ITEMS, resolveChecklistItems, type ChecklistItem } from "./checklist";
import { DEFAULT_SCHEDULE_TEMPLATE, resolveScheduleTemplate, type ScheduleTemplateItem } from "./schedule";
import { DEFAULT_REQUEST_TEMPLATES, resolveRequestTemplates, type RequestTemplate } from "./request-drafts/templates";
import { EMPTY_BANK_ACCOUNT, bankAccountSchema, dealTextsSchema, propertyKindsSchema, type BankAccount, type DealTexts } from "./schemas";

export const DEAL_SETTINGS_ID = "singleton";

export interface DealSettingsRow {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: unknown;
  propertyKinds: unknown;
  logoKey?: string | null;
  sealKey?: string | null;
  texts?: unknown;
  sectionMatrix?: unknown;
  checklistItems?: unknown;
  scheduleTemplate?: unknown;
  requestTemplates?: unknown;
  version: number;
  updatedAt: Date;
}

export interface DealSettingsView {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: BankAccount;
  propertyKinds: PropertyKindDef[];
  /** 書類ごとの文面。 */
  texts: DealTexts;
  /** ロゴ・角印が登録されているか(保存場所の鍵は画面に渡さない)。 */
  hasLogo: boolean;
  hasSeal: boolean;
  /** 事業計画書の種別×セクションの表(今の物件種別ごとの行にそろえたもの)。 */
  sectionMatrix: SectionMatrix;
  /** 書類確認書の項目(保存が無ければ初めの項目)。 */
  checklistItems: ChecklistItem[];
  /** 段取りのひな形(保存が無ければ初期のひな形)。 */
  scheduleTemplate: ScheduleTemplateItem[];
  /** 外部への依頼文のひな形(保存が無ければ初めのひな形)。 */
  requestTemplates: RequestTemplate[];
  /** 0 = 行がまだ無い。 */
  version: number;
  updatedAt: string | null;
}

/** DB の行 → 画面・API で使う形。欠けた・壊れた値は初期値で補う。 */
export function resolveDealSettings(row: DealSettingsRow | null): DealSettingsView {
  if (!row) {
    return {
      representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT, propertyKinds: DEFAULT_PROPERTY_KINDS,
      texts: {}, hasLogo: false, hasSeal: false, sectionMatrix: resolveSectionMatrix(undefined, DEFAULT_PROPERTY_KINDS), checklistItems: DEFAULT_CHECKLIST_ITEMS, scheduleTemplate: DEFAULT_SCHEDULE_TEMPLATE, requestTemplates: DEFAULT_REQUEST_TEMPLATES, version: 0, updatedAt: null,
    };
  }
  const kinds = propertyKindsSchema.safeParse(row.propertyKinds);
  const bank = bankAccountSchema.safeParse({ ...EMPTY_BANK_ACCOUNT, ...(row.bankAccount && typeof row.bankAccount === "object" ? row.bankAccount : {}) });
  const texts = dealTextsSchema.safeParse(row.texts ?? {});
  const propertyKinds = kinds.success ? kinds.data : DEFAULT_PROPERTY_KINDS;
  return {
    representativeTitle: row.representativeTitle,
    representativeName: row.representativeName,
    bankAccount: bank.success ? bank.data : EMPTY_BANK_ACCOUNT,
    propertyKinds,
    texts: texts.success ? texts.data : {},
    hasLogo: Boolean(row.logoKey),
    hasSeal: Boolean(row.sealKey),
    sectionMatrix: resolveSectionMatrix(row.sectionMatrix, propertyKinds),
    checklistItems: resolveChecklistItems(row.checklistItems),
    scheduleTemplate: resolveScheduleTemplate(row.scheduleTemplate),
    requestTemplates: resolveRequestTemplates(row.requestTemplates),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isKnownPropertyKind(s: DealSettingsView, kind: string | null | undefined): boolean {
  return kind === null || kind === undefined || s.propertyKinds.some((k) => k.key === kind);
}
