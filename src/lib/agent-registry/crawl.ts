import { FetchError, type FetchFail, type RegistryClient } from "./client";
import type { Detail, ListRow } from "./parse";

/**
 * 国交省の業者一覧を集める進め方(計画 Task 4)。timer から1回呼ばれるたびに、予算(時間・回数)の
 * 範囲だけ進めて、進み具合を保存する。途中で止まっても次の回は続きから。
 *
 * 一巡(月ごと)の流れ: 5つの行政庁の一覧を全ページ → 詳細が要る会社を1社ずつ → 一巡の締め
 * (その一巡で一度も一覧に出なかった会社を「一覧に無い」にする)。
 * 締めは5つの行政庁すべての一覧を最後まで終えたときだけ=途中で止まった一巡では消さない。
 */

/** 国土交通大臣・東京都・神奈川県・埼玉県・千葉県(発注者決定 D1)。 */
export const AUTHORITIES = ["00", "13", "14", "11", "12"] as const;

export type CrawlPhase = "list" | "detail" | "done";

export interface CrawlState {
  authority: string;
  cycle: string;
  phase: CrawlPhase;
  nextPage: number;
  totalPages: number | null;
  failStreak: number;
  dayOffUntil: Date | null;
  lastError: string | null;
  lastRunAt: Date | null;
}

export interface CrawlStore {
  loadStates(): Promise<CrawlState[]>;
  saveStates(states: CrawlState[]): Promise<void>;
  /** 一覧の行を入れる。新しい会社・商号/所在地/免許の表示が変わった会社は詳細を取り直す印を付ける。 */
  upsertListRows(rows: ListRow[], cycle: string): Promise<number>;
  /** 今の一巡で一覧に出た会社のうち、詳細が要るものを免許の鍵の順に。 */
  nextNeedingDetail(cycle: string, limit: number): Promise<string[]>;
  saveDetail(d: Detail, at: Date): Promise<void>;
  /** その一巡で一度も一覧に出なかった会社を「一覧に無い」にする。 */
  closeCycle(cycle: string): Promise<number>;
}

export interface StepBudget {
  deadlineMs: number;
  maxRequests: number;
}

/** 1回の呼び出しの既定の予算: 8分・100回(4秒あけるので実際は約6.7分で100回)。timer は10分ごと。 */
export const DEFAULT_BUDGET: StepBudget = { deadlineMs: 8 * 60 * 1000, maxRequests: 100 };

export interface StepResult {
  requests: number;
  listed: number;
  detailed: number;
  stopped: null | FetchFail | "budget" | "day_off" | "outside_window";
}

/** 続けて何回失敗したら、その晩は止めるか(計画 G2)。 */
export const FAIL_STREAK_LIMIT = 3;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間 22:00〜翌7:00 だけ動く(計画 G1)。 */
export function inNightWindow(now: Date): boolean {
  const h = new Date(now.getTime() + JST_OFFSET_MS).getUTCHours();
  return h >= 22 || h < 7;
}

