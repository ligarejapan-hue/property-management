import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 通知 段階3: 次回対応の「時刻(任意)」。"HH:MM"(24時間・日本時間)だけ受け付け、null で外せる。
// 知らせの版(reminderRevAt)は DB のトリガーだけが書く=API からは書かない。

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; name?: string }) =>
    e?.name === "ZodError"
      ? Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 })
      : Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-record-guard")>()),
  assertPropertyRecordAccess: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    nextAction: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { PATCH } from "../route";
import { POST } from "../../route";

type Tx = {
  $queryRaw: Mock;
  nextAction: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock; create: Mock };
};
const pm = prisma as unknown as { nextAction: { findUnique: Mock }; $transaction: Mock };

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ACTION = "55555555-5555-4555-8555-555555555555";
const USER = "22222222-2222-4222-8222-222222222222";
let tx: Tx;

const req = (method: string, url: string, body: unknown) =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;
const patch = (body: unknown) =>
  PATCH(req("PATCH", `http://x/api/properties/${PROPERTY}/next-actions/${ACTION}`, body), {
    params: Promise.resolve({ id: PROPERTY, actionId: ACTION }),
  });
const post = (body: unknown) =>
  POST(req("POST", `http://x/api/properties/${PROPERTY}/next-actions`, body), { params: Promise.resolve({ id: PROPERTY }) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: USER, role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue({});
  pm.nextAction.findUnique.mockResolvedValue({ id: ACTION, propertyId: PROPERTY, isCompleted: false });
  tx = {
    $queryRaw: vi.fn(async () => [{ id: PROPERTY }]),
    nextAction: {
      findUnique: vi.fn(async () => ({ isCompleted: false })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: ACTION })),
      create: vi.fn(async (a: { data: unknown }) => ({ id: ACTION, ...(a.data as object) })),
    },
  };
  pm.$transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
});

const base = { assignedTo: USER, scheduledAt: "2026-10-03", content: "電話する" };

describe("作成(POST)の時刻", () => {
  it("HH:MM を保存する", async () => {
    expect((await post({ ...base, scheduledTime: "15:00" })).status).toBe(201);
    expect(tx.nextAction.create.mock.calls[0][0].data.scheduledTime).toBe("15:00");
  });
  it("時刻なしは null で保存する(今までどおり)", async () => {
    expect((await post(base)).status).toBe(201);
    expect(tx.nextAction.create.mock.calls[0][0].data.scheduledTime).toBeNull();
  });
  it("形の違う時刻は 422(24:00・9:00・秒つき)", async () => {
    for (const t of ["24:00", "9:00", "15:00:00", "abc"]) {
      expect((await post({ ...base, scheduledTime: t })).status, t).toBe(422);
    }
    expect(tx.nextAction.create).not.toHaveBeenCalled();
  });
  it("知らせの版(reminderRevAt)は API から書かない", async () => {
    await post({ ...base, scheduledTime: "15:00", reminderRevAt: "2030-01-01T00:00:00Z" });
    expect("reminderRevAt" in tx.nextAction.create.mock.calls[0][0].data).toBe(false);
  });
});

describe("変更(PATCH)の時刻", () => {
  it("時刻を変えられる・null で外せる・送らなければ触らない", async () => {
    await patch({ scheduledTime: "08:30" });
    expect(tx.nextAction.updateMany.mock.calls[0][0].data.scheduledTime).toBe("08:30");
    await patch({ scheduledTime: null });
    expect(tx.nextAction.updateMany.mock.calls[1][0].data.scheduledTime).toBeNull();
    await patch({ content: "x" });
    expect("scheduledTime" in tx.nextAction.updateMany.mock.calls[2][0].data).toBe(false);
  });
  it("形の違う時刻は 422", async () => {
    expect((await patch({ scheduledTime: "25:00" })).status).toBe(422);
  });
  it("知らせの版(reminderRevAt)は API から書かない", async () => {
    await patch({ scheduledTime: "08:30", reminderRevAt: "2030-01-01T00:00:00Z" });
    expect("reminderRevAt" in tx.nextAction.updateMany.mock.calls[0][0].data).toBe(false);
  });
});
