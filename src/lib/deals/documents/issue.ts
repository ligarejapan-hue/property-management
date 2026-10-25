import { encodeRfc5987 } from "@/lib/attachments/registry-display-name";

/**
 * 発行する書類の一覧(設計 §4.1 の一部)。段3=資金計画表・段4=事業計画書。段5でここに足す。
 * variant は書類ごとの出し分け(資金計画表=購入/売却・事業計画書=社内用/銀行向け)。
 */
export const DEAL_DOC_TYPES = {
  funding_plan: { label: "資金計画表", variants: { purchase: "購入", sale: "売却" } },
  /** 買取再販の取引だけ(依頼書 4.2)。 */
  business_plan: { label: "事業計画書", variants: { internal: "社内用", bank: "銀行向け" } },
  // 業務書類(段5・組み立ては registry.ts)。出し分けは無い(variant = default)。
  settlement_statement: { label: "精算書", variants: { default: "" } },
  settlement_guide: { label: "残金決済のご案内", variants: { default: "" } },
  deposit_receipt: { label: "手付金領収書", variants: { default: "" } },
  balance_receipt: { label: "残金領収書", variants: { default: "" } },
  settlement_receipt: { label: "精算金領収書", variants: { default: "" } },
  power_of_attorney: { label: "委任状", variants: { default: "" } },
  key_receipt: { label: "鍵受領書", variants: { default: "" } },
  oc_purchase_consult: { label: "仕入相談表", variants: { default: "" } },
  tenant_survey: { label: "賃借人属性調査書", variants: { default: "" } },
  landlord_change_notice: { label: "賃貸人変更のお知らせ", variants: { default: "" } },
  handover_checklist: { label: "引継書類チェックリスト", variants: { default: "" } },
  checklist_contract: { label: "書類確認書(契約時)", variants: { default: "" } },
  checklist_settlement: { label: "書類確認書(決済時)", variants: { default: "" } },
} as const;

export type DealDocType = keyof typeof DEAL_DOC_TYPES;
export const DEAL_DOC_TYPE_KEYS = Object.keys(DEAL_DOC_TYPES) as [DealDocType, ...DealDocType[]];

export type DealDocFormat = "pdf" | "xlsx";

/** 画面に出す書類名。例: 資金計画表(購入)。知らない種類はキーのまま。 */
export function dealDocumentTitle(docType: string, variant: string): string {
  const def = (DEAL_DOC_TYPES as Record<string, { label: string; variants: Record<string, string> }>)[docType];
  if (!def) return docType;
  const v = def.variants[variant];
  return v ? `${def.label}(${v})` : def.label;
}

/**
 * ファイル名(拡張子なし)= `取引番号_書類名_YYYYMMDD`(設計 §4.9)。日付は日本時間の発行日。
 * お客様名などの入力は入れない(取引番号と書類の種類だけで決まる)。
 */
export function dealDocumentBaseName(dealNo: string, docType: DealDocType, variant: string, issuedOn: string): string {
  const def = DEAL_DOC_TYPES[docType];
  const v = (def.variants as Record<string, string>)[variant];
  const name = v ? `${def.label}_${v}` : def.label;
  return `${dealNo}_${name}_${issuedOn.replaceAll("-", "")}`;
}

/** 保存場所の鍵 = `deals/<取引ID>/<ファイルID>.<拡張子>`(設計 §4.9)。名前は鍵に入れない。 */
export function dealDocumentKey(dealId: string, fileId: string, format: DealDocFormat): string {
  return `deals/${dealId}/${fileId}.${format}`;
}

export const DEAL_DOC_MIME: Record<DealDocFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * 配るときの Content-Disposition。PDF はブラウザで開き、Excel は保存させる。
 * 日本語のファイル名は RFC 5987、古いブラウザ向けの名前は ASCII の定型名。
 */
export function dealDocumentContentDisposition(baseName: string, format: DealDocFormat): string {
  return [
    format === "pdf" ? "inline" : "attachment",
    `filename="deal-document.${format}"`,
    `filename*=UTF-8''${encodeRfc5987(`${baseName}.${format}`)}`,
  ].join("; ");
}

/** 取引の書類の保存場所か(`/uploads` からは配らない=取引の権限で配る道だけを使う)。 */
export function isDealDocumentStorageKey(key: string): boolean {
  // 先頭の「./」「/」や大文字小文字の違いでもすり抜けない。
  return /^(?:\.?\/+)*deals\//i.test(key);
}
