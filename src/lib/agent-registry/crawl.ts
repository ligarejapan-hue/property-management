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
  /** この一巡で前に読んだときの件数。減っていたら1ページ目から読み直す(前のページへずれた会社を拾う)。 */
  totalRows: number | null;
  /** 最後に読んだページの最後の会社の免許の鍵。次のページとの境目を照らす(ずれを見つける)。 */
  lastKey: string | null;
  /** 最後に終えた一巡の名前(暦の前月ではない=1か月とばしても「前の一巡」を取り違えない・@codex #477)。 */
  lastCompletedCycle: string | null;
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
  /** 今の一巡で一覧に出た会社のうち、詳細が要るもの(3回失敗した会社を除く)を失敗の少ない順・免許の鍵の順に。 */
  nextNeedingDetail(cycle: string, limit: number): Promise<string[]>;
  /** その会社の詳細が読めなかった回数を1つ増やす(3回でその一巡は諦める=1社のせいで全体を止めない)。 */
  markDetailFailed(licenseKey: string): Promise<void>;
  /** この一巡で詳細を諦めた(3回失敗した)会社の数。多ければ先方の画面が変わったと見る。 */
  countDetailExhausted(cycle: string): Promise<number>;
  saveDetail(d: Detail, at: Date): Promise<void>;
  /**
   * この一巡とその前の一巡のどちらでも一覧に出なかった会社を「一覧に無い」にする。
   * 1巡だけ見なかった会社は消さない=ページの境目のずれで1回見落としても、まだ免許のある会社を消さない(@codex #477)。
   * 本当に免許を失った会社は、次の一巡の締めで消える(1か月遅れ)。
   */
  closeCycle(cycle: string, prevCycle: string): Promise<number>;
}

export interface StepBudget {
  deadlineMs: number;
  maxRequests: number;
  /** 先方全体の失敗のあと、次に頼むまで待つ時間(ミリ秒)。無ければ待たない(次の回にすぐ取り直す)。 */
  retryWaitMs?: number;
}

/**
 * 1回の呼び出しの既定の予算: 8分・100回(4秒あけるので実際は約6.7分で100回)。timer は10分ごと。
 * 先方全体の失敗(混雑・断られた・時間切れ等)のあとは30分あけてから取り直す(発注者 2026-10-08)。
 */
export const DEFAULT_BUDGET: StepBudget = { deadlineMs: 8 * 60 * 1000, maxRequests: 100, retryWaitMs: 30 * 60 * 1000 };

export interface StepResult {
  requests: number;
  listed: number;
  detailed: number;
  /** retry_wait=失敗のあとの30分の待ちの間(先方に頼まない)・day_off=続けて3回失敗して翌晩まで止めている */
  stopped: null | FetchFail | "budget" | "day_off" | "retry_wait" | "outside_window";
}

/** 続けて何回失敗したら、その晩は止めるか(計画 G2)。 */
export const FAIL_STREAK_LIMIT = 3;
/**
 * 一巡のうちに詳細を諦めた会社がこれを超えたら、個々の会社ではなく先方の画面が変わったと見て、
 * 晩じゅうの停止に数える(全社を3回ずつ叩き続けない)。免許を失った会社が一巡に数社あるのは普通。
 */
