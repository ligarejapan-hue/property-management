/**
 * 除外申請(査定サイト=HOME4U・リビンマッチ・タカウル等へ「この反響は無効なので課金しないで」と
 * 申し出ること)の決まり。2026-10-24 従業員の指摘(第2弾)・発注者承認。
 * Prisma・DOM を持ち込まない純関数(画面・API・一覧の絞り込みで共有)。
 *
 * - 状態は3つ+なし: requested=申請中 / approved=除外された / rejected=認められなかった / null=申請していない。
 * - 日付は2つ(どちらも DATE): 申請した日(leadExclusionRequestedAt)・結果が出た日(leadExclusionDecidedAt)。
 * - 「申請中 N日」の N は **JST の暦日の差**(申請した日=0日)。7日以上は「運営に確認」を促す。
 * ⚠今日の日付は呼び出し側で**1回だけ**決めて渡す(1つの判定の中で時計を2回読まない)。
 */
import { parseDateOnly } from "@/lib/case-dates";

export const LEAD_EXCLUSION_STATUS_VALUES = ["requested", "approved", "rejected"] as const;
export type LeadExclusionStatus = (typeof LEAD_EXCLUSION_STATUS_VALUES)[number];

/** 日付だけの列(DATE)。変更履歴には "YYYY-MM-DD" で残す。 */
export const LEAD_EXCLUSION_DATE_FIELDS = ["leadExclusionRequestedAt", "leadExclusionDecidedAt"] as const;

export const LEAD_EXCLUSION_STATUS_LABELS: Record<LeadExclusionStatus, string> = {
  requested: "申請中",
  approved: "除外された",
  rejected: "認められなかった",
};

/** 申請してからこの日数以上たっても結果が出ていなければ「運営に確認」を促す。 */
export const LEAD_EXCLUSION_OVERDUE_DAYS = 7;

/** 一覧の絞り込み(詳細条件の「除外申請」)。空=すべて。 */
export const LEAD_EXCLUSION_FILTER_VALUES = ["requested", "requested_overdue", "approved", "rejected"] as const;
export type LeadExclusionFilter = (typeof LEAD_EXCLUSION_FILTER_VALUES)[number];

export const LEAD_EXCLUSION_FILTER_OPTIONS: { value: LeadExclusionFilter; label: string }[] = [
  { value: "requested", label: "申請中" },
  { value: "requested_overdue", label: `申請中で${LEAD_EXCLUSION_OVERDUE_DAYS}日以上` },
  { value: "approved", label: "除外された" },
  { value: "rejected", label: "認められなかった" },
];

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isLeadExclusionStatus(v: unknown): v is LeadExclusionStatus {
  return typeof v === "string" && (LEAD_EXCLUSION_STATUS_VALUES as readonly string[]).includes(v);
}

