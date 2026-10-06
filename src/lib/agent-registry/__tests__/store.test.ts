import { describe, it, expect, vi, beforeEach } from "vitest";

const { agent, crawlState, $transaction, lockQuery } = vi.hoisted(() => {
  const agent = {
    findMany: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn((a: unknown) => ({ op: "upsert", a })),
    updateMany: vi.fn(),
  };
  const lockQuery = vi.fn(async () => []);
  // 配列(まとめて実行)と関数(行をロックして順に実行)の両方の形を受ける。関数の中では同じ mlitAgent を使う。
  const $transaction = vi.fn(async (arg: unknown) =>
    Array.isArray(arg) ? arg : (arg as (tx: unknown) => unknown)({ $queryRaw: lockQuery, mlitAgent: agent }),
  );
  return {
    agent,
    crawlState: {
      findMany: vi.fn(),
      upsert: vi.fn((a: unknown) => ({ op: "stateUpsert", a })),
    },
    $transaction,
    lockQuery,
  };
});

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
  isMain: true,
  ...over,
});
type UpsertArg = { where: { licenseKey: string }; update: Record<string, unknown>; create: Record<string, unknown> };
const upserts = () => Object.fromEntries(agent.upsert.mock.calls.map(([a]) => [(a as UpsertArg).where.licenseKey, a as UpsertArg]));
const prevRow = (key: string, over: Record<string, unknown> = {}) => ({
  licenseKey: key,
  companyName: `会社${key}`,
  address: `住所${key}`,
  licenseLabel: `東京都知事(17)第${key.slice(2)}号`,
  seenCycle: "2026-10",
  detailAt: new Date("2026-10-01T00:00:00Z"),
  listed: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("保存(prisma 版)", () => {
  it("新しい会社と、商号・所在地・免許の表示が変わった会社だけ詳細を取り直す印を付ける", async () => {
    agent.findMany.mockResolvedValue([
      prevRow("13000001"),
      prevRow("13000002", { companyName: "旧商号" }),
      prevRow("13000003", { licenseLabel: "東京都知事(16)第000003号" }),
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

  it("★一覧の行の読み比べと更新は、行をロックした1つの取引の中で行う(同時に名簿へ写されても古い電話を写さない・@codex #477)", async () => {
    agent.findMany.mockResolvedValue([prevRow("13000001", { companyName: "旧商号" })]);
    const store = createPrismaCrawlStore();
    await store.upsertListRows([row("13000001"), row("13000002")], "2026-10");
    expect(typeof $transaction.mock.calls[0][0]).toBe("function"); // 関数の形=1つの取引
    const q = (lockQuery.mock.calls[0] as unknown as [{ strings?: readonly string[]; sql?: string; values?: unknown[] }])[0];
    const text = q.sql ?? (q.strings ?? []).join("?");
    expect(text).toMatch(/FROM "mlit_agents"[\s\S]*license_key[\s\S]*FOR UPDATE/);
    expect(JSON.stringify(q.values)).toContain("13000001");
    // ロック → 読み比べ → 更新 の順
    expect(lockQuery.mock.invocationCallOrder[0]).toBeLessThan(agent.findMany.mock.invocationCallOrder[0]);
    expect(agent.findMany.mock.invocationCallOrder[0]).toBeLessThan(agent.upsert.mock.invocationCallOrder[0]);
    expect(upserts()["13000001"].update.needsDetail).toBe(true);
  });

  it("★本店の行が無いページ(支店だけ)では所在地を上書きしない・所在地の違いで取り直さない", async () => {
    agent.findMany.mockResolvedValue([prevRow("00000201", { address: "本店の住所" })]);
    const store = createPrismaCrawlStore();
    await store.upsertListRows([row("00000201", { address: "大阪支店の住所", isMain: false })], "2026-10");
    const u = upserts()["00000201"];
    expect(u.update).not.toHaveProperty("address");
    expect(u.update).not.toHaveProperty("needsDetail");
  });

  it("本店の行なら所在地を更新し、変わっていれば取り直す", async () => {
    agent.findMany.mockResolvedValue([prevRow("00000201", { address: "旧本店の住所" })]);
    const store = createPrismaCrawlStore();
    await store.upsertListRows([row("00000201", { address: "新本店の住所" })], "2026-10");
    const u = upserts()["00000201"];
    expect(u.update.address).toBe("新本店の住所");
    expect(u.update.needsDetail).toBe(true);
  });

  it("★詳細を取ってから1年たった会社は取り直す(電話番号だけの変更を拾う)", async () => {
    agent.findMany.mockResolvedValue([
      prevRow("13000001", { detailAt: new Date("2025-09-01T00:00:00Z") }),
      prevRow("13000002", { detailAt: new Date("2026-09-01T00:00:00Z") }),
    ]);
    const store = createPrismaCrawlStore(() => new Date("2026-10-05T14:00:00Z"));
    await store.upsertListRows([row("13000001"), row("13000002")], "2026-10");
    expect(upserts()["13000001"].update.needsDetail).toBe(true);
    expect(upserts()["13000002"].update).not.toHaveProperty("needsDetail");
  });

  it("★一覧から消えていた会社がまた出てきたら、見た目が同じでも詳細を取り直す(@codex #477)", async () => {
    agent.findMany.mockResolvedValue([prevRow("13000001", { listed: false }), prevRow("13000002", { listed: true })]);
    const store = createPrismaCrawlStore(() => new Date("2026-10-05T14:00:00Z"));
    await store.upsertListRows([row("13000001"), row("13000002")], "2026-10");
    expect(upserts()["13000001"].update.needsDetail).toBe(true);
    expect(upserts()["13000002"].update).not.toHaveProperty("needsDetail");
  });

  it("★新しい一巡で初めて見た行は、詳細の失敗回数を0に戻す(前の一巡で諦めた会社をもう一度試す)", async () => {
    agent.findMany.mockResolvedValue([prevRow("13000001", { seenCycle: "2026-10" }), prevRow("13000002", { seenCycle: "2026-11" })]);
    const store = createPrismaCrawlStore();
    await store.upsertListRows([row("13000001"), row("13000002")], "2026-11");
    expect(upserts()["13000001"].update.detailFailCount).toBe(0);
    expect(upserts()["13000002"].update).not.toHaveProperty("detailFailCount");
  });

  it("詳細の失敗を数える・3回失敗した会社はその一巡では取りに行かない・失敗の少ない順", async () => {
    agent.findMany.mockResolvedValue([]);
    agent.updateMany.mockResolvedValue({ count: 1 });
    const store = createPrismaCrawlStore();
    await store.markDetailFailed("13000001");
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { licenseKey: "13000001" },
      data: { detailFailCount: { increment: 1 } },
    });
    await store.nextNeedingDetail("2026-10", 1);
    expect(agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { needsDetail: true, listed: true, seenCycle: "2026-10", detailFailCount: { lt: 3 } },
        orderBy: [{ detailFailCount: "asc" }, { licenseKey: "asc" }],
      }),
    );
  });

  it("この一巡で詳細を諦めた(3回失敗した)会社の数", async () => {
    agent.count.mockResolvedValue(21);
    const store = createPrismaCrawlStore();
    expect(await store.countDetailExhausted("2026-10")).toBe(21);
    expect(agent.count).toHaveBeenCalledWith({
      where: { needsDetail: true, listed: true, seenCycle: "2026-10", detailFailCount: { gte: 3 } },
    });
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
        where: { needsDetail: true, listed: true, seenCycle: "2026-10", detailFailCount: { lt: 3 } },
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
        detailFailCount: 0,
      },
    });
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { licenseKey: "13000001", address: null },
      data: { address: "詳細の住所" },
    });
    // ★所在地と「取り終えた」の印は1つの取引でまとめて書く(間に所在地の無いまま写されない・@codex #477)
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(($transaction.mock.calls[0] as unknown as [unknown[]])[0]).toHaveLength(2);
  });

  it("一巡の締め: この一巡とその前の一巡のどちらでも見なかった会社(と一度も見ていない会社)だけ「一覧に無い」に(@codex #477)", async () => {
    agent.updateMany.mockResolvedValue({ count: 2 });
    const store = createPrismaCrawlStore();
    expect(await store.closeCycle("2026-11", "2026-10")).toBe(2);
    expect(agent.updateMany).toHaveBeenCalledWith({
      where: { listed: true, OR: [{ seenCycle: { notIn: ["2026-11", "2026-10"] } }, { seenCycle: null }] },
      data: { listed: false },
    });
  });

  it("進み具合は行政庁ごとに1行で保存する", async () => {
    const store = createPrismaCrawlStore();
    await store.saveStates([
      { authority: "00", cycle: "2026-10", phase: "list", nextPage: 3, totalPages: 60, totalRows: 2950, lastKey: "00000100", failStreak: 0, dayOffUntil: null, lastError: null, lastRunAt: null },
    ]);
    expect(crawlState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authority: "00" },
        update: expect.objectContaining({ nextPage: 3, phase: "list", totalRows: 2950, lastKey: "00000100" }),
      }),
    );
  });
});
