export interface TimelineViewing {
  id: string;
  scheduledAt: Date | null;
  viewingType: "guided" | "preview";
  canceledAt: Date | null;
  attendant?: { name: string } | null;
  resultNote?: string | null;
}
export interface TimelineInquiry {
  id: string;
  kind: "viewing" | "ad_permission" | "material_request";
  receivedAt: Date;
  status: string;
  agent: { companyName: string };
  contactName: string | null;
  viewings: TimelineViewing[];
}
export interface TimelineEntry {
  key: string;
  at: Date;
  inquiryId: string;
  kind: TimelineInquiry["kind"];
  viewingType: TimelineViewing["viewingType"] | null;
  agentName: string;
  contactName: string | null;
  attendantName: string | null;
  resultNote: string | null;
  canceled: boolean;
  unscheduled: boolean;
}

/** 物件の時系列に出す最大行数。上限は並べた後にかける(受けた日時で先に切ると、古く受けた反響の
 *  新しい内見の予定が落ちる・@codex #454 R3)。 */
export const TIMELINE_LIMIT = 500;

/**
 * 物件の時系列(設計 §2.3)。内見は予定1件=1行・予定日時で並べる。それ以外の用件と
 * 予定の無い内見の反響は受けた日時で。日程未定の内見は受けた日時の位置に置く。新しい順。
 */
export function buildPropertyTimeline(inquiries: TimelineInquiry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const q of inquiries) {
    const base = { inquiryId: q.id, kind: q.kind, agentName: q.agent.companyName, contactName: q.contactName };
    if (q.kind === "viewing" && q.viewings.length > 0) {
      for (const v of q.viewings) {
        out.push({
          ...base,
          key: `viewing:${v.id}`,
          at: v.scheduledAt ?? q.receivedAt,
          viewingType: v.viewingType,
          attendantName: v.attendant?.name ?? null,
          resultNote: v.resultNote ?? null,
          canceled: v.canceledAt != null,
          unscheduled: v.scheduledAt == null,
        });
      }
    } else {
      out.push({
        ...base,
        key: `inquiry:${q.id}`,
        at: q.receivedAt,
        viewingType: null,
        attendantName: null,
        resultNote: null,
        canceled: false,
        unscheduled: false,
      });
    }
  }
  return out
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key))
    .slice(0, TIMELINE_LIMIT);
}

/** 件数(案内/下見は取り消しを除く)。 */
export function countInquiries(inquiries: Pick<TimelineInquiry, "kind" | "viewings">[]) {
  let guided = 0;
  let preview = 0;
  let materialRequest = 0;
  let adPermission = 0;
  for (const q of inquiries) {
    if (q.kind === "material_request") materialRequest++;
    if (q.kind === "ad_permission") adPermission++;
    for (const v of q.viewings) {
      if (v.canceledAt) continue;
      if (v.viewingType === "guided") guided++;
      else preview++;
    }
  }
  return { total: inquiries.length, guided, preview, materialRequest, adPermission };
}

/**
 * 物件画面の件数を集計クエリ(groupBy)の結果から組み立てる。時系列は新しい500件までしか
 * 読まないため、件数をそこから数えると古い分が抜ける(@codex #454 P2)。
 * viewingGroups は取り消していない内見だけを数えた結果を渡す。
 */
export function countsFromGroups(
  kindGroups: { kind: TimelineInquiry["kind"]; _count: { _all: number } }[],
  viewingGroups: { viewingType: TimelineViewing["viewingType"]; _count: { _all: number } }[],
) {
  const byKind = (k: TimelineInquiry["kind"]) => kindGroups.find((g) => g.kind === k)?._count._all ?? 0;
  const byType = (t: TimelineViewing["viewingType"]) =>
    viewingGroups.find((g) => g.viewingType === t)?._count._all ?? 0;
  return {
    total: kindGroups.reduce((n, g) => n + g._count._all, 0),
    guided: byType("guided"),
    preview: byType("preview"),
    materialRequest: byKind("material_request"),
    adPermission: byKind("ad_permission"),
  };
}
