import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
// 鍵は NEXTAUTH_SECRET から導出する。CI は設定済み・手元は未設定なので、無いときだけ入れて最後に戻す
// (env の有無で結果が変わらないように。テストもルートも同じ env から鍵を作る)。
const { hadSecret } = vi.hoisted(() => {
  const had = process.env.NEXTAUTH_SECRET !== undefined;
  if (!had) process.env.NEXTAUTH_SECRET = "test-secret-for-notification-summary";
  return { hadSecret: had };
});
afterAll(() => {
  if (!hadSecret) delete process.env.NEXTAUTH_SECRET;
});
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { checkSaleDmAccessFor } = vi.hoisted(() => ({ checkSaleDmAccessFor: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ checkSaleDmAccessFor }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    nextAction: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    dmInquiry: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ isActive: true, inquiryNotifyEnabled: true })) },
    registryFetchJob: { findMany: vi.fn(async () => []) },
    registryFetchJobItem: { findMany: vi.fn(async () => []) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/notifications/summary/route";
import { deriveNotificationKeys, encodeEventCursor, seenKey } from "../notifications/opaque";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  nextAction: { count: Fn; findMany: Fn };
  dmInquiry: { count: Fn; findMany: Fn };
  user: { findUnique: Fn };
  registryFetchJob: { findMany: Fn };
  registryFetchJobItem: { findMany: Fn };
};
const U = "11111111-1111-4111-8111-111111111111";
const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const KEYS = deriveNotificationKeys();
const grantPropertyRead = (on: boolean) =>
  (getUserPermissions as Fn).mockResolvedValue(on ? [{ resource: "property", action: "read", granted: true }] : []);
const call = async (qs = "") => {
  const res = await GET(new Request(`http://x/api/notifications/summary${qs}`) as never);
  // 応答の形の細部を読むだけのテスト用(型は lib/notifications/summary.ts の NotificationSummary)。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  grantPropertyRead(true);
  checkSaleDmAccessFor.mockResolvedValue({ ok: true });
  pm.user.findUnique.mockResolvedValue({ isActive: true, inquiryNotifyEnabled: true });
  pm.nextAction.count.mockResolvedValue(0);
  pm.nextAction.findMany.mockResolvedValue([]);
  pm.dmInquiry.count.mockResolvedValue(0);
  pm.dmInquiry.findMany.mockResolvedValue([]);
  pm.registryFetchJob.findMany.mockResolvedValue([]);
  pm.registryFetchJobItem.findMany.mockResolvedValue([]);
});

