/**
 * 「謄本から所有者をまとめて反映」の受付。
 *
 * ⚠ここで守りたい事故:
 *  1. **権限の抜け**             → 管理者+取込+所有者の編集+氏名・住所の項目権限が必須
 *  2. **件数の取り違え**         → 既定100件・不正な件数は受け付けない
 *  3. **所有者がいる物件に入れる** → 対象は「所有者が空」かつ「所有者事項の謄本あり」
 *  4. **二重に走らせる**         → 処理中の反映があるときは受け付けない
 *  5. **取込記録にPIIを残す**     → 行に残すのは物件IDと物件の住所だけ
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json(
      { error: { message: e?.message, code: e?.code } },
      { status: e?.status ?? 500 },
    ),
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/registry-pdf-bulk/worker", () => ({
  enqueueRegistryPdfBulkJob: vi.fn(),
  isRegistryPdfBulkWorkerBusy: vi.fn(() => false),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { count: vi.fn() },
    attachment: { findMany: vi.fn() },
    importJob: { create: vi.fn(), findFirst: vi.fn() },
    importJobRow: { createMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
} from "@/lib/registry-pdf-bulk/worker";
import { GET, POST } from "@/app/api/import/registry-owner-apply/route";

const pm = prisma as unknown as {
  property: { count: Mock };
  attachment: { findMany: Mock };
  importJob: { create: Mock; findFirst: Mock };
  importJobRow: { createMany: Mock };
};

const ALL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "edit", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
];

const postRequest = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;

/** 添付(古い順)の取り出し結果。物件の住所は物件の情報として付いてくる。 */
const attachmentRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    propertyId: `1111111${i}-1111-4111-8111-11111111111${i}`,
    property: { address: `東京都渋谷区神宮前三丁目${i + 1}-1` },
  }));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(ALL_PERMS);
  (isRegistryPdfBulkWorkerBusy as unknown as Mock).mockReturnValue(false);
  pm.property.count.mockResolvedValue(1821);
  pm.attachment.findMany.mockResolvedValue(attachmentRows(2));
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.findFirst.mockResolvedValue(null);
  pm.importJobRow.createMany.mockResolvedValue({ count: 2 });
});

describe("GET（対象件数）", () => {
  it("対象の件数と既定の件数を返す", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.targetCount).toBe(1821);
    expect(body.defaultLimit).toBe(100);
    expect(body.maxLimit).toBeGreaterThanOrEqual(1821);
    expect(body.busy).toBe(false);
  });

  it("⚠対象は「所有者が空」かつ「所有者事項の謄本あり」だけ", async () => {
    await GET();
    const where = pm.property.count.mock.calls[0][0].where;
    expect(where.propertyOwners).toEqual({ none: {} });
    expect(where.attachments.some).toMatchObject({
      type: "registry",
      isDeleted: false,
      registryCertificateType: "owner",
    });
  });

  it("管理者以外は 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "user-1", role: "office_staff" });
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe("POST（実行）", () => {
  it("取込ジョブを作り、裏の処理に渡す", async () => {
    const res = await POST(postRequest({ limit: 2 }));
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.jobId).toBe("job-1");
    expect(body.totalRows).toBe(2);
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith("job-1");
  });

  it("⚠既存の「所有者事項PDF一括」に相乗りし、生ファイル名ではない固定の名前で残す", async () => {
    await POST(postRequest({ limit: 2 }));
    const data = pm.importJob.create.mock.calls[0][0].data;
    expect(data.jobType).toBe("registry_pdf_bulk");
    expect(data.fileName).toBe("謄本から所有者をまとめて反映");
    expect(data.executedBy).toBe("user-1");
    expect(data.totalRows).toBe(2);
  });

  it("⚠行に残すのは物件IDと物件の住所だけ（所有者の氏名・住所は残さない）", async () => {
    await POST(postRequest({ limit: 2 }));
    const rows = pm.importJobRow.createMany.mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.jobId).toBe("job-1");
      expect(row.status).toBe("pending");
      const raw = row.rawData as Record<string, string>;
      expect(Object.keys(raw).sort()).toEqual(["__kind", "address", "propertyId"].sort());
    }
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it("⚠古い謄本から順に処理する（指定件数だけ取り出す）", async () => {
    await POST(postRequest({ limit: 100 }));
    const args = pm.attachment.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(100);
    expect(args.where).toMatchObject({
      type: "registry",
      isDeleted: false,
      registryCertificateType: "owner",
    });
    expect(args.where.property).toEqual({ propertyOwners: { none: {} } });
  });

  it("件数の指定が無ければ既定（100件）", async () => {
    await POST(postRequest({}));
    expect(pm.attachment.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("本文が無くても既定で動く", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(202);
    expect(pm.attachment.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("⚠不正な件数は 400（黙って直さない）", async () => {
    for (const bad of [0, -5, 1.5, "100", 99999]) {
      vi.clearAllMocks();
      (getApiSession as unknown as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
      (getUserPermissions as unknown as Mock).mockResolvedValue(ALL_PERMS);
      const res = await POST(postRequest({ limit: bad }));
      expect(res.status).toBe(400);
      expect(pm.importJob.create).not.toHaveBeenCalled();
    }
  });

  it("⚠管理者以外・権限が足りないときは 403（ジョブを作らない）", async () => {
    const cases: Array<[string, unknown]> = [
      ["office_staff", ALL_PERMS],
      ["admin", ALL_PERMS.filter((p) => p.resource !== "import")],
      ["admin", ALL_PERMS.filter((p) => p.resource !== "owner")],
      ["admin", ALL_PERMS.filter((p) => p.resource !== "owner_name")],
      ["admin", ALL_PERMS.filter((p) => p.resource !== "owner_address")],
    ];
    for (const [role, perms] of cases) {
      vi.clearAllMocks();
      (getApiSession as unknown as Mock).mockResolvedValue({ id: "user-1", role });
      (getUserPermissions as unknown as Mock).mockResolvedValue(perms);
      const res = await POST(postRequest({ limit: 2 }));
      expect(res.status).toBe(403);
      expect(pm.importJob.create).not.toHaveBeenCalled();
      expect(enqueueRegistryPdfBulkJob).not.toHaveBeenCalled();
    }
  });

  it("⚠まだ終わっていない反映があるときは受け付けない（二重に走らせない）", async () => {
    pm.importJob.findFirst.mockResolvedValue({ id: "job-old" });
    const res = await POST(postRequest({ limit: 2 }));
    expect(res.status).toBe(409);
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("⚠ほかの取込が処理中のときは受け付けない（同時に走らせない）", async () => {
    (isRegistryPdfBulkWorkerBusy as unknown as Mock).mockReturnValue(true);
    const res = await POST(postRequest({ limit: 2 }));
    expect(res.status).toBe(409);
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("対象が0件ならジョブを作らない", async () => {
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(postRequest({ limit: 2 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalRows).toBe(0);
    expect(body.jobId).toBeNull();
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(enqueueRegistryPdfBulkJob).not.toHaveBeenCalled();
  });

  it("⚠監査記録に氏名・住所を残さない（件数とジョブIDだけ）", async () => {
    await POST(postRequest({ limit: 2 }));
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = (writeAuditLog as unknown as Mock).mock.calls[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.targetTable).toBe("import_jobs");
    expect(call.targetId).toBe("job-1");
    expect(Object.keys(call.detail).sort()).toEqual(["jobId", "totalRows"].sort());
    expect(JSON.stringify(call)).not.toContain("神宮前");
  });
});
