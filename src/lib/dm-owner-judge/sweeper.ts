/**
 * DM判断の自動仕分けの見回り(2026-11-14 発注者決定)。サーバーの中で1分おきに回る(instrumentation.ts から起動)。
 * 1. 所有者が入っていない物件: 送付可→未判断+所有者待ちの印/未判断→印(service.processOwnerless)
 * 2. 所有者待ちの印があって所有者が入った物件: 送付可/送付不可に仕分け(service.judgeWithOwners)
 * 3. 送付可なのに業者の名簿と同じ名前の所有者がいる物件: 送付不可に(service.demoteAgentNameSend・2026-11-16 発注者)。
 *    照会が重い(国交省の一覧 約5万行の名前をそろえる)ので10分おき。
 * 仕事があった回は5秒後に続け、無ければ1分待つ。止める: app.env に `DM_OWNER_AUTO=off` を足して restart。
 */

import prisma from "@/lib/prisma";
import { processOwnerless, judgeWithOwners, demoteAgentNameSend, REGISTRY_OWNER_MISMATCH_OPEN } from "./service";
import { findSendPropertiesWithAgentNameOwners } from "@/lib/dm-batch/agent-name-exclusion";

const OWNERLESS_BATCH = 200;
const JUDGE_BATCH = 50;
const AGENT_SEND_BATCH = 50;
/** 業者と同じ名前の送付可を探す間隔(照会が重いので毎分は回さない)。 */
export const AGENT_SEND_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 業者と同じ名前の送付可を、今探すか。前の回が上限まで見つけて、しかも1件でも直せたら(まだ残っている)続けて探す。
 * ⚠直せなかった(編集中・失敗)だけの回は続けない=同じ重い照会を毎分くり返さない(内部レビュー P3)。
 */
export function agentScanDue(
  state: { lastAt: number | null; lastFull: boolean; progressed: boolean },
  now: number,
): boolean {
  if (state.lastAt === null || (state.lastFull && state.progressed)) return true;
  return now - state.lastAt >= AGENT_SEND_SCAN_INTERVAL_MS;
}

type Env = Record<string, string | undefined>;

export function shouldStartDmOwnerSweep(env: Env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  return (env.DM_OWNER_AUTO ?? "").trim().toLowerCase() !== "off";
}

/** 所有者が入っていない物件のうち、書くことがあるもの。 */
export function ownerlessWhere() {
  return {
    isArchived: false,
    propertyOwners: { none: {} },
    OR: [
      { dmStatus: "send" as const },
      { dmStatus: "hold" as const, dmOwnerPending: false },
      { dmStatus: "no_send" as const, dmOwnerPending: true },
    ],
  };
}

/** 所有者待ちの印があって所有者が入った物件(名義の確認待ちは除く=毎回拾って詰まらせない)。 */
export function judgeWhere() {
  return {
    isArchived: false,
    dmOwnerPending: true,
    propertyOwners: { some: {} },
    NOT: REGISTRY_OWNER_MISMATCH_OPEN,
  };
}

export interface SweepDeps {
  listOwnerless: (take: number) => Promise<string[]>;
  listJudge: (take: number) => Promise<string[]>;
  processOwnerless: (id: string) => Promise<string>;
  judge: (id: string) => Promise<{ outcome: string }>;
  /** 送付可なのに業者と同じ名前の所有者がいる物件(探す時でなければ空を返す) */
  listAgentSend?: (take: number) => Promise<string[]>;
  demoteAgentSend?: (id: string) => Promise<string>;
}

export interface SweepResult {
  ownerless: Record<string, number>;
  judged: Record<string, number>;
  agentSend: Record<string, number>;
  /** 何か書いたか(続けて回すか) */
  worked: boolean;
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

export async function runDmOwnerSweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const res: SweepResult = { ownerless: {}, judged: {}, agentSend: {}, worked: false };
  for (const id of await deps.listOwnerless(OWNERLESS_BATCH)) {
    try {
      const o = await deps.processOwnerless(id);
      bump(res.ownerless, o);
      if (o === "changed" || o === "marked" || o === "unmarked") res.worked = true;
    } catch (err) {
      bump(res.ownerless, "error");
      console.error(`[dm-owner-auto] ownerless failed property=${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const id of await deps.listJudge(JUDGE_BATCH)) {
    try {
      const { outcome } = await deps.judge(id);
      bump(res.judged, outcome);
      if (outcome === "send" || outcome === "no_send" || outcome === "unmarked") res.worked = true;
    } catch (err) {
      bump(res.judged, "error");
      console.error(`[dm-owner-auto] judge failed property=${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (deps.listAgentSend && deps.demoteAgentSend) {
    for (const id of await deps.listAgentSend(AGENT_SEND_BATCH)) {
      try {
        const o = await deps.demoteAgentSend(id);
        bump(res.agentSend, o);
        if (o === "no_send") res.worked = true;
      } catch (err) {
        bump(res.agentSend, "error");
        console.error(`[dm-owner-auto] agent-name failed property=${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return res;
}

const STARTED = Symbol.for("pm.dmOwnerSweep.started");

/** サーバー起動時に1回だけ呼ぶ。二重に呼ばれても見回りは1本。 */
export function startDmOwnerSweep(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTED]) return;
  g[STARTED] = true;
  const agentScan = { lastAt: null as number | null, lastFull: false, progressed: false };
  const deps: SweepDeps = {
    listOwnerless: async (take) =>
      (await prisma.property.findMany({ where: ownerlessWhere(), select: { id: true }, orderBy: { id: "asc" }, take })).map(
        (r) => r.id,
      ),
    listJudge: async (take) =>
      (
        await prisma.property.findMany({ where: judgeWhere(), select: { id: true }, orderBy: { updatedAt: "asc" }, take })
      ).map((r) => r.id),
    processOwnerless,
    judge: judgeWithOwners,
    listAgentSend: async (take) => {
      const now = Date.now();
      if (!agentScanDue(agentScan, now)) return [];
      const ids = await findSendPropertiesWithAgentNameOwners(prisma, take);
      agentScan.lastAt = now;
      agentScan.lastFull = ids.length >= take;
      agentScan.progressed = false;
      return ids;
    },
    demoteAgentSend: async (id) => {
      const o = await demoteAgentNameSend(id);
      if (o === "no_send") agentScan.progressed = true;
      return o;
    },
  };
  const tick = async () => {
    let worked = false;
    try {
      const r = await runDmOwnerSweepOnce(deps);
      worked = r.worked;
      if (worked) {
        console.log(
          `[dm-owner-auto] ownerless=${JSON.stringify(r.ownerless)} judged=${JSON.stringify(r.judged)} agentSend=${JSON.stringify(r.agentSend)}`,
        );
      }
    } catch (err) {
      console.error(`[dm-owner-auto] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const t = setTimeout(tick, worked ? 5_000 : 60_000);
    t.unref?.();
  };
  const t = setTimeout(tick, 90_000);
  t.unref?.();
}
