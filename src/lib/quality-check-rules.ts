/**
 * 品質チェックの決まり(1か所の定義・2026-11-08)。
 *
 * 品質チェック(`/api/properties/quality-check`)と、物件一覧の「警告ありのみ」
 * (`property-list-query.ts` の hasWarning)は**この表だけ**を見る。以前は一覧側に同じ条件を
 * 手で書き写していたため、決まりを足すと片方だけ変わる恐れがあった(発注者指示でまとめた)。
 *
 * where はそれぞれ「その問題を持つ物件」の条件。アーカイブの除外・見える範囲は呼び出し側で足す。
 * ⚠所有者は relation の条件だけで使い、氏名などの列は読まない。
 * ⚠呼び出し側は固定の表(QUALITY_RULES)を直接回さず、`qualityRules(ctx)` を使う(外字の決まりが抜けるため・2026-11-13)。
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

/** 所有者に読めない字(外字)がある(2026-11-13 発注者)。 */
export const OWNER_GAIJI_CODE = "OWNER_GAIJI";

/**
 * 決まりのうち、毎回 DB から読む部分。
 * 外字(私用領域の字)は Prisma の条件では書けない(正規表現が無い)ため、`loadQualityContext`
 * (src/lib/quality-check-context.ts)が SQL で該当の所有者を探し、ここでは「その所有者がつながる物件」の条件にする。
 * ⚠物件の id の条件にはしない: 品質チェックの一覧バッジ用(?propertyIds=)は各決まりに `id: { in: 表示中 }` を
 *   上書きで足すので、id で書くと外字の条件が消えて表示中の物件が全部当たってしまう。
 */
export interface QualityContext {
  /** 名前・登記上の住所・現住所のどれかに外字がある所有者(保管していない)の id */
  gaijiOwnerIds: readonly string[];
}

/**
 * その時点の決まりの全部(固定の表 + 外字)。品質チェックと一覧の「警告ありのみ」はこれだけを見る。
 * 外字は警告: DM は名前か実際に刷る住所に外字がある宛先を自動で外す(src/lib/dm-batch/agent-name-exclusion.ts)ので、
 * □ のまま送ってしまう恐れはない(現住所が入っていて登記上の住所だけに外字がある人は、刷らないので外さない)。
 */
export function qualityRules(ctx: QualityContext): QualityRule[] {
  return [
    ...QUALITY_RULES,
    {
      code: OWNER_GAIJI_CODE,
      severity: "warning",
      message: "所有者の名前か住所に読めない字（外字）があります",
      where: { propertyOwners: { some: { ownerId: { in: [...ctx.gaijiOwnerIds] } } } },
    },
  ];
}

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
export function qualityWarningWhere(ctx: QualityContext): Prisma.PropertyWhereInput {
  return { OR: qualityRules(ctx).filter((r) => r.severity !== "info").map((r) => r.where) };
}
