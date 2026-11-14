/**
 * DM判断の自動仕分けの見回り(2026-11-14 発注者決定)。サーバーの中で1分おきに回る(instrumentation.ts から起動)。
 * 1. 所有者が入っていない物件: 送付可→未判断+所有者待ちの印/未判断→印(service.processOwnerless)
 * 2. 所有者待ちの印があって所有者が入った物件: 送付可/送付不可に仕分け(service.judgeWithOwners)
 * 仕事があった回は5秒後に続け、無ければ1分待つ。止める: app.env に `DM_OWNER_AUTO=off` を足して restart。
 */

import prisma from "@/lib/prisma";
import { processOwnerless, judgeWithOwners, REGISTRY_OWNER_MISMATCH_OPEN } from "./service";

const OWNERLESS_BATCH = 200;
const JUDGE_BATCH = 50;

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
}

export interface SweepResult {
  ownerless: Record<string, number>;
  judged: Record<string, number>;
  /** 何か書いたか(続けて回すか) */
  worked: boolean;
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

export async function runDmOwnerSweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const res: SweepResult = { ownerless: {}, judged: {}, worked: false };
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
  return res;
}

const STARTED = Symbol.for("pm.dmOwnerSweep.started");

/** サーバー起動時に1回だけ呼ぶ。二重に呼ばれても見回りは1本。 */
export function startDmOwnerSweep(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTED]) return;
  g[STARTED] = true;
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
  };
  const tick = async () => {
    let worked = false;
    try {
      const r = await runDmOwnerSweepOnce(deps);
      worked = r.worked;
      if (worked) console.log(`[dm-owner-auto] ownerless=${JSON.stringify(r.ownerless)} judged=${JSON.stringify(r.judged)}`);
    } catch (err) {
      console.error(`[dm-owner-auto] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const t = setTimeout(tick, worked ? 5_000 : 60_000);
    t.unref?.();
  };
  const t = setTimeout(tick, 90_000);
  t.unref?.();
}