/** 一巡の名前=日本時間の年月 "YYYY-MM"。 */
export function cycleOf(now: Date): string {
  const d = new Date(now.getTime() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 次の晩の始まり(日本時間 22:00)。今が 23 時なら翌日の 22 時、深夜 3 時ならその日の 22 時。 */
export function nextNightStart(now: Date): Date {
  const d = new Date(now.getTime() + JST_OFFSET_MS);
  const today22 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22) - JST_OFFSET_MS;
  return new Date(today22 > now.getTime() ? today22 : today22 + DAY_MS);
}

function freshState(authority: string, cycle: string): CrawlState {
  return {
    authority,
    cycle,
    phase: "list",
    nextPage: 1,
    totalPages: null,
    failStreak: 0,
    dayOffUntil: null,
    lastError: null,
    lastRunAt: null,
  };
}

/** 5つの行政庁の行をそろえ、行政庁の順に並べる。足りない行は今の一巡の一覧の1ページ目から。 */
function alignStates(loaded: CrawlState[], now: Date): CrawlState[] {
  const cycle = loaded[0]?.cycle ?? cycleOf(now);
  const shared = loaded[0];
  return AUTHORITIES.map((a) => {
    const s = loaded.find((x) => x.authority === a);
    if (s) return { ...s };
    return {
      ...freshState(a, cycle),
      failStreak: shared?.failStreak ?? 0,
      dayOffUntil: shared?.dayOffUntil ?? null,
    };
  });
}

export async function crawlStep(deps: {
  client: RegistryClient;
  store: CrawlStore;
  now: () => Date;
  budget: StepBudget;
}): Promise<StepResult> {
  const { client, store, now, budget } = deps;
  const t0 = now();
  const result: StepResult = { requests: 0, listed: 0, detailed: 0, stopped: null };
  if (!inNightWindow(t0)) return { ...result, stopped: "outside_window" };

  let states = alignStates(await store.loadStates(), t0);
  if (states.some((s) => s.dayOffUntil && s.dayOffUntil.getTime() > t0.getTime())) {
    return { ...result, stopped: "day_off" };
  }
  // 前の一巡が終わっていて月が変わったら、次の一巡を一覧の1ページ目から。
  // 前の一巡が途中なら、月が変わってもまずそれを終わらせる(締めを飛ばさない)。
  const current = cycleOf(t0);
  if (states.every((s) => s.phase === "done") && states[0].cycle !== current) {
    states = states.map((s) => ({ ...s, ...freshState(s.authority, current), failStreak: s.failStreak }));
  }
  const cycle = states[0].cycle;

  const startRequests = client.requestCount;
  let succeeded = false;

  const stopReason = (): StepResult["stopped"] => {
    const t = now();
    if (!inNightWindow(t)) return "outside_window";
    if (client.requestCount - startRequests >= budget.maxRequests) return "budget";
    if (t.getTime() - t0.getTime() >= budget.deadlineMs) return "budget";
    return null;
  };

  try {
    for (;;) {
      const s = states.find((x) => x.phase === "list");
      if (s) {
        const stop = stopReason();
        if (stop) {
          result.stopped = stop;
          break;
        }
        const p = s.nextPage;
        const page = p === 1 ? await client.searchFirst(s.authority) : await client.selectPage(s.authority, p);
        succeeded = true;
        // 頼んだページと違うページが返った=先方の画面の変化。推測で進めない(計画 G3)。
        if (page.pages > 0 && page.page !== p) throw new FetchError("layout");
        result.listed += await store.upsertListRows(page.rows, cycle);
        s.totalPages = page.pages;
        if (page.pages === 0 || p >= page.pages) s.phase = "detail";
        else s.nextPage = p + 1;
        await store.saveStates(states);
        continue;
      }
      const [key] = await store.nextNeedingDetail(cycle, 1);
      if (key) {
        const stop = stopReason();
        if (stop) {
          result.stopped = stop;
          break;
        }
        const d = await client.detail(key);
        succeeded = true;
        await store.saveDetail(d, now());
        result.detailed++;
        continue;
      }
      // 一覧も詳細も終わった=一巡の締め(5つの行政庁すべての一覧を最後まで終えているときだけ)。
      if (states.some((x) => x.phase === "detail")) {
        await store.closeCycle(cycle);
        for (const x of states) x.phase = "done";
      }
      break;
    }
    states = states.map((x) => ({
      ...x,
      failStreak: succeeded ? 0 : x.failStreak,
      dayOffUntil: null,
      lastRunAt: now(),
    }));
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    // この回の中で一度でも成功していれば、続けての失敗は数え直し(とびとびの失敗では止めない)。
    const streak = (succeeded ? 0 : states[0].failStreak) + 1;
    const dayOffUntil = streak >= FAIL_STREAK_LIMIT ? nextNightStart(now()) : null;
    states = states.map((x) => ({ ...x, failStreak: streak, dayOffUntil, lastError: e.kind, lastRunAt: now() }));
    result.stopped = e.kind;
  }
  await store.saveStates(states);
  result.requests = client.requestCount - startRequests;
  return result;
}
