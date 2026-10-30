/**
 * 月の上限(2026-10-29)の「数える+予約する」層。
 *
 * ⚠並行する取得(一括の各件・別の人が同時に押す)で**上限を超えない**ことを、
 *   順番が交差するすべての並びで確かめる(総当たり)。
 *   台帳は課金した**後**に書かれるので、台帳だけを見ると「取得中」の分が抜ける。
 *   予約(取得中の額)と台帳の読み出しを1本の列で直列にし、予約を外すのは
 *   台帳を書き終えた**後**、という約束で抜けを塞いでいる。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

vi.mock("@/lib/prisma", () => ({
  default: { auditLog: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  createMonthlyPurchaseGate,
  readMonthlyPurchaseSpentYen,
  reserveMonthlyPurchaseBudget,
  getMonthlyPurchaseUsage,
  __resetMonthlyPurchaseGateForTest,
} from "../monthly-cap-store";
import {
  REGISTRY_PURCHASE_LEDGER_ACTION,
  REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
  REGISTRY_CERTIFICATE_PRICE_YEN,
  MONTHLY_CAP_REACHED_CODE,
  MONTHLY_CAP_UNAVAILABLE_CODE,
} from "../monthly-cap";

const findMany = (prisma as unknown as { auditLog: { findMany: Mock } }).auditLog
  .findMany;

/** 溜まっている microtask / 次の tick をすべて流す。 */
const flush = () => new Promise<void>((r) => setImmediate(r));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  const seen = new Set<string>();
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) {
      const p = [x, ...rest];
      const k = JSON.stringify(p);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(p);
      }
    }
  });
  return out;
}

