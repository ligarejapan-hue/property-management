import { z } from "zod";
import { formatPhoneJp } from "@/lib/phone-format-jp";
import { AD_MEDIA, AD_VALUES, INQUIRY_CHANNELS, INQUIRY_KINDS, INQUIRY_STATUSES, VIEWING_TYPES } from "./constants";

/** 反響の受付の入力検証(設計 2026-09-28 §3)。 */

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
const optEmail = z.union([z.literal(""), z.string().trim().email().max(254)]).optional().nullable();

export const agentCreateSchema = z.object({
  companyName: z.string().trim().min(1, "商号を入れてください").max(100),
  companyKana: optText(100),
  branchName: optText(100),
  licenseNo: optText(60),
  phone: z.string().trim().min(1, "代表電話を入れてください").max(30),
  fax: optText(30),
  email: optEmail,
  address: optText(200),
  note: optText(2000),
});
export const agentUpdateSchema = agentCreateSchema.partial().extend({
  isArchived: z.boolean().optional(),
  version: z.number().int().positive(),
});

export const viewingCreateSchema = z.object({
  scheduledAt: z.string().datetime().optional().nullable(),
  viewingType: z.enum(VIEWING_TYPES),
  attendantId: uuid.optional().nullable(),
});
export const viewingUpdateSchema = z.object({
  scheduledAt: z.string().datetime().optional().nullable(),
  viewingType: z.enum(VIEWING_TYPES).optional(),
  attendantId: uuid.optional().nullable(),
  resultNote: optText(2000),
  canceled: z.boolean().optional(),
  version: z.number().int().positive(),
});

const contactFields = {
  contactName: optText(60),
  contactMobile: optText(30),
  contactEmail: optEmail,
};

export const inquiryCreateSchema = z
  .object({
    propertyId: uuid,
    agentId: uuid,
    ...contactFields,
    kind: z.enum(INQUIRY_KINDS),
    channel: z.enum(INQUIRY_CHANNELS).default("phone"),
    note: optText(10000),
    viewing: viewingCreateSchema.optional(),
  })
  .refine((v) => !v.viewing || v.kind === "viewing", {
    message: "内見の予定は用件が内見のときだけ入れられます",
    path: ["viewing"],
  })
  // 内見の反響には案内/下見の区別が要る(無いと時系列・件数から漏れる・@codex #454 R2 P2)。日時は空でよい。
  .refine((v) => v.kind !== "viewing" || !!v.viewing, {
    message: "案内か下見かを選んでください",
    path: ["viewing"],
  });

export const inquiryUpdateSchema = z.object({
  ...contactFields,
  status: z.enum(INQUIRY_STATUSES).optional(),
  assigneeId: uuid.optional().nullable(),
  note: optText(10000),
  version: z.number().int().positive(),
});

export const adPermissionsPutSchema = z
  .object({
    items: z
      .array(
        z.object({
          medium: z.enum(AD_MEDIA),
          value: z.enum(AD_VALUES).nullable(),
          // 画面に出ていた値(null=未設定)。今の値と違えば古い画面からの保存として止める(@codex #454 R5)。
          from: z.enum(AD_VALUES).nullable(),
        }),
      )
      .min(1)
      .max(AD_MEDIA.length),
  })
  .refine((v) => new Set(v.items.map((i) => i.medium)).size === v.items.length, {
    message: "同じ媒体が2回あります",
    path: ["items"],
  });

const blankToNull = (s: string | null | undefined): string | null | undefined => {
  if (s === undefined) return undefined;
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const phoneOrNull = (s: string | null | undefined) => {
  const v = blankToNull(s);
  return v == null ? v : formatPhoneJp(v).value;
};
/** undefined のキーは出さない(PATCH で触っていない列を null にしない)。 */
function pick<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 業者の入力を保存用に整える(電話・FAXはハイフン入り・桁不正はそのまま・空は null)。 */
export function normalizeAgentInput(a: Partial<z.infer<typeof agentCreateSchema>> & { isArchived?: boolean }) {
  return pick({
    companyName: a.companyName?.trim(),
    companyKana: blankToNull(a.companyKana),
    branchName: blankToNull(a.branchName),
    licenseNo: blankToNull(a.licenseNo),
    phone: a.phone === undefined ? undefined : formatPhoneJp(a.phone).value,
    fax: phoneOrNull(a.fax),
    email: blankToNull(a.email),
    address: blankToNull(a.address),
    note: blankToNull(a.note),
    isArchived: a.isArchived,
  });
}

/** 問い合わせ者の入力を保存用に整える(携帯はハイフン入り・空は null・触らない項目は出さない)。 */
export function normalizeInquiryContact(c: {
  contactName?: string | null;
  contactMobile?: string | null;
  contactEmail?: string | null;
}) {
  return pick({
    contactName: blankToNull(c.contactName),
    contactMobile: phoneOrNull(c.contactMobile),
    contactEmail: blankToNull(c.contactEmail),
  });
}
