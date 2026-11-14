/**
 * 調査情報の自動取得(2026-11-14 発注者「既存の物件をまとめて取る・今後は物件が作られた時点で自動で」)。
 *
 * サーバーの中で1件ずつ順に流す見回り。対象は「調査情報を一度も取っていない物件」だけ
 * (取得済み・確認済み・手で直した物件・前に失敗した物件には触らない=発注者決定)。
 * 新しく作られた物件も同じ見回りが拾う(作成の新しい順に取るので、作ってすぐ入る)。
 *
 * ⚠不動産情報ライブラリ(無料・国交省)へ1件につき8回問い合わせる。相手に負荷をかけないよう
 *   **1件ずつ・間をあけて**取る。相手が落ちていたら30分休む(落ちている間に「何も取れなかった
 *   要確認」を量産しないため)。
 * ⚠取った結果は手動の「取得」と同じ「要確認」。記録の実行者は物件を作った人(印=AUTO_FETCH_NOTE)。
 * ⚠止めるときは app.env に `INVESTIGATION_AUTO_FETCH=off` を足して restart。
 */

import prisma from "@/lib/prisma";
import { runAutoInvestigation } from "./fetch-investigation";

export const AUTO_FETCH_NOTE = "自動取得(未取得の物件の見回り)";

/** 取得中のまま、これより長く止まっている物件は取り直す(途中で restart された分)。 */
const STUCK_FETCHING_MS = 15 * 60_000;

export type AutoFetchOutcome = "done" | "idle" | "outage" | "error";

export interface AutoFetchTarget {
  id: string;
  address: string;
  lotNumber: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  createdBy: string;
}

type Env = Record<string, string | undefined>;

export function shouldStartAutoFetch(env: Env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  if ((env.INVESTIGATION_AUTO_FETCH ?? "").trim().toLowerCase() === "off") return false;
  return Boolean(env.REINFOLIB_API_KEY && env.REINFOLIB_API_KEY.trim());
}

export function autoFetchWhere(stuckBefore: Date) {
  return {
    isArchived: false,
    AND: [
      {
        OR: [
          { investigation: { is: null } },
          {
            investigation: {
              is: { status: "fetching" as const, fetchedAt: null, updatedAt: { lt: stuckBefore } },
            },
          },
        ],
      },
      {
        OR: [{ address: { not: "" } }, { gpsLat: { not: null }, gpsLng: { not: null } }],
      },
    ],
  };
}

/**
 * 取った結果(rawPayloadJson)から「相手が落ちている」かを見る。
 * - 不動産情報ライブラリ自体が失敗(住所から位置が出せなかっただけ=その物件の問題は除く)
 * - 7つの問い合わせが全部失敗
 */
export function isProviderOutage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const providers = (raw as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return false;
  const p = providers.find(
    (x): x is Record<string, unknown> => !!x && typeof x === "object" && (x as { name?: unknown }).name === "reinfolib",
  );
  if (!p) return false;
  if (p.status === "failed") {
    const err = typeof p.error === "string" ? p.error : "";
    return !err.startsWith("住所のジオコーディングに失敗しました");
  }
  const meta = p.meta as { tileErrors?: unknown } | undefined;
  return Array.isArray(meta?.tileErrors) && meta.tileErrors.length >= 7;
}

export function nextDelayMs(outcome: AutoFetchOutcome): number {
  switch (outcome) {
    case "done":
      return 3_000;
    case "outage":
      return 30 * 60_000;
    default:
      return 60_000;
  }
}

export interface AutoFetchDeps {
  pick: (stuckBefore: Date) => Promise<AutoFetchTarget | null>;
  run: typeof runAutoInvestigation;
  now: () => Date;
}

export async function runAutoFetchOnce(deps: AutoFetchDeps): Promise<AutoFetchOutcome> {
  let target: AutoFetchTarget | null;
  try {
    target = await deps.pick(new Date(deps.now().getTime() - STUCK_FETCHING_MS));
  } catch (err) {
    console.error(`[investigation-auto] pick failed: ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
  if (!target) return "idle";
  try {
    const stuckBefore = new Date(deps.now().getTime() - STUCK_FETCHING_MS);
    const outcome = await deps.run(
      target.id,
      target.createdBy,
      {
        address: target.address,
        lotNumber: target.lotNumber,
        gpsLat: target.gpsLat,
        gpsLng: target.gpsLng,
      },
      { stuckBefore, auditNote: AUTO_FETCH_NOTE, isOutage: isProviderOutage },
    );
    if (outcome === "outage") return "outage";
    // skipped / superseded = 選んだあとに手動の取得が入った。すぐ次へ進んでよい。
    return "done";
  } catch (err) {
    // ⚠住所などの個人情報はログに出さない(物件の id だけ)。
    console.error(
      `[investigation-auto] fetch failed property=${target.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "error";
  }
}

async function pickFromDb(stuckBefore: Date): Promise<AutoFetchTarget | null> {
  const p = await prisma.property.findFirst({
    where: autoFetchWhere(stuckBefore),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, address: true, lotNumber: true, gpsLat: true, gpsLng: true, createdBy: true },
  });
  if (!p) return null;
  return {
    id: p.id,
    address: p.address,
    lotNumber: p.lotNumber,
    gpsLat: p.gpsLat != null ? Number(p.gpsLat) : null,
    gpsLng: p.gpsLng != null ? Number(p.gpsLng) : null,
    createdBy: p.createdBy,
  };
}

const STARTED = Symbol.for("pm.investigationAutoFetch.started");

/** サーバー起動時に1回だけ呼ぶ(instrumentation.ts)。二重に呼ばれても見回りは1本。 */
export function startInvestigationAutoFetch(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTED]) return;
  g[STARTED] = true;
  const deps: AutoFetchDeps = { pick: pickFromDb, run: runAutoInvestigation, now: () => new Date() };
  const tick = async () => {
    const outcome = await runAutoFetchOnce(deps);
    if (outcome === "outage") {
      console.error("[investigation-auto] 不動産情報ライブラリが応答しないため30分休みます");
    }
    const t = setTimeout(tick, nextDelayMs(outcome));
    t.unref?.();
  };
  // 起動直後は他の準備を優先して1分待ってから始める。
  const t = setTimeout(tick, 60_000);
  t.unref?.();
}
