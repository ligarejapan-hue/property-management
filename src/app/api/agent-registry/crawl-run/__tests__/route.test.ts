/**
 * 国交省の業者一覧を集める口の**挙動**テスト(合言葉・dry-run・重ならない・ログ)。
 * 先方へのアクセスは偽物に差し替える(本物は呼ばない)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const crawlStep = vi.fn();
const createRegistryClient = vi.fn<(opts?: { allowRequest?: () => boolean }) => { fake: boolean }>(() => ({ fake: true }));
const loadStates = vi.fn();
const count = vi.fn();

vi.mock("@/lib/agent-registry/crawl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-registry/crawl")>("@/lib/agent-registry/crawl");
  return { ...actual, crawlStep: (...a: unknown[]) => crawlStep(...a) };
});
vi.mock("@/lib/agent-registry/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-registry/client")>("@/lib/agent-registry/client");
  return {
    ...actual,
    createRegistryClient: (opts?: { allowRequest?: () => boolean }) => createRegistryClient(opts),
  };
});
vi.mock("@/lib/agent-registry/store", () => ({
  createPrismaCrawlStore: () => ({ loadStates: (...a: unknown[]) => loadStates(...a) }),
}));
vi.mock("@/lib/prisma", () => ({ default: { mlitAgent: { count: (...a: unknown[]) => count(...a) } } }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code = "ERROR",
    ) {
      super(message);
    }
  }
  return {
    ApiError: MockApiError,
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status ?? 500 });
    },
  };
});

import { POST } from "../route";

const SECRET = "registry-secret-value";
const req = (opts?: { secret?: string; dryRun?: boolean }) =>
  new Request(`http://localhost/api/agent-registry/crawl-run${opts?.dryRun ? "?dryRun=1" : ""}`, {
    method: "POST",
    headers: opts?.secret ? { "x-agent-registry-secret": opts.secret } : {},
  });

let prev: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  prev = process.env.AGENT_REGISTRY_CRAWL_SECRET;
  process.env.AGENT_REGISTRY_CRAWL_SECRET = SECRET;
  crawlStep.mockResolvedValue({ requests: 3, listed: 50, detailed: 2, stopped: null });
  loadStates.mockResolvedValue([]);
  count.mockResolvedValue(0);
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_REGISTRY_CRAWL_SECRET;
  else process.env.AGENT_REGISTRY_CRAWL_SECRET = prev;
});

describe("POST /api/agent-registry/crawl-run", () => {
  it("合言葉が未設定なら 503(休眠=先方にアクセスしない)", async () => {
    delete process.env.AGENT_REGISTRY_CRAWL_SECRET;
    const res = await POST(req({ secret: SECRET }));
    expect(res.status).toBe(503);
    expect(crawlStep).not.toHaveBeenCalled();
    expect(createRegistryClient).not.toHaveBeenCalled();
  });

  it("合言葉が違う・無い → 403", async () => {
    expect((await POST(req({ secret: "wrong" }))).status).toBe(403);
    expect((await POST(req())).status).toBe(403);
    expect(crawlStep).not.toHaveBeenCalled();
  });

  it("dryRun は進み具合と件数だけ返し、先方にアクセスしない", async () => {
    loadStates.mockResolvedValue([
      { authority: "13", cycle: "2026-10", phase: "list", nextPage: 4, totalPages: 539, failStreak: 0, dayOffUntil: null, lastError: null, lastRunAt: null },
    ]);
    count.mockResolvedValueOnce(120).mockResolvedValueOnce(30);
    const res = await POST(req({ secret: SECRET, dryRun: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.states[0]).toMatchObject({ authority: "13", phase: "list", nextPage: 4 });
    expect(body.counts).toEqual({ total: 120, needsDetail: 30 });
    expect(crawlStep).not.toHaveBeenCalled();
    expect(createRegistryClient).not.toHaveBeenCalled();
  });

  it("1回分を進めて結果を返す", async () => {
    const res = await POST(req({ secret: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requests: 3, listed: 50, detailed: 2, stopped: null });
    expect(crawlStep).toHaveBeenCalledTimes(1);
  });

  it("★client には「夜間の内か」を毎回確かめる関数を渡す(取り直しでも 7 時を越えない・@codex #477)", async () => {
    await POST(req({ secret: SECRET }));
    const allow = createRegistryClient.mock.calls[0][0]?.allowRequest;
    expect(typeof allow).toBe("function");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-05T14:00:00Z")); // JST 23:00
      expect(allow!()).toBe(true);
      vi.setSystemTime(new Date("2026-10-05T22:00:00Z")); // JST 07:00
      expect(allow!()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("★前の回がまだ走っていたら 409 で何もしない(先方へ2本同時にアクセスしない)", async () => {
    let release!: () => void;
    crawlStep.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ requests: 1, listed: 0, detailed: 0, stopped: null }))),
    );
    const first = POST(req({ secret: SECRET }));
    await new Promise((r) => setTimeout(r, 0));
    const second = await POST(req({ secret: SECRET }));
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    // 終わったあとは、また動ける
    expect((await POST(req({ secret: SECRET }))).status).toBe(200);
  });

  it("途中で例外が出ても、走っている印は外れる", async () => {
    crawlStep.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(req({ secret: SECRET }))).status).toBe(500);
    expect((await POST(req({ secret: SECRET }))).status).toBe(200);
  });

  it("運用ログは件数と分類コードだけ", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await POST(req({ secret: SECRET }));
    expect(log).toHaveBeenCalledWith("[agent-registry] requests=3 listed=50 detailed=2 stopped=none");
    log.mockRestore();
  });

  it("ログインの関所を通らない口として登録されている(無いと 307 で timer が動かない)", () => {
    const proxy = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(proxy).toMatch(/PUBLIC_EXACT_PATHS = \[[\s\S]*"\/api\/agent-registry\/crawl-run"/);
  });

  it("timer の設定例: 合言葉を argv に載せない・% は %% と書く・夜間だけ", () => {
    const svc = readFileSync(join(process.cwd(), "deploy/systemd/pm-agent-registry.service.example"), "utf8");
    expect(svc).toContain('printf "%%s" "x-agent-registry-secret: $AGENT_REGISTRY_CRAWL_SECRET"');
    expect(svc).toContain("-H @-");
    expect(svc).toContain("http://127.0.0.1:3000/api/agent-registry/crawl-run");
    const timer = readFileSync(join(process.cwd(), "deploy/systemd/pm-agent-registry.timer.example"), "utf8");
    expect(timer).toMatch(/OnCalendar=\*-\*-\* 22,23,00,01,02,03,04,05,06:00\/10:00/);
  });
});
