/**
 * 通知 段階2: 件数の窓口の応答から「何を知らせるか」を決める(設計書 §5.2)。**純関数だけ**。
 *
 * - 件数の増減では判定しない。まだ見ていない印(不透明な値)が現れたときだけ知らせる
 *   (「1件完了＋1件新着」でも新着を出すため)。
 * - 見た印とカーソルは画面の保存領域に置く(中身は不透明な値だけ)。
 * - 初めて(または読み直し)の区分は、サーバーが返す `initialSeenKeys` を最初から見た扱いにする。
 */
import type { NoticeKind } from "./notice-store";

const DAY = 24 * 60 * 60 * 1000;
/** 申込・謄本の見た印は1日、次回対応(回ごと)は1週間で捨てる。 */
export const EVENT_SEEN_TTL_MS = DAY;
export const REMINDER_SEEN_TTL_MS = 7 * DAY;

export interface CursorSection {
  cursor: string | null;
  cursorAt: number | null;
  /** 見た印 → 見た時刻(ms)。 */
  seen: Record<string, number>;
}

export interface SummaryState {
  v: 1;
  nextAction: { seen: Record<string, number> };
  inquiry: CursorSection;
  registry: CursorSection;
}

/** 窓口の応答(`lib/notifications/summary.ts` の NotificationSummary と同じ形)。 */
export interface SummaryResponse {
  nextActions: { today: number; overdue: number; reminders: Array<{ key: string; slot: number }> } | null;
  inquiries: {
    open: number;
    newKeys: string[] | null;
    cursor: string | null;
    cursorAt: number | null;
    initialSeenKeys?: string[];
  } | null;
  registryJobs: {
    completed: Array<{ key: string; href: string; done: number; failed: number; skipped: number; chargedButFailed: number }>;
    cursor: string;
    cursorAt: number;
    initialSeenKeys?: string[];
  } | null;
}

export interface SummaryNotice {
  kind: Extract<NoticeKind, "next_action" | "inquiry_new" | "registry_job_done">;
  tag: string;
  title: string;
  body: string;
  url: string;
}

export const NEXT_ACTION_URL = "/home";
export const INQUIRY_URL = "/properties/sale-dm/inquiries";

export function emptySummaryState(): SummaryState {
  return {
    v: 1,
    nextAction: { seen: {} },
    inquiry: { cursor: null, cursorAt: null, seen: {} },
    registry: { cursor: null, cursorAt: null, seen: {} },
  };
}

function pruneSeen(seen: unknown, now: number, ttl: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!seen || typeof seen !== "object") return out;
  for (const [k, v] of Object.entries(seen as Record<string, unknown>)) {
    if (typeof v === "number" && now - v < ttl && /^[A-Za-z0-9_-]{1,64}$/.test(k)) out[k] = v;
  }
  return out;
}

function parseSection(v: unknown, now: number): CursorSection {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const cursor = typeof s.cursor === "string" && s.cursor.length <= 400 ? s.cursor : null;
  const cursorAt = typeof s.cursorAt === "number" && Number.isFinite(s.cursorAt) ? s.cursorAt : null;
  return { cursor: cursor && cursorAt !== null ? cursor : null, cursorAt: cursor && cursorAt !== null ? cursorAt : null, seen: pruneSeen(s.seen, now, EVENT_SEEN_TTL_MS) };
}

/** 保存値を読む。壊れていれば空から始める(期限切れの印は捨てる)。 */
export function parseSummaryState(raw: string | null, now: number): SummaryState {
  if (!raw) return emptySummaryState();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptySummaryState();
  }
  if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== 1) return emptySummaryState();
  const d = data as Record<string, unknown>;
  const na = (d.nextAction && typeof d.nextAction === "object" ? d.nextAction : {}) as Record<string, unknown>;
  return {
    v: 1,
    nextAction: { seen: pruneSeen(na.seen, now, REMINDER_SEEN_TTL_MS) },
    inquiry: parseSection(d.inquiry, now),
    registry: parseSection(d.registry, now),
  };
}

/** 次の問い合わせに付けるカーソル(無ければ付けない=初回)。 */
export function summaryQuery(state: SummaryState): string {
  const p = new URLSearchParams();
  if (state.inquiry.cursor) p.set("inquiryCursor", state.inquiry.cursor);
  if (state.registry.cursor) p.set("registryCursor", state.registry.cursor);
  return p.toString();
}

/**
 * 400(カーソルが読めない)を受けたとき: 読めなかった区分のカーソルだけを捨てて、その区分を
 * 次から初回として取り直す。もう片方は捨てない(正しい位置から続けないと、その間の新着を
 * 初回の「見た扱い」で落とすため・@codex #466 P2)。コードが分からないときだけ両方捨てる。
 */
