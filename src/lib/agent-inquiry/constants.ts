/** 反響の受付の値の一覧(設計 2026-09-28 §1)。Prisma enum と同じ並び。 */
export const INQUIRY_KINDS = ["viewing", "ad_permission", "material_request"] as const;
export const INQUIRY_CHANNELS = ["phone", "email", "fax"] as const;
export const INQUIRY_STATUSES = ["open", "in_progress", "done"] as const;
export const VIEWING_TYPES = ["guided", "preview"] as const;
export const AD_MEDIA = ["own_site", "athome", "suumo", "homes", "other_portal", "flyer"] as const;
export const AD_VALUES = ["ok", "ng", "ask"] as const;

export type InquiryKind = (typeof INQUIRY_KINDS)[number];
export type AdMediumKey = (typeof AD_MEDIA)[number];
export type AdValueKey = (typeof AD_VALUES)[number];

export const INQUIRY_KIND_LABELS: Record<InquiryKind, string> = {
  viewing: "内見",
  ad_permission: "広告の許可",
  material_request: "資料請求",
};
export const AD_MEDIUM_LABELS: Record<AdMediumKey, string> = {
  own_site: "自社HP",
  athome: "at home",
  suumo: "SUUMO",
  homes: "HOME'S",
  other_portal: "その他のポータル",
  flyer: "チラシ",
};
