import { describe, it, expect, vi, beforeEach } from "vitest";

type Prop = {
  dmStatus: string;
  dmOwnerPending: boolean;
  isArchived: boolean;
  createdBy: string;
  registryStatus: string;
  registryOwnerCheck: { result: string; decision: string | null; stale: boolean } | null;
  ownerIds: string[];
  version: number;
};
let prop: Prop;
let others: Array<{ ownerId: string; property: { dmStatus: string } }>;
let logs: Array<Record<string, unknown>>;
const editLocked = { value: false };
const terminal = { ownerIds: new Set<string>(), propertyIds: new Set<string>(), agentOwnerIds: new Set<string>() };

const tx = {
  property: {
    findUnique: vi.fn(async () => ({
      ...prop,
      _count: { propertyOwners: prop.ownerIds.length },
      propertyOwners: prop.ownerIds.map((ownerId) => ({ ownerId })),
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      for (const [k, v] of Object.entries(data)) {
        if (k === "version") prop.version += 1;
        else (prop as Record<string, unknown>)[k] = v;
      }
    }),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(prop, data);
      return { count: 1 };
    }),
  },
  propertyOwner: { findMany: vi.fn(async () => others) },
  changeLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      logs.push(data);
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ default: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn(async () => {}) }));
vi.mock("@/lib/edit-lock/service", () => ({ isResourceEditLocked: vi.fn(async () => editLocked.value) }));
vi.mock("@/lib/dm-batch/terminal-exclusion", () => ({
  findTerminalExclusions: vi.fn(async () => ({ ...terminal, gaijiOwnerIds: new Set() })),
}));

import { processOwnerless, judgeWithOwners } from "../service";

beforeEach(() => {
  prop = {
    dmStatus: "hold",
    dmOwnerPending: true,
    isArchived: false,
    createdBy: "u1",
    registryStatus: "unconfirmed",
    registryOwnerCheck: null,
    ownerIds: ["o1"],
    version: 1,
  };
  others = [];
  logs = [];
  editLocked.value = false;
  terminal.ownerIds = new Set();
  terminal.propertyIds = new Set();
  terminal.agentOwnerIds = new Set();
  tx.property.update.mockClear();
});

describe("processOwnerless(所有者が入っていない物件)", () => {
  beforeEach(() => {
    prop.ownerIds = [];
  });

  it("送付可なら未判断に戻し、印を立て、版を上げ、変更履歴に「自動」で残す", async () => {
    prop.dmStatus = "send";
    prop.dmOwnerPending = false;
    expect(await processOwnerless("p1")).toBe("changed");
    expect(prop).toMatchObject({ dmStatus: "hold", dmOwnerPending: true, version: 2 });
    expect(logs).toEqual([
      expect.objectContaining({ fieldName: "dmStatus", oldValue: "send", newValue: "hold", source: "auto", changedBy: "u1" }),
    ]);
  });

  it("誰かが編集中なら送付可のまま(次の見回りへ)", async () => {
    prop.dmStatus = "send";
    editLocked.value = true;
    expect(await processOwnerless("p1")).toBe("locked");
    expect(prop.dmStatus).toBe("send");
  });

  it("未判断なら印だけ立て、版は上げない", async () => {
    prop.dmOwnerPending = false;
    expect(await processOwnerless("p1")).toBe("marked");
    expect(prop).toMatchObject({ dmStatus: "hold", dmOwnerPending: true, version: 1 });
    expect(logs).toEqual([]);
  });

  it("ロックを取ったあとで所有者が入っていたら何もしない", async () => {
    prop.ownerIds = ["o1"];
    prop.dmStatus = "send";
    expect(await processOwnerless("p1")).toBe("skipped");
    expect(prop.dmStatus).toBe("send");
  });
});

describe("judgeWithOwners(所有者が入った物件の仕分け)", () => {
  it("どれにも当たらなければ送付可にして印を下ろし、版を上げ、「自動」で残す", async () => {
    expect(await judgeWithOwners("p1")).toEqual({ outcome: "send", reasons: [] });
    expect(prop).toMatchObject({ dmStatus: "send", dmOwnerPending: false, version: 2 });
    expect(logs[0]).toMatchObject({ oldValue: "hold", newValue: "send", source: "auto" });
  });

  it("業者と同じ名前なら送付不可", async () => {
    terminal.agentOwnerIds = new Set(["o1"]);
    expect(await judgeWithOwners("p1")).toEqual({ outcome: "no_send", reasons: ["agent_name"] });
    expect(prop.dmStatus).toBe("no_send");
  });

  it("同じ所有者がほかの物件で送付可・送付不可なら送付不可", async () => {
    others = [{ ownerId: "o1", property: { dmStatus: "send" } }];
    expect((await judgeWithOwners("p1")).reasons).toEqual(["other_send"]);
    prop.dmStatus = "hold";
    prop.dmOwnerPending = true;
    others = [{ ownerId: "o1", property: { dmStatus: "no_send" } }];
    expect((await judgeWithOwners("p1")).reasons).toEqual(["other_no_send"]);
  });

  it("ほかの物件を探すときは、送付可は保管していない物件だけ・送付不可は保管した物件も含める", async () => {
    await judgeWithOwners("p1");
    expect(tx.propertyOwner.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          ownerId: { in: ["o1"] },
          propertyId: { not: "p1" },
          property: { OR: [{ dmStatus: "send", isArchived: false }, { dmStatus: "no_send" }] },
        },
      }),
    );
  });

  it("DM を断った・宛先不明の記録があれば送付不可", async () => {
    terminal.ownerIds = new Set(["o1"]);
    expect((await judgeWithOwners("p1")).reasons).toEqual(["terminal"]);
  });

  it("所有者が複数なら1人でも当たれば送付不可", async () => {
    prop.ownerIds = ["o1", "o2"];
    terminal.agentOwnerIds = new Set(["o2"]);
    expect((await judgeWithOwners("p1")).outcome).toBe("no_send");
  });

  it("謄本の名義の確認が済んでいなければ仕分けない", async () => {
    prop.registryStatus = "obtained";
    prop.registryOwnerCheck = { result: "mismatch", decision: null, stale: false };
    expect((await judgeWithOwners("p1")).outcome).toBe("waiting");
    expect(prop).toMatchObject({ dmStatus: "hold", dmOwnerPending: true });
  });

  it("誰かが編集中なら仕分けない", async () => {
    editLocked.value = true;
    expect((await judgeWithOwners("p1")).outcome).toBe("locked");
    expect(prop.dmStatus).toBe("hold");
  });

  it("人が先に送付可/送付不可にしていたら、値は変えず印だけ下ろす", async () => {
    prop.dmStatus = "no_send";
    expect((await judgeWithOwners("p1")).outcome).toBe("unmarked");
    expect(prop).toMatchObject({ dmStatus: "no_send", dmOwnerPending: false, version: 1 });
    expect(logs).toEqual([]);
  });

  it("印が無い(人が自分で未判断にした)物件は触らない", async () => {
    prop.dmOwnerPending = false;
    expect((await judgeWithOwners("p1")).outcome).toBe("skipped");
    expect(prop.dmStatus).toBe("hold");
  });
});
