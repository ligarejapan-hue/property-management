/**
 * 品質チェックの決まり(1か所の定義・2026-11-08)。
 *
 * 品質チェック(`/api/properties/quality-check`)と、物件一覧の「警告ありのみ」
 * (`property-list-query.ts` の hasWarning)は**この表だけ**を見る。以前は一覧側に同じ条件を
 * 手で書き写していたため、決まりを足すと片方だけ変わる恐れがあった(発注者指示でまとめた)。
 *
 * where はそれぞれ「その問題を持つ物件」の条件。アーカイブの除外・見える範囲は呼び出し側で足す。
 * ⚠所有者は relation の条件だけで使い、氏名などの列は読まない。
 */
import type { Prisma } from "@/generated/prisma";

export type QualitySeverity = "error" | "warning" | "info";

export interface QualityRule {
  code: string;
  severity: QualitySeverity;
  message: string;
  where: Prisma.PropertyWhereInput;
}

/**
 * 謄本の名義の確認で「違う」となり、まだ判断していない(このままでよい でない)・比べ直し待ちでもない。
 * 「登記取得済だが」=登記状況が取得済の物件だけ(2026-11-08 発注者依頼)。
 */
const REGISTRY_OWNER_MISMATCH_WHERE: Prisma.PropertyWhereInput = {
  registryStatus: "obtained",
  registryOwnerCheck: { is: { result: "mismatch", decision: null, stale: false } },
};

export const REGISTRY_OWNER_MISMATCH_MESSAGE = "登記取得済だが、所有者が最新の謄本の名義と違う";

export const QUALITY_RULES: ReadonlyArray<QualityRule> = [
  {
    code: "NO_OWNER",
    severity: "warning",
    message: "所有者が紐付けられていません",
    where: { propertyOwners: { none: {} } },
  },
  {
    code: "REGISTRY_DM_MISMATCH",
    severity: "error",
    message: "登記未取得なのにDM送付可になっています",
    where: { registryStatus: "unconfirmed", dmStatus: "send" },
  },
  // 謄本の名義と違う(2026-11-08 発注者決定): DM が送付可ならエラー、それ以外(未判断・送付不可)は警告。
  {
    code: "REGISTRY_OWNER_MISMATCH_DM_SEND",
    severity: "error",
    message: `${REGISTRY_OWNER_MISMATCH_MESSAGE}（DM送付可）`,
    where: { ...REGISTRY_OWNER_MISMATCH_WHERE, dmStatus: "send" },
  },
  {
    code: "REGISTRY_OWNER_MISMATCH",
    severity: "warning",
    message: REGISTRY_OWNER_MISMATCH_MESSAGE,
    where: { ...REGISTRY_OWNER_MISMATCH_WHERE, dmStatus: { not: "send" } },
  },
  {
    code: "NO_LOT_NUMBER",
    severity: "info",
    message: "地番が未入力です",
    where: { OR: [{ lotNumber: null }, { lotNumber: "" }] },
  },
  // ⚠`NO_REAL_ESTATE_NUMBER`(不動産番号が未入力です)は**意図的に廃止**
  //   (2026-09-08 発注者判断=不動産番号は今後も作らない)。
  //   この指摘は「番号を入れてください」と促すが、番号が入った物件は所在検索の
  //   対象外になり、番号での取得は実サイトへ未配線 = **謄本が取れない行き止まり**
  //   になる。**システムが自ら詰む操作を勧めていた**ため、ルールごと外す。
  //   再開する場合は「番号での取得」を実サイトへ配線してからにすること。
  {
    code: "INVESTIGATION_NOT_CONFIRMED",
    severity: "warning",
    message: "調査情報が未確認です",
    where: { investigationConfirmedAt: null },
  },
  {
    code: "NO_ASSIGNEE",
    severity: "warning",
    message: "担当者が未設定です",
    where: { assignedTo: null },
  },
];

/** 謄本の名義の確認の画面。 */
export const REGISTRY_OWNER_REVIEW_HREF = "/properties/registry-owner-review";

/** 謄本の名義の確認の画面へつなぐ決まり(画面はこの印でリンクを出す)。 */
export const REGISTRY_OWNER_MISMATCH_CODES: ReadonlySet<string> = new Set([
  "REGISTRY_OWNER_MISMATCH_DM_SEND",
  "REGISTRY_OWNER_MISMATCH",
]);

/**
 * 「警告あり」= エラーか警告の決まりのどれかに当たる(情報は数えない)。
 * 品質チェックのバッジ・件数と、一覧の「警告ありのみ」で同じ条件を使う。
 */
export function qualityWarningWhere(): Prisma.PropertyWhereInput {
  return { OR: QUALITY_RULES.filter((r) => r.severity !== "info").map((r) => r.where) };
}
