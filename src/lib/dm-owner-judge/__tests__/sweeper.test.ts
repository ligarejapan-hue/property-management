import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("../service", () => ({
  processOwnerless: vi.fn(),
  judgeWithOwners: vi.fn(),
  REGISTRY_OWNER_MISMATCH_OPEN: { registryStatus: "obtained", registryOwnerCheck: { is: { result: "mismatch", decision: null, stale: false } } },
}));

import { runDmOwnerSweepOnce, shouldStartDmOwnerSweep, ownerlessWhere, judgeWhere } from "../sweeper";

describe("shouldStartDmOwnerSweep", () => {
  it("本番だけで動き、DM_OWNER_AUTO=off で止まる", () => {
    expect(shouldStartDmOwnerSweep({ NODE_ENV: "production" })).toBe(true);
    expect(shouldStartDmOwnerSweep({ NODE_ENV: "production", DM_OWNER_AUTO: "off" })).toBe(false);
    expect(shouldStartDmOwnerSweep({ NODE_ENV: "development" })).toBe(false);
    expect(shouldStartDmOwnerSweep({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe(false);
  });
});

describe("見回りの対象", () => {
  it("所有者なし: 保管していない・つながる所有者0人・(送付可/印のない未判断/印のある送付不可)", () => {
    expect(ownerlessWhere()).toEqual({
      isArchived: false,
      propertyOwners: { none: {} },
      OR: [
        { dmStatus: "send" },
        { dmStatus: "hold", dmOwnerPending: false },
        { dmStatus: "no_send", dmOwnerPending: true },
      ],
    });
  });
  it("仕分け: 印あり・所有者あり・名義の確認待ちは除く", () => {
    const w = judgeWhere();
    expect(w).toMatchObject({ isArchived: false, dmOwnerPending: true, propertyOwners: { some: {} } });
    expect(w.NOT).toEqual({
      registryStatus: "obtained",
      registryOwnerCheck: { is: { result: "mismatch", decision: null, stale: false } },
    });
  });
});

describe("runDmOwnerSweepOnce", () => {
  it("所有者なしを先に、所有者ありの仕分けをあとに1件ずつ回し、件数を返す", async () => {
    const order: string[] = [];
    const r = await runDmOwnerSweepOnce({
      listOwnerless: async () => ["a", "b"],
      listJudge: async () => ["c", "d"],
      processOwnerless: async (id) => {
        order.push(`o:${id}`);
        return id === "a" ? "changed" : "locked";
      },
      judge: async (id) => {
        order.push(`j:${id}`);
        return { outcome: id === "c" ? "send" : "no_send" };
      },
    });
    expect(order).toEqual(["o:a", "o:b", "j:c", "j:d"]);
    expect(r).toEqual({ ownerless: { changed: 1, locked: 1 }, judged: { send: 1, no_send: 1 }, worked: true });
  });

  it("何も書かなければ worked=false(1分待つ)", async () => {
    const r = await runDmOwnerSweepOnce({
      listOwnerless: async () => ["a"],
      listJudge: async () => ["c"],
      processOwnerless: async () => "locked",
      judge: async () => ({ outcome: "waiting" }),
    });
    expect(r.worked).toBe(false);
  });

  it("1件の失敗で止まらない", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runDmOwnerSweepOnce({
      listOwnerless: async () => ["a", "b"],
      listJudge: async () => [],
      processOwnerless: async (id) => {
        if (id === "a") throw new Error("boom");
        return "marked";
      },
      judge: async () => ({ outcome: "send" }),
    });
    expect(r.ownerless).toEqual({ error: 1, marked: 1 });
    expect(r.worked).toBe(true);
    err.mockRestore();
  });
});
