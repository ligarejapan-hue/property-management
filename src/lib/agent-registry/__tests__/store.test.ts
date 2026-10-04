import { describe, it, expect, vi, beforeEach } from "vitest";

const { agent, crawlState, $transaction } = vi.hoisted(() => ({
  agent: {
    findMany: vi.fn(),
    upsert: vi.fn((a: unknown) => ({ op: "upsert", a })),
    updateMany: vi.fn(),
  },
  crawlState: {
    findMany: vi.fn(),
    upsert: vi.fn((a: unknown) => ({ op: "stateUpsert", a })),
  },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock("@/lib/prisma", () => ({
  default: { mlitAgent: agent, mlitCrawlState: crawlState, $transaction },
}));

import { createPrismaCrawlStore } from "@/lib/agent-registry/store";
import type { ListRow } from "@/lib/agent-registry/parse";

const row = (key: string, over: Partial<ListRow> = {}): ListRow => ({
  licenseKey: key,
  authority: key.slice(0, 2),
  licenseLabel: `東京都知事(17)第${key.slice(2)}号`,
  companyName: `会社${key}`,
  address: `住所${key}`,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("保存(prisma 版)", () => {
  it("新しい会社と、商号・所在地・免許の表示が変わった会社だけ詳細を取り直す印を付ける", async () => {
    agent.findMany.mockResolvedValue([
      { licenseKey: "13000001", companyName: "会社13000001", address: "住所13000001", licenseLabel: "東京都知事(17)第000001号" },
      { licenseKey: "13000002", companyName: "旧商号", address: "住所13000002", licenseLabel: "東京都知事(17)第000002号" },
      { licenseKey: "13000003", companyName: "会社13000003", address: "住所13000003", licenseLabel: "東京都知事(16)第000003号" },
    ]);
    const store = createPrismaCrawlStore();
    const n = await store.upsertListRows(
      [row("13000001"), row("13000002"), row("13000003"), row("13000004")],
      "2026-10",
    );
    expect(n).toBe(4);
    const updates = agent.upsert.mock.calls.map(([a]) => a as { where: { licenseKey: string }; update: Record<string, unknown>; create: Record<string, unknown> });
    const byKey = Object.fromEntries(updates.map((u) => [u.where.licenseKey, u]));
    expect(byKey["13000001"].update).not.toHaveProperty("needsDetail"); // 変わっていない
    expect(byKey["13000002"].update.needsDetail).toBe(true); // 商号が変わった
    expect(byKey["13000003"].update.needsDetail).toBe(true); // 免許の回次が変わった
    expect(byKey["13000004"].create.needsDetail).toBe(true); // 新しい
    for (const u of updates) {
      expect(u.update.listed).toBe(true);
      expect(u.update.seenCycle).toBe("2026-10");
    }
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("空のページは何もしない", async () => {
    const store = createPrismaCrawlStore();
    expect(await store.upsertListRows([], "2026-10")).toBe(0);
    expect(agent.findMany).not.toHaveBeenCalled();
  });

  it("詳細が要るのは、今の一巡で一覧に出た会社だけ(消えた会社の詳細は取りに行かない)", async () => {
    agent.findMany.mockResolvedValue([{ licenseKey: "13000001" }]);
    const store = createPrismaCrawlStore();
    expect(await store.nextNeedingDetail("2026-10", 5)).toEqual(["13000001"]);
    expect(agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { needsDetail: true, listed: true, seenCycle: "2026-10" },
        orderBy: { licenseKey: "asc" },
        take: 5,
      }),
    );
  });

  it("詳細を保存: 電話の数字・ふりがな・印を外す。所在地は一覧の値を上書きしない(空のときだけ埋める)", async () => {
    agent.updateMany.mockResolvedValue({ count: 1 });
    const store = createPrismaCrawlStore();
    const at = new Date("2026-10-05T14:00:00Z");
    await store.saveDetail(
      { licenseKey: "13000001", companyKana: "カブシキガイシヤ ミホン", address: "詳細の住所", phone: "03-0000-1212", validUntil: "R10年04月26日" },
      at,
    );
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { licenseKey: "13000001" },
      data: {
        companyKana: "カブシキガイシヤ ミホン",
        phone: "03-0000-1212",
        phoneDigits: "0300001212",
        validUntil: "R10年04月26日",
        needsDetail: false,
        detailAt: at,
      },
    });
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { licenseKey: "13000001", address: null },
      data: { address: "詳細の住所" },
    });
  });

  it("一巡の締め: その一巡で見なかった会社(と一度も見ていない会社)だけ「一覧に無い」に", async () => {
    agent.updateMany.mockResolvedValue({ count: 2 });
    const store = createPrismaCrawlStore();
    expect(await store.closeCycle("2026-11")).toBe(2);
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { listed: true, OR: [{ seenCycle: { not: "2026-11" } }, { seenCycle: null }] },
      data: { listed: false },
    });
  });

  it("進み具合は行政庁ごとに1行で保存する", async () => {
    const store = createPrismaCrawlStore();
    await store.saveStates([
      { authority: "00", cycle: "2026-10", phase: "list", nextPage: 3, totalPages: 60, failStreak: 0, dayOffUntil: null, lastError: null, lastRunAt: null },
    ]);
    expect(crawlState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authority: "00" }, update: expect.objectContaining({ nextPage: 3, phase: "list" }) }),
    );
  });
});
