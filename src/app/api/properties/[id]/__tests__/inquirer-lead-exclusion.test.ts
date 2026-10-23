import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// GET/PATCH /api/properties/[id] — 問い合わせ者・除外申請(2026-10-24 従業員の指摘 第2弾)。
// mock の形は unit-only-fields-patch.test.ts を写す。⚠権限は本物(@/lib/permissions)で判定させる。

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
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn((x: unknown) => x) }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
vi.mock("@/lib/building-link/apply", () => ({
  finalBuildingFields: vi.fn(),
  applyBuildingLink: vi.fn(),
  writeBuildingLinkAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    importJobRow: { findFirst: vi.fn() },
    attachment: { groupBy: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { GET, PATCH } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; findUniqueOrThrow: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  importJobRow: { findFirst: Mock };
  attachment: { groupBy: Mock };
  $transaction: Mock;
};
const prismaMock = prisma as unknown as PrismaMock;
const txMock = { property: { updateMany: vi.fn() }, $queryRaw: vi.fn(async () => []) };

const P = (resource: string, action: string) => ({ resource, action, granted: true });
const PERMS_EDITOR = [P("property", "read"), P("property", "write"), P("owner", "read"), P("owner_name", "full")];
const PERMS_NO_OWNER_NAME_WRITE = [P("property", "read"), P("property", "write"), P("owner", "read"), P("owner_name", "partial")];
const PERMS_NO_OWNER = [P("property", "read"), P("property", "write")];

const CURRENT = {
  id: "p1",
  version: 1,
  createdBy: "user-1",
  assignedTo: null,
  propertyType: "land",
  address: "東京都目黒区1-1",
  postalCode: null,
  lotNumber: null,
  buildingNumber: null,
  buildingName: null,
  buildingId: null,
  realEstateNumber: null,
  registryStatus: "unconfirmed",
  dmStatus: "hold",
  caseStatus: "contacting_owner",
  contractPlannedOn: null,
  settlementPlannedOn: null,
  introductionRoute: "bulk_assessment",
  inquirerName: "山田花子様",
  leadExclusionStatus: null,
  leadExclusionRequestedAt: null,
  leadExclusionDecidedAt: null,
  dmScenarioId: null,
  note: null,
};
const FULL_ROW = {
  ...CURRENT,
  assignee: null,
  creator: null,
  building: null,
  propertyOwners: [],
  photos: [],
  nextActions: [],
};

const ctx = { params: Promise.resolve({ id: "p1" }) };
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/properties/p1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Edit-Screen": "screen-1" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
const getReq = () => new Request("http://localhost/api/properties/p1") as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_EDITOR);
  (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "full" });
  prismaMock.property.findUnique.mockResolvedValue(CURRENT);
  prismaMock.property.findUniqueOrThrow.mockResolvedValue({ ...FULL_ROW, version: 2 });
  prismaMock.changeLog.createMany.mockResolvedValue({ count: 0 });
  prismaMock.importJobRow.findFirst.mockResolvedValue(null);
  prismaMock.attachment.groupBy.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));
  txMock.property.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

const sentData = () => txMock.property.updateMany.mock.calls[0][0].data as Record<string, unknown>;
const changeLogs = () =>
  (prismaMock.changeLog.createMany.mock.calls[0]?.[0]?.data ?? []) as Array<{ fieldName: string; oldValue: string | null; newValue: string | null }>;

describe("GET /api/properties/[id] — 問い合わせ者", () => {
  it("owner:read あり・full → そのまま", async () => {
    prismaMock.property.findUnique.mockResolvedValue(FULL_ROW);
    const body = await (await GET(getReq(), ctx)).json();
    expect(body.inquirerName).toBe("山田花子様");
  });
  it("partial → 伏せる", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "partial" });
    prismaMock.property.findUnique.mockResolvedValue(FULL_ROW);
    const body = await (await GET(getReq(), ctx)).json();
    expect(body.inquirerName).toBe("山田花***");
  });
  it("owner:read なし → キーごと返さない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_OWNER);
    prismaMock.property.findUnique.mockResolvedValue(FULL_ROW);
    const body = await (await GET(getReq(), ctx)).json();
    expect(body).not.toHaveProperty("inquirerName");
    expect(JSON.stringify(body)).not.toContain("山田花子");
  });
  it("除外申請の日付は YYYY-MM-DD", async () => {
    prismaMock.property.findUnique.mockResolvedValue({
      ...FULL_ROW,
      leadExclusionStatus: "approved",
      leadExclusionRequestedAt: new Date("2026-10-10T00:00:00.000Z"),
      leadExclusionDecidedAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    const body = await (await GET(getReq(), ctx)).json();
    expect(body.leadExclusionRequestedAt).toBe("2026-10-10");
    expect(body.leadExclusionDecidedAt).toBe("2026-10-20");
  });
});