export function resetCursors(state: SummaryState, errorCode?: string | null): SummaryState {
  const inquiry = errorCode !== "BAD_REGISTRY_CURSOR";
  const registry = errorCode !== "BAD_INQUIRY_CURSOR";
  return {
    ...state,
    inquiry: inquiry ? { cursor: null, cursorAt: null, seen: state.inquiry.seen } : state.inquiry,
    registry: registry ? { cursor: null, cursorAt: null, seen: state.registry.seen } : state.registry,
  };
}

function countText(parts: Array<[string, number]>): string {
  return parts.filter(([, n]) => n > 0).map(([label, n]) => `${label}${n}件`).join("・");
}

export function registryJobBody(j: { done: number; failed: number; skipped: number; chargedButFailed: number }): string {
  // 0件の区分は省く。要確認(課金されたが取得に失敗)があれば必ず出す(設計書 §5.1)。
  const detail = countText([
    ["成功", j.done],
    ["失敗", j.failed],
    ["要手動", j.skipped],
    ["要確認", j.chargedButFailed],
  ]);
  return detail ? `謄本の一括取得が完了しました（${detail}）` : "謄本の一括取得が完了しました";
}

export function nextActionBody(today: number, overdue: number): string {
  const parts: string[] = [];
  if (today > 0) parts.push(`今日の次回対応が${today}件`);
  if (overdue > 0) parts.push(`期限切れが${overdue}件`);
  return parts.length ? `${parts.join("、")}あります` : "次回対応があります";
}

/** カーソルは新しい方を残す(ほかのタブが先に進めていたら戻さない)。 */
function mergeCursor(sec: CursorSection, cursor: string, cursorAt: number): CursorSection {
  if (sec.cursor !== null && sec.cursorAt !== null && sec.cursorAt > cursorAt) return sec;
  return { ...sec, cursor, cursorAt };
}

export function decideSummaryNotices(
  prev: SummaryState,
  res: SummaryResponse,
  now: number,
): { state: SummaryState; notices: SummaryNotice[] } {
  const notices: SummaryNotice[] = [];
  const state: SummaryState = {
    v: 1,
    nextAction: { seen: { ...prev.nextAction.seen } },
    inquiry: { ...prev.inquiry, seen: { ...prev.inquiry.seen } },
    registry: { ...prev.registry, seen: { ...prev.registry.seen } },
  };

  // ---- 次回対応: まだ見ていない (次回対応, 期限, 版, 回) があれば1つにまとめて知らせる ----
  if (res.nextActions) {
    const fresh = res.nextActions.reminders.filter((r) => !(r.key in state.nextAction.seen));
    for (const r of res.nextActions.reminders) state.nextAction.seen[r.key] = state.nextAction.seen[r.key] ?? now;
    if (fresh.length > 0) {
      notices.push({
        kind: "next_action",
        tag: "next-action:reminder",
        title: "次回対応",
        body: nextActionBody(res.nextActions.today, res.nextActions.overdue),
        url: NEXT_ACTION_URL,
      });
    }
  }

  // ---- 査定申込 ----
  const inq = res.inquiries;
  if (!inq || inq.cursor === null || inq.cursorAt === null || inq.newKeys === null) {
    // 見られない・通知 OFF になった: カーソルを捨てる(また ON になったとき、古い位置から
    // 溜まった分をまとめて出さないため。次は初回として今から数える)。
    state.inquiry = { cursor: null, cursorAt: null, seen: state.inquiry.seen };
  } else {
    for (const k of inq.initialSeenKeys ?? []) state.inquiry.seen[k] = state.inquiry.seen[k] ?? now;
    const fresh = [...new Set(inq.newKeys.filter((k) => !(k in state.inquiry.seen)))];
    for (const k of fresh) state.inquiry.seen[k] = now;
    if (fresh.length > 0) {
      notices.push({
        kind: "inquiry_new",
        tag: "inquiry:new",
        title: "査定の申込",
        body: `新しい査定の申込が${fresh.length}件あります`,
        url: INQUIRY_URL,
      });
    }
    state.inquiry = mergeCursor(state.inquiry, inq.cursor, inq.cursorAt);
  }

  // ---- 謄本の一括取得の完了 ----
  if (!res.registryJobs) {
    state.registry = { cursor: null, cursorAt: null, seen: state.registry.seen };
  } else {
    const reg = res.registryJobs;
    for (const k of reg.initialSeenKeys ?? []) state.registry.seen[k] = state.registry.seen[k] ?? now;
    for (const j of reg.completed) {
      if (j.key in state.registry.seen) continue;
      state.registry.seen[j.key] = now;
      notices.push({
        kind: "registry_job_done",
        tag: `registry-job:${j.key}`,
        title: "謄本の一括取得",
        body: registryJobBody(j),
        url: j.href,
      });
    }
    state.registry = mergeCursor(state.registry, reg.cursor, reg.cursorAt);
  }

  return { state, notices };
}