export const DETAIL_EXHAUSTED_LIMIT = 20;

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
    totalRows: null,
    lastKey: null,
    lastCompletedCycle: null,
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
      lastCompletedCycle: shared?.lastCompletedCycle ?? null,
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
  // dayOffUntil=この時刻までは先方に頼まない。続けて3回失敗した=翌晩まで/それより少ない=失敗から30分(待ち)。
  const resting = states[0].failStreak >= FAIL_STREAK_LIMIT;
  if (states.some((s) => s.dayOffUntil && s.dayOffUntil.getTime() > t0.getTime())) {
    return { ...result, stopped: resting ? "day_off" : "retry_wait" };
  }
  if (states.some((s) => s.dayOffUntil)) {
    // 止めていた晩が明けた=失敗の回数を数え直す(次の晩も3回まで試せる・@codex #477)。
    // 30分の待ちが明けただけなら数え直さない(待ちをはさんでも続けての失敗は3回で晩じゅう止める)。
    states = states.map((s) => ({ ...s, failStreak: resting ? 0 : s.failStreak, dayOffUntil: null }));
  }
  // 前の一巡が終わっていて月が変わったら、次の一巡を一覧の1ページ目から。
  // 前の一巡が途中なら、月が変わってもまずそれを終わらせる(締めを飛ばさない)。
  const current = cycleOf(t0);
  if (states.every((s) => s.phase === "done") && states[0].cycle !== current) {
    states = states.map((s) => ({
      ...s,
      ...freshState(s.authority, current),
      failStreak: s.failStreak,
      lastCompletedCycle: s.lastCompletedCycle,
    }));
  }
  const cycle = states[0].cycle;

  const startRequests = client.requestCount;
  let succeeded = false;
  /** その会社だけの詳細の失敗で止めた(晩じゅうの停止には数えない)。 */
  let rowLocalFail: FetchFail | null = null;
  /** この回ですでに一覧を読んだ行政庁(再開の境目の照らし直しは、行政庁ごとに1回だけ)。 */
  const resumed = new Set<string>();

  /** 1ページ目から読み直す(前のページへずれた会社を取りこぼさない)。 */
  const rewind = (s: CrawlState, page: { pages: number; total: number }) => {
    s.nextPage = 1;
    s.totalPages = page.pages;
    s.totalRows = page.total;
    s.lastKey = null;
  };

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
        let p = s.nextPage;
        // ⚠成功と数えるのは下の確かめが通ってから(おかしな一覧を成功と数えると、続けての失敗が3回に
        // 届かず、その晩じゅう先方を叩き続ける・@codex #477)。
        // 前の会社が消えると後ろの会社が読み終えたページへずれる。そのまま進むと、ずれた会社をこの一巡で
        // 見ないまま締めで「一覧に無い」にしてしまう。見つけ方は3つ(@codex #477):
        //  (a) 件数が減った(ページ数が同じでも)、続きのページがもう無い → 1ページ目から
        //  (b) 再開(前の回からの続き)のときは、まず前のページを読み直し、最後の会社が前に読んだときと
        //      同じかを照らす。違えば(消えた会社と増えた会社で件数が同じでも)1ページ目から
        //  (c) 次のページの先頭が前のページの最後より進んでいなければ1ページ目から
        // 先方のデータの更新は月2回ほど=読み直しはまれ。
        if (p > 1 && !resumed.has(s.authority) && s.lastKey) {
          const prev = p - 1 === 1 ? await client.searchFirst(s.authority) : await client.selectPage(s.authority, p - 1);
          if (prev.total === 0) throw new FetchError("layout");
          const boundary = prev.rows[prev.rows.length - 1]?.licenseKey ?? null;
          if (prev.page !== p - 1 || boundary !== s.lastKey || prev.total !== s.totalRows) {
            succeeded = true;
            rewind(s, prev);
            await store.saveStates(states);
            resumed.add(s.authority);
            continue;
          }
        }
        resumed.add(s.authority);
        const page = p === 1 ? await client.searchFirst(s.authority) : await client.selectPage(s.authority, p);
        // 対象の5つの行政庁はどれも数千社以上ある。0件=メンテナンス画面など。そのまま進めると
        // 一巡の締めで全社を「一覧に無い」にしてしまうので、推測せず止める(計画 G3)。
        if (page.total === 0) throw new FetchError("layout");
        const shrank = p > 1 && s.totalRows !== null && page.total < s.totalRows;
        const firstKey = page.rows[0]?.licenseKey ?? null;
        // ⚠同じ会社(=)は正常: 事務所の多い会社は行がページの境目をまたぐ(前のページの最後と次のページの
        // 先頭が同じ会社)。等しいのを戻りと見なすと、その境目で永久に読み直す(@codex #477 P1)。
        const regressed = p > 1 && s.lastKey !== null && firstKey !== null && firstKey < s.lastKey;
        if (shrank || p > page.pages || regressed) {
          succeeded = true;
          rewind(s, page);
          await store.saveStates(states);
          continue;
        }
        // 頼んだページと違うページが返った=先方の画面の変化。推測で進めない(計画 G3)。
        if (page.page !== p) throw new FetchError("layout");
        succeeded = true;
        result.listed += await store.upsertListRows(page.rows, cycle);
        s.totalPages = page.pages;
        s.totalRows = page.total;
        s.lastKey = page.rows[page.rows.length - 1]?.licenseKey ?? s.lastKey;
        if (p >= page.pages) s.phase = "detail";
        else s.nextPage = p + 1;
        p = s.nextPage;
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
        let d: Detail;
        try {
          d = await client.detail(key);
        } catch (e) {
          // 読めない画面・200 以外(429/5xx を除く)はその会社のせいの可能性が高い=その会社に数える。
          // 混雑(429/5xx)・時間切れ・つながらないは先方全体の都合なので数えない。どちらもこの回は止める。
          if (e instanceof FetchError && (e.kind === "layout" || e.kind === "http_other")) {
            await store.markDetailFailed(key);
            // その会社だけの失敗は晩じゅうの停止に数えない(数えると、読めない会社1社ごとに1晩失う・@codex #477)。
            // ただし諦めた会社が多すぎるときは先方の画面が変わったと見て、全体の失敗として扱う。
            if ((await store.countDetailExhausted(cycle)) < DETAIL_EXHAUSTED_LIMIT) {
              rowLocalFail = e.kind;
              result.stopped = e.kind;
              break;
            }
          }
          throw e;
        }
        succeeded = true;
        await store.saveDetail(d, now());
        result.detailed++;
        continue;
      }
      // 一覧も詳細も終わった=一巡の締め(5つの行政庁すべての一覧を最後まで終えているときだけ)。
      if (states.some((x) => x.phase === "detail")) {
        // 「前の一巡」=最後に終えた一巡(初回は今の一巡=この一巡で見た会社だけが正)。
        await store.closeCycle(cycle, states[0].lastCompletedCycle ?? cycle);
        for (const x of states) {
          x.phase = "done";
          x.lastCompletedCycle = cycle;
        }
      }
      break;
    }
    states = states.map((x) => ({
      ...x,
      failStreak: succeeded ? 0 : x.failStreak,
      dayOffUntil: null,
      lastError: rowLocalFail ?? x.lastError,
      lastRunAt: now(),
    }));
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    if (e.kind === "outside_window" || e.kind === "budget") {
      // client が「夜間の外」「予算切れ」で頼む前に止めた=先方の失敗ではない。失敗に数えず、次の回に続きから。
      states = states.map((x) => ({ ...x, failStreak: succeeded ? 0 : x.failStreak, lastRunAt: now() }));
      await store.saveStates(states);
      return { ...result, requests: client.requestCount - startRequests, stopped: e.kind };
    }
    // この回の中で一度でも成功していれば、続けての失敗は数え直し(とびとびの失敗では止めない)。
    const streak = (succeeded ? 0 : states[0].failStreak) + 1;
    // 続けて3回で翌晩まで止める。それより少なければ、30分あけてから取り直す(混んでいる先方を10分おきに叩かない)。
    const dayOffUntil =
      streak >= FAIL_STREAK_LIMIT
        ? nextNightStart(now())
        : budget.retryWaitMs
          ? new Date(now().getTime() + budget.retryWaitMs)
          : null;
    states = states.map((x) => ({ ...x, failStreak: streak, dayOffUntil, lastError: e.kind, lastRunAt: now() }));
    result.stopped = e.kind;
  }
  await store.saveStates(states);
  result.requests = client.requestCount - startRequests;
  return result;
}
