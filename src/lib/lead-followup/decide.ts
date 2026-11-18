import type { FollowupSeries, FollowupStepsBySeries } from "./steps";

/**
 * 追客の1行を「今どうするか」(設計 2026-11-16 §2・§3)。DB を読まない純関数。
 * 送る時間帯・1回の上限・1アドレス1日1通・配信停止・宛先の確かめは、呼び出し側(run.ts)が別に見る。
 *
 * - 新規の流れ: 起点=登録日(査定申込は申込日)。査定申込は挨拶(0日の通)を送らない(受付メールが兼ねる)
 * - 保留になったら新規の流れは終わり、保留の流れへ(起点=保留を見つけた時刻)
 * - 保留を出たら起点を外して待つ。もう一度保留になったら、前の続きの通から、その日を新しい起点にする
 * - 日が来た通は、送れる状態なら送る・やりとり中などなら飛ばす(あとで戻っても送らない)
 * - 次の通の日も過ぎていたら、古い通は飛ばす(止まっていた間の分をまとめて送らない)
 */

const DAY_MS = 86_400_000;

/** 保留に移ったので新規の流れは終わり、の印(new_next_position に入れる)。 */
export const NEW_FLOW_ENDED_BY_HOLD = 999;

export type CaseClass = "uncontacted" | "skip" | "hold" | "closed";

const UNCONTACTED = new Set(["new_case", "contact_attempting"]);
const SKIP = new Set(["contacting_owner", "appraisal"]);
const CLOSED = new Set([
  "negotiating",
  "brokerage_obtained",
  "on_sale",
  "contract_planned",
  "contracted",
  "sold",
  "other_brokerage",
  "closed",
  "lead_exclusion_requested",
  "lead_excluded",
  "done",
]);

/** 一括査定の物件の案件の状態。今は使わない古い値・知らない値は送らない(飛ばす)。 */
export function classifyProperty(caseStatus: string): CaseClass {
  if (UNCONTACTED.has(caseStatus)) return "uncontacted";
  if (caseStatus === "hold") return "hold";
  if (CLOSED.has(caseStatus)) return "closed";
  if (SKIP.has(caseStatus)) return "skip";
  return "skip";
}

/** 査定申込の対応状況(保留は無い)。 */
export function classifyInquiry(handleStatus: string): CaseClass {
  if (handleStatus === "open") return "uncontacted";
  if (handleStatus === "done") return "closed";
  return "skip";
}

export type DecideRow = {
  targetType: "property" | "inquiry";
  newStartedAt: Date | null;
  newNextPosition: number;
  holdStartedAt: Date | null;
  holdNextPosition: number;
};

export type FollowupDecision =
  | { kind: "wait" }
  | { kind: "complete" }
  | { kind: "stop"; reason: "case_closed" | "handled_done" }
  | { kind: "update"; data: Partial<Pick<DecideRow, "newNextPosition" | "holdStartedAt">> }
  | { kind: "skip"; series: FollowupSeries; position: number }
  | { kind: "send"; series: FollowupSeries; position: number };

function dueAt(start: Date, delayDays: number): number {
  return start.getTime() + delayDays * DAY_MS;
}

/** 起点 start・次の通 position から、送る/飛ばす/待つ/終わりを決める(その流れの中だけ)。 */
function stepDecision(
  series: FollowupSeries,
  steps: FollowupStepsBySeries[FollowupSeries],
  start: Date,
  position: number,
  cls: CaseClass,
  now: Date,
  skipZeroDay: boolean,
): FollowupDecision {
  let pos = position;
  // 査定申込は 0日の通(挨拶)を数えない。印を書かずに次の通から見る。
  while (skipZeroDay && pos <= steps.length && steps[pos - 1].delayDays === 0) pos += 1;
  if (pos > steps.length) return { kind: "complete" };
  if (now.getTime() < dueAt(start, steps[pos - 1].delayDays)) return { kind: "wait" };
  const next = steps[pos];
  if (next && now.getTime() >= dueAt(start, next.delayDays)) return { kind: "skip", series, position: pos };
  return cls === "uncontacted" || cls === "hold" ? { kind: "send", series, position: pos } : { kind: "skip", series, position: pos };
}

export function decideFollowup(row: DecideRow, cls: CaseClass, steps: FollowupStepsBySeries, now: Date): FollowupDecision {
  if (cls === "closed") return { kind: "stop", reason: row.targetType === "inquiry" ? "handled_done" : "case_closed" };

  const inHoldPhase = row.newNextPosition === NEW_FLOW_ENDED_BY_HOLD;
  if (!inHoldPhase) {
    // 査定申込には保留が無い(classifyInquiry は hold を返さない)。
    if (cls === "hold") return { kind: "update", data: { newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: now } };
    const start = row.newStartedAt;
    if (!start) return { kind: "complete" };
    return stepDecision("new", steps.new, start, row.newNextPosition, cls, now, row.targetType === "inquiry");
  }

  // 保留の流れを全部終えていれば、今の状態に関わらず完了(行が進行中のまま残ると、そのアドレスの次の追客を塞ぐ)。
  if (row.holdNextPosition > steps.hold.length) return { kind: "complete" };
  if (cls !== "hold") {
    // 保留を出た: 起点を外して待つ(過ぎた日の数え直しはしない)。
    return row.holdStartedAt ? { kind: "update", data: { holdStartedAt: null } } : { kind: "wait" };
  }
  if (!row.holdStartedAt) {
    // もう一度保留になった: 前の続きの通から、今を新しい起点にする。
    return { kind: "update", data: { holdStartedAt: now } };
  }
  return stepDecision("hold", steps.hold, row.holdStartedAt, row.holdNextPosition, cls, now, false);
}

/**
 * 行を作るときの「新規の流れで最初に見る通」(2026-11-19 発注者: 今いるお客様にも送る・登録日を起点に、次に日が来る通から)。
 * - ON にした時刻より後の登録・申込は 1通目から(挨拶を含めて今までどおり)
 * - それより前からいるお客様は、登録日から数えて日が過ぎた通(ちょうど今日の通も含む)を数えず、次に日が来る通から。
 *   全部過ぎていれば「新規の流れは終わり」(保留なら保留の流れへ・そうでなければ完了)
 * 過ぎた通は送らないので、「飛ばした」の記録も残さない。
 */
export function initialNewPosition(startedAt: Date, enabledAt: Date, now: Date, steps: FollowupStepsBySeries): number {
  if (startedAt.getTime() >= enabledAt.getTime()) return 1;
  const idx = steps.new.findIndex((s) => dueAt(startedAt, s.delayDays) > now.getTime());
  return idx < 0 ? steps.new.length + 1 : idx + 1;
}
