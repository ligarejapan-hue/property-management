import { timingSafeEqual } from "crypto";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { createRegistryClient } from "@/lib/agent-registry/client";
import { crawlStep, DEFAULT_BUDGET, inNightWindow } from "@/lib/agent-registry/crawl";
import { createPrismaCrawlStore } from "@/lib/agent-registry/store";

/**
 * POST /api/agent-registry/crawl-run — 国交省の業者一覧を集める口(timer 用・夜間10分ごと)。
 *
 * 作りは巡回の自動終了(`/api/field-survey/sessions/auto-end-run`)と同じ:
 * - `AGENT_REGISTRY_CRAWL_SECRET` 未設定なら **503(休眠=先方にアクセスしない)**
 * - header `x-agent-registry-secret` 不一致は 403。人のログインは不要(timer 駆動)
 * - `?dryRun=1` で進み具合と件数だけ返す(先方にアクセスしない)
 * - 前の回がまだ走っていたら 409(先方へ2本同時にアクセスしない)。本番のアプリは1プロセスなので
 *   プロセスの中の印で足りる(計画の advisory lock から変更=接続を固定できないため)。
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスの追加が必要(無いと 307)
 * - ログは件数と分類コードだけ(会社名・電話・先方の本文を出さない)。人の操作ではないので監査は書かない。
 */
let running = false;

export async function POST(request: Request) {
  try {
    const secret = process.env.AGENT_REGISTRY_CRAWL_SECRET;
    if (!secret) throw new ApiError(503, "国交省の業者一覧の取得は未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-agent-registry-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const store = createPrismaCrawlStore();
    if (new URL(request.url).searchParams.get("dryRun") === "1") {
      const [states, total, needsDetail] = await Promise.all([
        store.loadStates(),
        prisma.mlitAgent.count(),
        prisma.mlitAgent.count({ where: { needsDetail: true, listed: true } }),
      ]);
      return apiResponse({ dryRun: true, states, counts: { total, needsDetail } });
    }

    if (running) throw new ApiError(409, "前の回がまだ動いています", "ALREADY_RUNNING");
    running = true;
    try {
      const result = await crawlStep({
        // 取り直しを含むすべての呼び出しの直前に、夜間か・予算の内かを確かめる(7時を越えない・100回を超えない・@codex #477)。
        client: createRegistryClient({ allowRequest: () => inNightWindow(new Date()), budget: DEFAULT_BUDGET }),
        store,
        now: () => new Date(),
        budget: DEFAULT_BUDGET,
      });
      console.log(
        `[agent-registry] requests=${result.requests} listed=${result.listed} detailed=${result.detailed} stopped=${result.stopped ?? "none"}`,
      );
      return apiResponse({ ...result, dryRun: false });
    } finally {
      running = false;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