describe("通知の件数の窓口(設計書 §5.1)", () => {
  it("no-store で返す", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  describe("次回対応", () => {
    it("property:read が無ければ null・数えない", async () => {
      grantPropertyRead(false);
      const r = await call();
      expect(r.body.nextActions).toBeNull();
      expect(pm.nextAction.count).not.toHaveBeenCalled();
    });
    it("自分が担当・未完了だけ。今日=予定日が日本時間の今日、期限切れ=それより前(同じ件を二重に数えない)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T15:30:00Z")); // 日本時間 10/3 0:30
      await call();
      const wheres = pm.nextAction.count.mock.calls.map((c) => c[0].where);
      expect(wheres[0]).toEqual({ assignedTo: U, isCompleted: false, scheduledAt: new Date("2026-10-03T00:00:00.000Z") });
      expect(wheres[1]).toEqual({ assignedTo: U, isCompleted: false, scheduledAt: { lt: new Date("2026-10-03T00:00:00.000Z") } });
    });
    it("field_staff は物件の担当範囲を条件に畳み込む(次回対応の担当が自分でも、物件の担当外なら数えない)", async () => {
      (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
      await call();
      const scope = { OR: [{ createdBy: U }, { assignedTo: U }] };
      for (const c of [...pm.nextAction.count.mock.calls, ...pm.nextAction.findMany.mock.calls]) {
        expect(c[0].where.property).toEqual(scope);
      }
    });
    it("今が回に当たっている件だけ印を返す・印に生の ID を出さない", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T03:00:00Z")); // 日本時間 12:00 = 9:00 から3時間 → 1回目
      const updatedAt = new Date("2026-10-01T05:06:07.089Z");
      pm.nextAction.findMany.mockResolvedValue([
        { id: ID1, scheduledAt: new Date("2026-10-02T00:00:00Z"), updatedAt },
        { id: ID2, scheduledAt: new Date("2026-09-20T00:00:00Z"), updatedAt }, // 1週間を過ぎた=回なし
      ]);
      const r = await call();
      const T = Date.parse("2026-10-02T09:00:00+09:00");
      expect(r.body.nextActions.reminders).toEqual([
        { key: seenKey(KEYS, U, "next_action", [ID1, String(T), updatedAt.toISOString(), "1"]), slot: 1 },
      ]);
      expect(JSON.stringify(r.body)).not.toContain(ID1);
    });
    it("期限・版(updatedAt)が変われば別の印(期限の変更・担当 A→B→A で出直す)", () => {
      const T = "1";
      const a = seenKey(KEYS, U, "next_action", [ID1, T, "2026-10-01T00:00:00.000Z", "1"]);
      expect(seenKey(KEYS, U, "next_action", [ID1, "2", "2026-10-01T00:00:00.000Z", "1"])).not.toBe(a);
      expect(seenKey(KEYS, U, "next_action", [ID1, T, "2026-10-01T00:00:00.001Z", "1"])).not.toBe(a);
    });
  });

  describe("査定申込", () => {
    it("売却DMを使えない人には null(件数も数えない)", async () => {
      checkSaleDmAccessFor.mockResolvedValue({ ok: false, reason: "permission" });
      const r = await call();
      expect(r.body.inquiries).toBeNull();
      expect(pm.dmInquiry.count).not.toHaveBeenCalled();
    });
    it("通知 OFF・在籍していない人には未対応の件数だけ(新着は返さない)", async () => {
      pm.dmInquiry.count.mockResolvedValue(3);
      for (const u of [{ isActive: true, inquiryNotifyEnabled: false }, { isActive: false, inquiryNotifyEnabled: true }]) {
        pm.user.findUnique.mockResolvedValue(u);
        const r = await call();
        expect(r.body.inquiries).toEqual({ open: 3, newKeys: null, cursor: null, cursorAt: null });
      }
      expect(pm.dmInquiry.findMany).not.toHaveBeenCalled();
    });
    it("field_staff は担当の物件の申込だけ(申込一覧と同じ条件)", async () => {
      (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
      await call();
      expect(pm.dmInquiry.count.mock.calls[0][0].where).toEqual({
        draft: { property: { OR: [{ createdBy: U }, { assignedTo: U }] } },
        handleStatus: "open",
      });
    });
    it("初回は初期カーソルと、読み直し範囲にすでにある申込の印(見た扱い)を返し、新着は空", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T03:00:00.000Z"));
      pm.dmInquiry.findMany.mockResolvedValue([{ id: ID1, submittedAt: new Date("2026-10-02T02:58:00Z") }]);
      const r = await call();
      expect(r.body.inquiries.newKeys).toEqual([]);
      expect(r.body.inquiries.initialSeenKeys).toEqual([seenKey(KEYS, U, "inquiry", [ID1])]);
      expect(r.body.inquiries.cursorAt).toBe(Date.parse("2026-10-02T03:00:00.000Z"));
      const where = pm.dmInquiry.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain("2026-10-02T02:55:00.000Z"); // 5分前から
    });
    it("読めないカーソルは 400(黙って初期化しない)・別の利用者のカーソルも 400", async () => {
      expect((await call("?inquiryCursor=broken")).status).toBe(400);
      const other = encodeEventCursor(KEYS, "22222222-2222-4222-8222-222222222222", "inquiry", { t: new Date(), i: ID1 });
      expect((await call(`?inquiryCursor=${other}`)).status).toBe(400);
    });
    it("カーソルより後を昇順で取り、次のカーソルは①の最後(読み直しの古い行では戻らない)", async () => {
      const ct = new Date("2026-10-02T03:00:00.000Z");
      const cur = encodeEventCursor(KEYS, U, "inquiry", { t: ct, i: ID1 });
      pm.dmInquiry.findMany.mockImplementation(async (args: { where: unknown; orderBy: unknown }) => {
        const w = JSON.stringify(args.where);
        expect(args.orderBy).toEqual([{ submittedAt: "asc" }, { id: "asc" }]);
        if (w.includes('"gt":"2026-10-02T03:00:00.000Z"')) return [{ id: ID2, submittedAt: new Date("2026-10-02T03:01:00Z") }];
        return [{ id: ID1, submittedAt: new Date("2026-10-02T02:59:00Z") }];
      });
      const r = await call(`?inquiryCursor=${cur}`);
      expect(r.body.inquiries.cursorAt).toBe(Date.parse("2026-10-02T03:01:00Z"));
      expect(r.body.inquiries.newKeys).toEqual([seenKey(KEYS, U, "inquiry", [ID2]), seenKey(KEYS, U, "inquiry", [ID1])]);
      expect(r.body.inquiries.initialSeenKeys).toBeUndefined();
    });
    it("読み直しだけが返ってもカーソルは受け取った位置のまま", async () => {
      const ct = new Date("2026-10-02T03:00:00.000Z");
      const cur = encodeEventCursor(KEYS, U, "inquiry", { t: ct, i: ID1 });
      pm.dmInquiry.findMany.mockImplementation(async (args: { where: unknown }) =>
        JSON.stringify(args.where).includes('"gt"') ? [] : [{ id: ID2, submittedAt: new Date("2026-10-02T02:59:00Z") }],
      );
      const r = await call(`?inquiryCursor=${cur}`);
      expect(r.body.inquiries.cursorAt).toBe(ct.getTime());
    });
    it("読み直しは上限で切らずに全件めくる(100件を超えても)", async () => {
      const cur = encodeEventCursor(KEYS, U, "inquiry", { t: new Date("2026-10-02T03:00:00.000Z"), i: ID1 });
      const mk = (n: number) =>
        Array.from({ length: n }, (_, k) => ({ id: `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`, submittedAt: new Date("2026-10-02T02:58:00Z") }));
      let rereadCalls = 0;
      pm.dmInquiry.findMany.mockImplementation(async (args: { where: unknown }) => {
        if (JSON.stringify(args.where).includes('"gt":"2026-10-02T03:00:00.000Z"')) return [];
        rereadCalls += 1;
        return rereadCalls === 1 ? mk(100) : mk(30);
      });
      const r = await call(`?inquiryCursor=${cur}`);
      expect(rereadCalls).toBe(2);
      expect(r.body.inquiries.newKeys).toHaveLength(130);
    });
  });

  describe("謄本の一括取得", () => {
    it("自分が作った完了ジョブだけ・件数は今見られる物件の項目で数え直す・見える項目0件のジョブは返さない", async () => {
      (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
      const cur = encodeEventCursor(KEYS, U, "registry_job", { t: new Date("2026-10-02T03:00:00Z"), i: ID1 });
      pm.registryFetchJob.findMany.mockImplementation(async (args: { where: unknown }) =>
        JSON.stringify(args.where).includes('"gt"')
          ? [{ id: ID1, completedAt: new Date("2026-10-02T03:01:00Z") }, { id: ID2, completedAt: new Date("2026-10-02T03:02:00Z") }]
          : [],
      );
      const mine = { createdBy: U, assignedTo: null };
      const other = { createdBy: "x", assignedTo: "y" };
      pm.registryFetchJobItem.findMany.mockResolvedValue([
        { jobId: ID1, status: "done", property: mine },
        { jobId: ID1, status: "charged_but_failed", property: mine },
        { jobId: ID1, status: "failed", property: other }, // 担当外=数えない
        { jobId: ID1, status: "skipped", property: null }, // 削除済み=数えない
        { jobId: ID2, status: "done", property: other }, // 見える項目0件
      ]);
      const r = await call(`?registryCursor=${cur}`);
      const where = pm.registryFetchJob.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain(`"requestedById":"${U}"`);
      expect(JSON.stringify(where)).toContain('"status":"completed"');
      expect(r.body.registryJobs.completed).toEqual([
        { key: seenKey(KEYS, U, "registry_job", [ID1]), href: `/properties/registry-fetch/${ID1}`, done: 1, failed: 0, skipped: 0, chargedButFailed: 1 },
      ]);
    });
  });

  it("応答に PII(住所・名前・電話・本文)を入れない=select に含めない", async () => {
    await call();
    const selects = JSON.stringify([
      ...pm.nextAction.findMany.mock.calls.map((c) => c[0].select),
      ...pm.dmInquiry.findMany.mock.calls.map((c) => c[0].select),
      ...pm.registryFetchJob.findMany.mock.calls.map((c) => c[0].select),
    ]);
    for (const f of ["address", "name", "phone", "email", "message", "content", "handleNote"]) {
      expect(selects).not.toContain(`"${f}"`);
    }
  });
});
