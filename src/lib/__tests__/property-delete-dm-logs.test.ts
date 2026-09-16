/**
 * 物件削除とDM送付履歴の整合(PR-A・設計書§2.4 R49/R52)。
 *  - DELETE tx 内で「所有者の紐づけが全く無い行(ownerId=null かつ 連関0)」だけを行削除する
 *    (所有者付きの行は FK SET NULL で所有者側に残る=所有者横断の再送除外を守る)
 *  - 掃除は property.delete より前・attachment ゴミ箱入りは従来どおり
 *  - 削除確認ダイアログに「所有者に引き継がれる」注意書きがある
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTE = read("src/app/api/properties/[id]/route.ts");
const DETAIL_PAGE = read("src/app/(dashboard)/properties/[id]/page.tsx");
const LIST_PAGE = read("src/app/(dashboard)/properties/page.tsx");

describe("物件削除tx: 所有者ゼロのDM記録の掃除(R52)", () => {
  it("deleteMany の条件は ownerId=null かつ logOwners none(所有者付き行は消さない)", () => {
    expect(ROUTE).toMatch(
      /propertyDmLog\.deleteMany\(\{\s*where: \{ propertyId: id, ownerId: null, logOwners: \{ none: \{\} \} \},\s*\}\)/,
    );
  });

  it("親行ロック→掃除→property.delete の順(tx 内・attachment処理は従来どおり残る)", () => {
    const lockIdx = ROUTE.indexOf("lockPropertyRow(tx, id)");
    const purgeIdx = ROUTE.indexOf("propertyDmLog.deleteMany");
    const deleteIdx = ROUTE.indexOf("tx.property.delete", purgeIdx);
    const attachmentIdx = ROUTE.indexOf("tx.attachment.updateMany");
    expect(lockIdx).toBeGreaterThan(0); // 親→子の順序統一(#364 R9)
    expect(lockIdx).toBeLessThan(attachmentIdx);
    expect(purgeIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(purgeIdx);
    expect(attachmentIdx).toBeGreaterThan(0);
    expect(attachmentIdx).toBeLessThan(purgeIdx);
  });
});

describe("削除確認ダイアログの注意書き", () => {
  it("物件詳細・一覧(単体/一括)の確認文言に「所有者情報に引き継がれます」がある", () => {
    expect(DETAIL_PAGE).toContain("所有者に紐づくDMの反響・送付履歴は所有者情報に引き継がれます(紐づけの無い記録は削除されます)");
    const hits = LIST_PAGE.split("所有者に紐づくDMの反響・送付履歴は所有者情報に引き継がれます(紐づけの無い記録は削除されます)").length - 1;
    expect(hits).toBe(2); // 単体削除+一括削除
  });
});

// ---- 査定申込がある物件の削除(申込の個人情報は消さない=dm_inquiries.draft_id は RESTRICT) ----
const mocks = vi.hoisted(() => {
  const tx = {
    dmInquiry: { count: vi.fn() },
    propertyPhoto: { findMany: vi.fn() },
    attachment: { updateMany: vi.fn() },
    propertyDmLog: { deleteMany: vi.fn() },
    property: { delete: vi.fn() },
  };
  return {
    tx,
    findUnique: vi.fn(),
    lockPropertyRow: vi.fn(),
    order: [] as string[],
  };
});

vi.mock("next/server", () => ({ NextRequest: Request }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: mocks.findUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mocks.tx)),
  },
}));
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
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", email: "a@a", name: "A", role: "admin" }),
    getUserPermissions: vi.fn().mockResolvedValue([]),
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: "Server error", code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: mocks.lockPropertyRow }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => ({ delete: vi.fn() })) }));

import { DELETE } from "@/app/api/properties/[id]/route";

describe("物件削除: 査定申込がある物件は 409(HAS_DM_INQUIRIES)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.findUnique.mockResolvedValue({ id: "p1", address: "東京都", createdBy: "user-1", assignedTo: null });
    mocks.lockPropertyRow.mockImplementation(async () => {
      mocks.order.push("lock");
    });
    mocks.tx.dmInquiry.count.mockImplementation(async () => {
      mocks.order.push("count");
      return 1;
    });
    mocks.tx.propertyPhoto.findMany.mockResolvedValue([]);
  });

  it("申込が1件でもあれば 409・物件も子も消さない(件数は親行ロックの後に数える)", async () => {
    const res = await DELETE(new Request("http://localhost/api/properties/p1", { method: "DELETE" }) as never, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toEqual({ message: "査定申込がある物件は削除できません", code: "HAS_DM_INQUIRIES" });
    expect(mocks.tx.dmInquiry.count).toHaveBeenCalledWith({ where: { draft: { propertyId: "p1" } } });
    expect(mocks.order).toEqual(["lock", "count"]);
    expect(mocks.tx.property.delete).not.toHaveBeenCalled();
    expect(mocks.tx.propertyDmLog.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.attachment.updateMany).not.toHaveBeenCalled();
  });

  it("ソース上も 親行ロック → 申込の件数 → 添付のゴミ箱入り の順", () => {
    const lockIdx = ROUTE.indexOf("lockPropertyRow(tx, id)");
    const countIdx = ROUTE.indexOf("tx.dmInquiry.count");
    const attachmentIdx = ROUTE.indexOf("tx.attachment.updateMany");
    expect(countIdx).toBeGreaterThan(lockIdx);
    expect(countIdx).toBeLessThan(attachmentIdx);
  });
});