describe("PATCH /api/properties/[id] — 問い合わせ者", () => {
  it("owner:read+owner_name の書き込みがあれば保存・履歴に残し、監査ログには氏名を入れない", async () => {
    const res = await PATCH(patchReq({ version: 1, inquirerName: "  佐藤一郎  " }), ctx);
    expect(res.status).toBe(200);
    expect(sentData().inquirerName).toBe("佐藤一郎");
    expect(changeLogs()).toContainEqual(
      expect.objectContaining({ fieldName: "inquirerName", oldValue: "山田花子様", newValue: "佐藤一郎" }),
    );
    const audit = JSON.stringify(vi.mocked(writeAuditLog).mock.calls);
    expect(audit).not.toContain("佐藤一郎");
    expect(audit).not.toContain("山田花子");
    expect(audit).toContain("inquirerName");
  });
  it("空にしたら null(消す)", async () => {
    await PATCH(patchReq({ version: 1, inquirerName: "   " }), ctx);
    expect(sentData().inquirerName).toBeNull();
  });
  it("owner_name を書けない人は 403(保存しない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_OWNER_NAME_WRITE);
    const res = await PATCH(patchReq({ version: 1, inquirerName: "佐藤一郎" }), ctx);
    expect(res.status).toBe(403);
    expect(txMock.property.updateMany).not.toHaveBeenCalled();
  });
  it("owner:read が無い人は消すこともできない(403)", async () => {
    (getUserPermissions as Mock).mockResolvedValue([...PERMS_NO_OWNER, P("owner_name", "full")]);
    const res = await PATCH(patchReq({ version: 1, inquirerName: null }), ctx);
    expect(res.status).toBe(403);
  });
  it("上限(100文字)を超えたら断る", async () => {
    const res = await PATCH(patchReq({ version: 1, inquirerName: "あ".repeat(101) }), ctx);
    expect(res.status).not.toBe(200);
    expect(txMock.property.updateMany).not.toHaveBeenCalled();
  });
  it("問い合わせ者を送らない保存は権限を問わない・応答も owner:read が無ければ返さない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_OWNER);
    const res = await PATCH(patchReq({ version: 1, note: "メモ" }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("inquirerName");
  });
});

describe("PATCH /api/properties/[id] — 除外申請", () => {
  it("申請中にして日付が無ければ今日(JST)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T15:30:00.000Z")); // JST 10/25
    const res = await PATCH(patchReq({ version: 1, leadExclusionStatus: "requested" }), ctx);
    expect(res.status).toBe(200);
    expect(sentData()).toMatchObject({
      leadExclusionStatus: "requested",
      leadExclusionRequestedAt: new Date("2026-10-25T00:00:00.000Z"),
      leadExclusionDecidedAt: null,
    });
    expect(changeLogs()).toContainEqual(
      expect.objectContaining({ fieldName: "leadExclusionRequestedAt", oldValue: null, newValue: "2026-10-25" }),
    );
  });
  it("申請した日を指定", async () => {
    await PATCH(patchReq({ version: 1, leadExclusionStatus: "requested", leadExclusionRequestedAt: "2026-10-20" }), ctx);
    expect(sentData().leadExclusionRequestedAt).toEqual(new Date("2026-10-20T00:00:00.000Z"));
  });
  it("除外された: 結果の日", async () => {
    prismaMock.property.findUnique.mockResolvedValue({
      ...CURRENT,
      leadExclusionStatus: "requested",
      leadExclusionRequestedAt: new Date("2026-10-10T00:00:00.000Z"),
    });
    await PATCH(patchReq({ version: 1, leadExclusionStatus: "approved", leadExclusionDecidedAt: "2026-10-22" }), ctx);
    expect(sentData()).toMatchObject({
      leadExclusionStatus: "approved",
      leadExclusionDecidedAt: new Date("2026-10-22T00:00:00.000Z"),
    });
    expect(sentData()).not.toHaveProperty("leadExclusionRequestedAt");
  });
  it("取り消すと日付も消える", async () => {
    prismaMock.property.findUnique.mockResolvedValue({
      ...CURRENT,
      leadExclusionStatus: "rejected",
      leadExclusionRequestedAt: new Date("2026-10-10T00:00:00.000Z"),
      leadExclusionDecidedAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    await PATCH(patchReq({ version: 1, leadExclusionStatus: null }), ctx);
    expect(sentData()).toMatchObject({
      leadExclusionStatus: null,
      leadExclusionRequestedAt: null,
      leadExclusionDecidedAt: null,
    });
  });
  it("知らない状態・壊れた日付は断る", async () => {
    expect((await PATCH(patchReq({ version: 1, leadExclusionStatus: "done" }), ctx)).status).not.toBe(200);
    expect(
      (await PATCH(patchReq({ version: 1, leadExclusionStatus: "requested", leadExclusionRequestedAt: "2026-02-30" }), ctx))
        .status,
    ).not.toBe(200);
    expect(txMock.property.updateMany).not.toHaveBeenCalled();
  });
  it("書けるのは物件の編集と同じ(owner の権限は要らない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_OWNER);
    const res = await PATCH(patchReq({ version: 1, leadExclusionStatus: "requested" }), ctx);
    expect(res.status).toBe(200);
  });
});