describe("createMonthlyPurchaseGate: 順番が交差しても上限を超えない(総当たり)", () => {
  type Action =
    | "startA"
    | "startB"
    | "read"
    | "chargeA"
    | "releaseA"
    | "chargeB"
    | "releaseB"
    // 課金→台帳→予約を外す、を続けて行う(runRegistryAutoFetch は台帳を書いた直後に外す)。
    | "finishA"
    | "finishB";

  /**
   * 1つの並びを実行する。
   *  - 台帳(db)は「課金=台帳の確定」を同時とみなす(一番きつい見方)。
   *  - 台帳の読み出しは**呼ばれた時点の値**を返す(遅れて届く=古い値)。
   *  - 予約を外す(release)のは、その取得の課金・台帳が済んだ後だけ
   *    (runRegistryAutoFetch の約束と同じ)。
   */
  async function runSchedule(
    order: Action[],
    opts: { capYen: number; initialSpent: number; price: number },
  ) {
    let db = opts.initialSpent;
    const pendingReads: Array<{ value: number; resolve: (v: number) => void }> = [];
    const gate = createMonthlyPurchaseGate({
      capYen: opts.capYen,
      readSpentYen: () =>
        new Promise<number>((resolve) => {
          pendingReads.push({ value: db, resolve });
        }),
    });
    type Slot = {
      started: boolean;
      result: Awaited<ReturnType<typeof gate.reserve>> | null;
      charged: boolean;
      released: boolean;
    };
    const slots: Record<"A" | "B", Slot> = {
      A: { started: false, result: null, charged: false, released: false },
      B: { started: false, result: null, charged: false, released: false },
    };
    let maxDb = db;
    const step = async (a: Action) => {
      if (a === "read") {
        const r = pendingReads.shift();
        r?.resolve(r.value);
      } else if (a === "startA" || a === "startB") {
        const s = slots[a === "startA" ? "A" : "B"];
        s.started = true;
        void gate.reserve(opts.price).then((r) => {
          s.result = r;
        });
      } else if (a === "finishA" || a === "finishB") {
        const k = a === "finishA" ? "A" : "B";
        await step(`charge${k}` as Action);
        await step(`release${k}` as Action);
        return;
      } else {
        const s = slots[a.endsWith("A") ? "A" : "B"];
        const admitted = s.result?.ok === true;
        if (a.startsWith("charge") && admitted && !s.charged) {
          s.charged = true;
          db += opts.price;
          maxDb = Math.max(maxDb, db);
        }
        if (a.startsWith("release") && admitted && s.charged && !s.released) {
          s.released = true;
          if (s.result?.ok) void s.result.hold.release();
        }
      }
      await flush();
    };
    for (const a of order) await step(a);
    // 残りを流しきる(読み出しを返し、通った取得は課金→予約を外す)。
    for (let i = 0; i < 10; i++) {
      while (pendingReads.length) await step("read");
      for (const k of ["A", "B"] as const) {
        await step(`charge${k}` as Action);
        await step(`release${k}` as Action);
      }
    }
    return { slots, db, maxDb, pendingYen: gate.pendingYen() };
  }

  const actions: Action[] = [
    "startA",
    "startB",
    "read",
    "read",
    "chargeA",
    "releaseA",
    "chargeB",
  ];
  const orders = permutations(actions);

  it(`残り1件分しかないとき: ${orders.length} 通りの並びすべてで、通るのはちょうど1件・上限を超えない`, async () => {
    for (const order of orders) {
      const { slots, maxDb, pendingYen } = await runSchedule(order, {
        capYen: 280,
        initialSpent: 140,
        price: 140,
      });
      const admitted = (["A", "B"] as const).filter(
        (k) => slots[k].result?.ok === true,
      );
      // ⚠超えない
      expect(maxDb, order.join(",")).toBeLessThanOrEqual(280);
      // 止めすぎない(1件は通る)・両方とも答えが返る(詰まらない)
      expect(admitted.length, order.join(",")).toBe(1);
      expect(slots.A.result, order.join(",")).not.toBeNull();
      expect(slots.B.result, order.join(",")).not.toBeNull();
      // 最後は予約が残らない
      expect(pendingYen, order.join(",")).toBe(0);
    }
  });

  // ⚠止めすぎないか: 台帳を書いた直後に予約を外す(finish)前提で総当たり。
  //   (台帳の確定と予約の取り外しの間に判定が入ると、その瞬間だけ二重に数える
  //   =多めに数える側。上の総当たりで「超えない」ことは別に確かめている。)
  const finishOrders = permutations<Action>([
    "startA",
    "startB",
    "read",
    "read",
    "finishA",
    "finishB",
  ]);
  it(`残り2件分あるとき: ${finishOrders.length} 通りすべてで両方通る(止めすぎない)`, async () => {
    for (const order of finishOrders) {
      const { slots, maxDb } = await runSchedule(order, {
        capYen: 420,
        initialSpent: 140,
        price: 140,
      });
      expect(maxDb, order.join(",")).toBeLessThanOrEqual(420);
      expect(slots.A.result?.ok, order.join(",")).toBe(true);
      expect(slots.B.result?.ok, order.join(",")).toBe(true);
    }
  });

  it("課金せずに終わった取得は予約を外す → 次が通る", async () => {
    const gate = createMonthlyPurchaseGate({
      capYen: 140,
      readSpentYen: async () => 0,
    });
    const a = await gate.reserve(140);
    expect(a.ok).toBe(true);
    expect((await gate.reserve(140)).ok).toBe(false);
    if (a.ok) await a.hold.release();
    expect((await gate.reserve(140)).ok).toBe(true);
  });

  it("⚠課金したのに台帳が書けなかった取得は予約を残す(retain)=以後もその額を数え続ける", async () => {
    const gate = createMonthlyPurchaseGate({
      capYen: 140,
      readSpentYen: async () => 0,
    });
    const a = await gate.reserve(140);
    if (!a.ok) throw new Error("unexpected");
    a.hold.retain();
    // retain の後に release が呼ばれても外れない(後片付けの取り違えに強くする)。
    await a.hold.release();
    expect(gate.pendingYen()).toBe(140);
    expect((await gate.reserve(140)).ok).toBe(false);
  });

  // @codex #614 R1 P2: 残した予約はその課金の月だけ数える(翌月の枠を食わない)。
  it("⚠retain した予約は、その月(日本時間)の間だけ数え、翌月には数えない", async () => {
    let now = new Date("2026-10-31T14:00:00Z"); // 10/31 23:00 JST
    const gate = createMonthlyPurchaseGate({
      capYen: 140,
      readSpentYen: async () => 0,
      now: () => now,
    });
    const a = await gate.reserve(140);
    if (!a.ok) throw new Error("unexpected");
    a.hold.retain();
    expect(gate.pendingYen()).toBe(140);
    expect((await gate.reserve(140)).ok).toBe(false);
    now = new Date("2026-10-31T15:00:00Z"); // 11/1 0:00 JST
    expect(gate.pendingYen()).toBe(0);
    expect((await gate.reserve(140)).ok).toBe(true);
  });

  it("取得中(まだ台帳も retain も無い)の予約は、月をまたいでも数え続ける", async () => {
    let now = new Date("2026-10-31T14:59:00Z");
    const gate = createMonthlyPurchaseGate({
      capYen: 140,
      readSpentYen: async () => 0,
      now: () => now,
    });
    const a = await gate.reserve(140);
    if (!a.ok) throw new Error("unexpected");
    now = new Date("2026-10-31T15:01:00Z");
    expect(gate.pendingYen()).toBe(140);
    expect((await gate.reserve(140)).ok).toBe(false);
  });

  it("release は何度呼んでも1回分しか外さない", async () => {
    const gate = createMonthlyPurchaseGate({
      capYen: 280,
      readSpentYen: async () => 0,
    });
    const a = await gate.reserve(140);
    const b = await gate.reserve(140);
    if (!a.ok || !b.ok) throw new Error("unexpected");
    await a.hold.release();
    await a.hold.release();
    expect(gate.pendingYen()).toBe(140);
  });

  it("⚠台帳が読めないときは予約せずに失敗を返す(列は詰まらない)", async () => {
    let fail = true;
    const gate = createMonthlyPurchaseGate({
      capYen: 280,
      readSpentYen: async () => {
        if (fail) throw new Error("db down");
        return 0;
      },
    });
    await expect(gate.reserve(140)).rejects.toThrow("db down");
    expect(gate.pendingYen()).toBe(0);
    fail = false;
    expect((await gate.reserve(140)).ok).toBe(true);
  });
});

