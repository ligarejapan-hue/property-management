import { z } from "zod";

/**
 * 外部への依頼文のひな形と差し込み。**純関数だけ**(画面でも使う)。DB は store.ts、欄の値は values.ts。
 * 結びつきはひな形の側に段取りの項目の鍵を持つ(段取りのひな形には足さない:
 * 保存済みの段取りのひな形を書き換えずに初めの結びつきが効き、前の版へ戻しても段取りの読み出しが落ちない)。
 */
export const REQUEST_RECIPIENTS = {
  scrivener: "司法書士", bank: "金融機関", management: "管理会社", seller: "売主", broker: "相手業者", tenant: "賃借人", other: "その他",
} as const;
export type RequestRecipient = keyof typeof REQUEST_RECIPIENTS;

/** 差し込み欄。抵当権者は入れない(謄本にしかなく、担保の件数や抵当権者を段取りに出さない決定 2026-10-31)。 */
export const REQUEST_FIELD_GROUPS = [
  ["物件", ["物件名", "所在", "地番", "部屋番号"]],
  ["日時・金額", ["決済日時", "決済日", "決済場所", "契約日時", "売買価格", "売主から買主への精算額", "買主から売主への精算額", "決済時のお支払額", "取引番号"]],
  ["自社", ["会社名", "会社電話", "会社住所", "担当者名"]],
  ["相手", ["司法書士名", "司法書士担当者", "相手業者名", "相手業者担当者", "管理会社名"]],
  ["氏名・住所(権限がない人には空)", ["売主名", "売主住所", "買主名", "賃借人名"]],
  ["書類", ["必要書類", "提出用リンクのご案内", "提出用リンク", "リンクの期限", "賃料振込先"]],
] as const;
export type RequestField = (typeof REQUEST_FIELD_GROUPS)[number][1][number];
export const REQUEST_FIELDS: readonly RequestField[] = REQUEST_FIELD_GROUPS.flatMap(([, fields]) => fields);

/** 欄が空になった理由。unknown=ひな形に知らない欄の名前がある。 */
export const REQUEST_BLANK_LABELS = { missing: "未入力", permission: "権限なし", no_link: "リンク未発行", unknown: "使えない欄の名前" } as const;
export type RequestBlankReason = keyof typeof REQUEST_BLANK_LABELS;
export type RequestFieldValue = { value: string } | { blank: RequestBlankReason };
export type RequestFieldValues = Partial<Record<RequestField, RequestFieldValue>>;
export interface RequestBlank { field: string; reason: RequestBlankReason }

export const REQUEST_LIMITS = { label: 60, body: 4000, items: 50 } as const;
const KEY = /^[a-z0-9_]{1,40}$/;
const PLACEHOLDER = /\{\{\s*([^{}\n]{1,30}?)\s*\}\}/g;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const templateSchema = z.object({
  id: z.string().regex(KEY),
  label: z.string().trim().min(1, "依頼文のひな形に、名前が空の行があります").max(REQUEST_LIMITS.label, `依頼文のひな形の名前は${REQUEST_LIMITS.label}文字までです`),
  recipient: z.enum(keys(REQUEST_RECIPIENTS)),
  /** 段取りの項目の鍵(DealScheduleItem.templateKey)。null=結びつけない。 */
  scheduleItemKey: z.string().regex(KEY).nullable(),
  body: z.string().trim().min(1, "依頼文のひな形に、本文が空の行があります").max(REQUEST_LIMITS.body, `依頼文のひな形の本文は${REQUEST_LIMITS.body}文字までです`),
}).strict();
export type RequestTemplate = z.output<typeof templateSchema>;

const templateListSchema = z.array(templateSchema).min(1, "依頼文のひな形を1つ以上入れてください").max(REQUEST_LIMITS.items)
  .refine((ts) => new Set(ts.map((t) => t.id)).size === ts.length, "依頼文のひな形の鍵が重なっています");

/** ひな形の中の、知らない差し込み欄(重なりなし)。 */
export function unknownFieldsOf(body: string): string[] {
  const known = new Set<string>(REQUEST_FIELDS);
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((f) => !known.has(f)))];
}

/** 保存するとき。読み出し(resolveRequestTemplates)は知らない欄で落とさない=欄を減らしても全部が初めに戻らない。 */
export const requestTemplatesSaveSchema = templateListSchema.superRefine((ts, ctx) => {
  const unknown = [...new Set(ts.flatMap((t) => unknownFieldsOf(t.body)))];
  if (unknown.length) ctx.addIssue({ code: "custom", message: `使えない差し込み欄があります: ${unknown.map((f) => `{{${f}}}`).join("、")}` });
});

const SIGN = "\n\n{{会社名}}\n担当:{{担当者名}}\nTEL:{{会社電話}}";
const row = (id: string, label: string, recipient: RequestRecipient, scheduleItemKey: string, body: string): RequestTemplate => ({ id, label, recipient, scheduleItemKey, body: body + SIGN });