/** その瞬間の JST の暦日("YYYY-MM-DD")。端末・サーバーのタイムゾーンに左右されない。 */
export function jstTodayDateOnly(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" から n 日前の "YYYY-MM-DD"。壊れた日付は null。 */
export function shiftDateOnly(day: string, deltaDays: number): string | null {
  const d = parseDateOnly(day);
  if (!d) return null;
  return new Date(d.getTime() + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/** 申請した日から今日まで何日たったか(同じ日=0)。どちらかが無い・壊れていれば null。 */
export function leadExclusionElapsedDays(requestedOn: string | null | undefined, today: string): number | null {
  if (!requestedOn) return null;
  const a = parseDateOnly(requestedOn);
  const b = parseDateOnly(today);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export interface LeadExclusionBadge {
  text: string;
  /** 色の種類(status-badge の intent に合わせる)。 */
  intent: "warning" | "error" | "neutral";
}

/**
 * 一覧の案件ステータスの横に出す札。申請していなければ null。
 * - 申請中: 「除外申請中 N日」(琥珀)。N が 7 以上は「除外申請中 N日・運営に確認」(赤)。
 *   申請日が無い(古いデータ等)ときは「除外申請中」だけ。
 * - 除外された: 「除外済」・認められなかった: 「除外不可」(どちらも灰色)。
 */
export function leadExclusionBadge(
  status: string | null | undefined,
  requestedOn: string | null | undefined,
  today: string,
): LeadExclusionBadge | null {
  if (status === "approved") return { text: "除外済", intent: "neutral" };
  if (status === "rejected") return { text: "除外不可", intent: "neutral" };
  if (status !== "requested") return null;
  const days = leadExclusionElapsedDays(requestedOn, today);
  if (days == null) return { text: "除外申請中", intent: "warning" };
  const n = Math.max(0, days);
  if (n >= LEAD_EXCLUSION_OVERDUE_DAYS) {
    return { text: `除外申請中 ${n}日・運営に確認`, intent: "error" };
  }
  return { text: `除外申請中 ${n}日`, intent: "warning" };
}

/**
 * 一覧の絞り込みの where 断片(Prisma.PropertyWhereInput 相当)。絞らないときは null。
 * 「申請中で7日以上」= 状態が申請中 かつ 申請した日 ≦ 今日の7日前(=経過日数が7以上)。
 * ⚠申請日が無い申請中は「7日以上」に入れない(何日たったか分からない)。
 * ⚠today は呼び出し側で1回だけ決めた JST の暦日。
 */
export function buildLeadExclusionWhere(
  filter: LeadExclusionFilter | undefined,
  today: string,
): Record<string, unknown> | null {
  switch (filter) {
    case "requested":
    case "approved":
    case "rejected":
      return { leadExclusionStatus: filter };
    case "requested_overdue": {
      const limitDay = shiftDateOnly(today, -LEAD_EXCLUSION_OVERDUE_DAYS);
      const limit = limitDay ? parseDateOnly(limitDay) : null;
      if (!limit) return { leadExclusionStatus: "requested", id: { in: [] } };
      return { leadExclusionStatus: "requested", leadExclusionRequestedAt: { lte: limit } };
    }
    default:
      return null;
  }
}

/**
 * 物件詳細の「除外申請」の欄を最初から開いて出すか。
 * 導入ルートが「一括査定」(査定サイトからの反響)か、既に申請の状態が入っている物件だけ。
 * それ以外の物件は小さなリンクの奥に畳む(画面を散らかさない)。
 */
export function showsLeadExclusionBlock(introductionRoute: string | null | undefined, status: string | null | undefined): boolean {
  return introductionRoute === "bulk_assessment" || isLeadExclusionStatus(status);
}

export interface LeadExclusionFields {
  leadExclusionStatus?: LeadExclusionStatus | null;
  leadExclusionRequestedAt?: Date | null;
  leadExclusionDecidedAt?: Date | null;
}

/**
 * PATCH で送られた除外申請の値を、保存する値にそろえる(送られていなければ {} を返す)。
 * - 状態を「なし」(null)にしたら、2つの日付も消す。
 * - 申請中にしたのに申請した日が無ければ今日(JST)にする。結果の日は消す(申請し直し)。
 * - 除外された/認められなかったにしたのに結果の日が無ければ今日にする。
 *   申請した日が無ければ(申請中を経ずに結果を入れた)そのまま空でよい。
 * - 日付だけを直す送り方(状態は送らない)は、そのまま通す。
 * ⚠today は呼び出し側で1回だけ決めた JST の暦日。
 */
export function normalizeLeadExclusionPatch(
  current: { leadExclusionRequestedAt: Date | null; leadExclusionDecidedAt: Date | null },
  patch: LeadExclusionFields,
  today: string,
): LeadExclusionFields {
  const out: LeadExclusionFields = {};
  const has = (k: keyof LeadExclusionFields) => k in patch && patch[k] !== undefined;
  if (has("leadExclusionRequestedAt")) out.leadExclusionRequestedAt = patch.leadExclusionRequestedAt ?? null;
  if (has("leadExclusionDecidedAt")) out.leadExclusionDecidedAt = patch.leadExclusionDecidedAt ?? null;
  if (!has("leadExclusionStatus")) return out;

  const status = patch.leadExclusionStatus ?? null;
  const todayDate = parseDateOnly(today);
  out.leadExclusionStatus = status;
  if (status === null) {
    out.leadExclusionRequestedAt = null;
    out.leadExclusionDecidedAt = null;
    return out;
  }
  if (status === "requested") {
    const requested = has("leadExclusionRequestedAt") ? out.leadExclusionRequestedAt : current.leadExclusionRequestedAt;
    if (requested == null) out.leadExclusionRequestedAt = todayDate;
    out.leadExclusionDecidedAt = null;
    return out;
  }
  const decided = has("leadExclusionDecidedAt") ? out.leadExclusionDecidedAt : current.leadExclusionDecidedAt;
  if (decided == null) out.leadExclusionDecidedAt = todayDate;
  return out;
}
