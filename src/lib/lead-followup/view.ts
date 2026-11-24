import { FOLLOWUP_SERIES_LABELS, type FollowupSeries } from "./steps";

/**
 * 物件の画面・査定申込の一覧に出す「追客メールの様子」(設計 2026-11-16 §6 PR2)。
 * - 宛先のアドレス・本文は出さない(件名も出さない=何通目かだけ)。
 * - この形はメールを平文で見られる利用者にだけ返す(送った記録から「メールがある」と分かるため。受付メールと同じ扱い)。
 */

export const FOLLOWUP_STOP_REASON_LABELS: Record<string, string> = {
  unsubscribed: "お客様が配信停止",
  case_closed: "案件の状態が進んだ・終わった",
  handled_done: "査定申込が対応済み",
  manual: "担当が止めた",
  send_failed: "送信に失敗",
  interrupted: "送信の途中で止まった",
  disabled: "追客メールを OFF にした",
  no_address: "メールアドレスが無くなった・変わった",
  completed: "全部送り終えた",
  duplicate_address: "同じアドレスの追客がほかにある",
  target_deleted: "物件・申込が消された",
  // 2026-11-24 物件の対象を広げたときに足した(run.ts の PropertyExclusion)
  dm_no_send: "物件が DM 送付不可",
  owner_excluded: "所有者が業者と同じ名前・自治体・国",
};

const SEND_RESULT_LABELS: Record<string, string> = { sent: "送信", skipped: "飛ばした", failed: "送れなかった" };

export type FollowupRowForView = {
  status: string;
  stopReason: string | null;
  stoppedAt: Date | null;
  stoppedBy: { name: string } | null;
  sends: Array<{ series: string; position: number; result: string; at: Date }>;
};

export type FollowupView = {
  /** none=まだ行が無い(送信の仕組みが拾う前) */
  state: "none" | "active" | "completed" | "stopped";
  label: string;
  /** 「追客を止める」を出すか */
  canStop: boolean;
  stopped: { reason: string; at: string | null; by: string | null } | null;
  /** 古い順 */
  sends: Array<{ label: string; result: string; at: string }>;
};

function seriesLabel(series: string): string {
  return FOLLOWUP_SERIES_LABELS[series as FollowupSeries] ?? "流れ";
}

export function toFollowupView(row: FollowupRowForView | null): FollowupView {
  if (!row) return { state: "none", label: "まだ送っていません", canStop: true, stopped: null, sends: [] };
  const sends = [...row.sends]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((s) => ({
      label: `${seriesLabel(s.series)} ${s.position}通目`,
      result: SEND_RESULT_LABELS[s.result] ?? s.result,
      at: s.at.toISOString(),
    }));
  if (row.status === "active" || row.status === "sending") {
    return { state: "active", label: "進行中", canStop: true, stopped: null, sends };
  }
  if (row.status === "completed") {
    return { state: "completed", label: "全部送り終えました", canStop: false, stopped: null, sends };
  }
  const reason = (row.stopReason && FOLLOWUP_STOP_REASON_LABELS[row.stopReason]) || "その他";
  return {
    state: "stopped",
    label: `止まっています(${reason})`,
    canStop: false,
    stopped: { reason, at: row.stoppedAt ? row.stoppedAt.toISOString() : null, by: row.stoppedBy?.name ?? null },
    sends,
  };
}

/**
 * 申込の一覧に付ける追客の様子(id ごと)。
 * - メールを平文で見られない人には null(受付メールの状態と同じ扱い)。
 * - 追客の行がまだ無く、始まりようのない申込(メールが無い・対応済み)にも null(一覧に何も出さない)。
 */
export function followupViewsForList(
  rows: Array<{ id: string; email: string | null; handleStatus: string; leadFollowup: FollowupRowForView | null }>,
  emailVisible: boolean,
): Map<string, FollowupView | null> {
  return new Map(
    rows.map((r) => {
      if (!emailVisible) return [r.id, null];
      if (!r.leadFollowup && (!r.email || r.handleStatus === "done")) return [r.id, null];
      return [r.id, toFollowupView(r.leadFollowup)];
    }),
  );
}

/** prisma の select(この形を toFollowupView に渡す)。 */
export const FOLLOWUP_VIEW_SELECT = {
  status: true,
  stopReason: true,
  stoppedAt: true,
  stoppedBy: { select: { name: true } },
  sends: { select: { series: true, position: true, result: true, at: true }, orderBy: { at: "asc" } },
} as const;