describe("readMonthlyPurchaseSpentYen(台帳の読み出し)", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("台帳の action・今月(日本時間)の範囲(+組を作るための前日ぶん)で読む", async () => {
    findMany.mockResolvedValue([]);
    await readMonthlyPurchaseSpentYen(new Date("2026-10-15T00:00:00.000Z"));
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.action).toBe(REGISTRY_PURCHASE_LEDGER_ACTION);
    expect(arg.where.createdAt.gte.toISOString()).toBe("2026-09-29T15:00:00.000Z");
    expect(arg.where.createdAt.lt.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    // 中身は鍵のハッシュ・結果・種別だけ(地番などは持たない)。必要な列だけ読む。
    expect(arg.select).toEqual({ createdAt: true, detail: true });
  });

  it("読み出した記録を純関数で合計する", async () => {
    findMany.mockResolvedValue([
      { createdAt: new Date("2026-10-02T00:00:00Z"), detail: { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" } },
      { createdAt: new Date("2026-10-02T00:01:00Z"), detail: { purchaseKeyHash: "a", outcome: "charged_but_failed", certificateType: "owner" } },
      { createdAt: new Date("2026-10-03T00:00:00Z"), detail: { purchaseKeyHash: "b", outcome: "charged", certificateType: "all" } },
    ]);
    expect(
      await readMonthlyPurchaseSpentYen(new Date("2026-10-15T00:00:00.000Z")),
    ).toBe(REGISTRY_CERTIFICATE_PRICE_YEN.owner + REGISTRY_CERTIFICATE_PRICE_YEN.all);
  });
});

describe("reserveMonthlyPurchaseBudget / getMonthlyPurchaseUsage(本番の入口)", () => {
  beforeEach(() => {
    findMany.mockReset();
    __resetMonthlyPurchaseGateForTest();
  });

  const ownerRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      createdAt: new Date(),
      detail: { purchaseKeyHash: `k${i}`, outcome: "charged", certificateType: "owner" },
    }));

  it("上限内なら予約を返す", async () => {
    findMany.mockResolvedValue(ownerRows(1));
    const hold = await reserveMonthlyPurchaseBudget("owner");
    expect(hold.priceYen).toBe(REGISTRY_CERTIFICATE_PRICE_YEN.owner);
    await hold.release();
  });

  it("⚠上限を超えるなら 409 + 月の上限の文言で止める(課金していない)", async () => {
    // 357件 × 140円 = 49,980円。あと 140円は入らない。
    findMany.mockResolvedValue(ownerRows(357));
    await expect(reserveMonthlyPurchaseBudget("owner")).rejects.toMatchObject({
      status: 409,
      code: MONTHLY_CAP_REACHED_CODE,
      message: expect.stringContaining("月の上限（5万円）に達したため取得しませんでした"),
    });
  });

  it("⚠台帳が読めないときは 503 で止める(数えられないまま買わない)", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    await expect(reserveMonthlyPurchaseBudget("owner")).rejects.toMatchObject({
      status: 503,
      code: MONTHLY_CAP_UNAVAILABLE_CODE,
    });
  });

  it("画面用の利用額: 台帳+取得中・上限・値段を返す", async () => {
    findMany.mockResolvedValue(ownerRows(10));
    const hold = await reserveMonthlyPurchaseBudget("all");
    const usage = await getMonthlyPurchaseUsage(new Date());
    expect(usage).toMatchObject({
      capYen: REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
      spentYen: 1400,
      pendingYen: REGISTRY_CERTIFICATE_PRICE_YEN.all,
      usedYen: 1400 + REGISTRY_CERTIFICATE_PRICE_YEN.all,
      prices: REGISTRY_CERTIFICATE_PRICE_YEN,
    });
    expect(typeof usage.resetsAt).toBe("string");
    await hold.release();
  });
});