export const DEFAULT_REQUEST_TEMPLATES: RequestTemplate[] = [
  row("r_scrivener", "司法書士へ:決済日時と登記の依頼", "scrivener", "c_scrivener",
    "{{司法書士名}}\n{{司法書士担当者}} 様\n\nいつもお世話になっております。{{会社名}}の{{担当者名}}です。\n下記の取引について、決済の立ち会いと登記をお願いいたします。\n\n物件:{{物件名}}\n所在:{{所在}}\n地番:{{地番}}\n売主:{{売主名}}\n買主:{{買主名}}\n売買価格:{{売買価格}}\n決済日時:{{決済日時}}\n決済場所:{{決済場所}}\n\nご都合、必要な書類、お見積もりをお知らせください。よろしくお願いいたします。"),
  row("r_bank", "金融機関へ:抵当権抹消書類の依頼", "bank", "c_mortgage",
    "ご担当者様\n\nいつもお世話になっております。{{会社名}}の{{担当者名}}です。\n下記の物件の売却にともない、抵当権抹消の書類のご準備をお願いいたします。\n\n物件:{{物件名}}\n所在:{{所在}}\n地番:{{地番}}\n所有者:{{売主名}}\n決済日時:{{決済日時}}\n決済場所:{{決済場所}}\n\nお手続きに必要なものと、お受け取りの方法をお知らせください。よろしくお願いいたします。"),
  row("r_management", "管理会社へ:重要事項調査報告書と精算額の依頼", "management", "s_management_report",
    "{{管理会社名}}\nご担当者様\n\nいつもお世話になっております。{{会社名}}の{{担当者名}}です。\n下記の物件の売買にともない、重要事項調査報告書の発行と、管理費等の精算額のご連絡をお願いいたします。\n\n物件:{{物件名}}\n所在:{{所在}}\n決済日:{{決済日}}\n\n発行の費用とお受け取りの方法もあわせてお知らせください。よろしくお願いいたします。"),
  row("r_seller", "売主へ:決済時の必要書類のご案内", "seller", "s_seller_docs",
    "{{売主名}} 様\n\nいつもお世話になっております。{{会社名}}の{{担当者名}}です。\n決済の日程と、当日お持ちいただくものをご案内いたします。\n\n物件:{{物件名}}\n決済日時:{{決済日時}}\n決済場所:{{決済場所}}\n\n【お持ちいただくもの】\n{{必要書類}}\n\n{{提出用リンクのご案内}}\n\nご不明な点がございましたら、お気軽にお問い合わせください。"),
  row("r_broker", "相手業者へ:精算金額の確認", "broker", "s_broker_check",
    "{{相手業者名}}\n{{相手業者担当者}} 様\n\nいつもお世話になっております。{{会社名}}の{{担当者名}}です。\n下記の取引の精算金額について、ご確認をお願いいたします。\n\n物件:{{物件名}}\n決済日時:{{決済日時}}\n売買価格:{{売買価格}}\n売主から買主へ:{{売主から買主への精算額}}\n買主から売主へ:{{買主から売主への精算額}}\n決済時のお支払額:{{決済時のお支払額}}\n\n相違がございましたらお知らせください。よろしくお願いいたします。"),
  row("r_tenant", "賃借人へ:所有者変更と賃料振込先のお知らせ", "tenant", "s_tenant_notice",
    "{{部屋番号}} {{賃借人名}} 様\n\n平素は格別のご高配を賜り、厚く御礼申し上げます。\nお借りいただいている下記の建物の所有者が変わりますので、お知らせいたします。賃料などの条件は変わりません。\n\n物件:{{物件名}}\n変更日:{{決済日}}\n新しい所有者:{{買主名}}\n\n【賃料のお振込先】\n{{賃料振込先}}\n\n変更日以降にお支払い期日が来る賃料は、上記の口座へお振り込みください。"),
];

/** 保存したひな形(空・壊れているなら初めのひな形)。 */
export function resolveRequestTemplates(raw: unknown): RequestTemplate[] {
  const r = templateListSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_REQUEST_TEMPLATES;
}

/** 段取りの項目に結びついたひな形。手入力の項目(鍵なし)には結びつかない。 */
export function templatesForItem(templates: readonly RequestTemplate[], itemKey: string | null): RequestTemplate[] {
  return itemKey === null ? [] : templates.filter((t) => t.scheduleItemKey === itemKey);
}

/** 差し込む。欠けている値・権限がない欄は空にして、どの欄がなぜ空かを返す。置き換えは1回だけ(値の中の {{ }} は展開しない)。 */
export function renderRequestDraft(body: string, values: RequestFieldValues): { text: string; blanks: RequestBlank[] } {
  const known = new Set<string>(REQUEST_FIELDS);
  const blanks = new Map<string, RequestBlankReason>();
  const text = body.replace(PLACEHOLDER, (_all, name: string) => {
    if (!known.has(name)) {
      blanks.set(name, "unknown");
      return "";
    }
    const v = values[name as RequestField] ?? { blank: "missing" as const };
    if ("value" in v) return v.value;
    blanks.set(name, v.blank);
    return "";
  });
  return {
    // 欄が空になって空行が続くときだけ詰める(管理者が書いた空行はそのまま)。
    text: blanks.size ? text.replace(/\n{3,}/g, "\n\n") : text,
    blanks: [...blanks].map(([field, reason]) => ({ field, reason })),
  };
}
