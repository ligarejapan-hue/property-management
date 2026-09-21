/**
 * D10: 謄本の自動取得(runRegistryAutoFetch)は、コア処理(processRegistryPdf)が
 * 「編集中の鍔のため物件/所有者の補完を見送った」ことを返しても、そのままでは
 * 監査(AuditLog action=registry_auto_fetch)に載らない。
 *
 * ⚠**auto-fetch.ts は detail を自分で組み立てている**(processRegistryPdf の戻り値を
 *   そのまま展開していない・@codex R7 P2)。processRegistryPdf の戻り値にフラグを
 *   足すだけでは監査に出ないため、auto-fetch.ts 側で detail に転記していることを
 *   ここで固定する。
 *
 * 既存の PR4 テスト(registry-auto-fetch-api.test.ts)と同じ mock 方式に、
 * 編集中の鍵まわり(property-record-guard / edit-lock/row-locks / edit-lock/service)の
 * モックを足す。isResourceEditLocked は Task 3 実装済みインターフェースをモックする
 * (brief のモック骨子 readEditLocks は古い)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    providerCode?: string;
    constructor(status: number, message: string, code = "ERROR", providerCode?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.providerCode = providerCode;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (req: Request) => {
      const t = await req.text();
      return t.trim() === "" ? {} : JSON.parse(t);
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn(),
}));
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: vi.fn(() => ({ upload, delete: del })),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: new Set(["application/pdf"]),
  };
});
// 法人番号の検出。既定は候補ゼロ、当テストのみ1件返させて「save」判定を実際に走らせる。
vi.mock("@/lib/corporate-number", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    detectCorporateNumberInOwnerLike: vi.fn(() => ({ candidates: [] })),
  };
});
// D10: 編集中の鍵まわり。isResourceEditLocked を直接制御して、property/owner
// どちらも「今まさに編集中」を模擬する(Task 3 実装済みインターフェース)。
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/row-locks", () => ({ lockOwnerRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ isResourceEditLocked: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    owner: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    propertyOwner: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage } from "@/lib/storage";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { MockRegistryFetchProvider } from "@/lib/registry-fetch";
import { runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";

const PROP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = { id: "user-1", role: "admin" };
const PROVIDER_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5, 6]);

const pm = prisma as unknown as {
  property: { findUnique: Mock; update: Mock; updateMany: Mock; findFirst: Mock; create: Mock };
  owner: { findUnique: Mock; findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock; findFirst: Mock; count: Mock };
  auditLog: { findFirst: Mock; create: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
};

function uploadMock(): Mock {
  return (getStorage() as unknown as { upload: Mock }).upload;
}

function setProperty(over: Record<string, unknown> = {}) {
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: "user-1",
    assignedTo: null,
    registryStatus: "unconfirmed",
    version: 3,
    realEstateNumber: null,
    lotNumber: null,
    buildingNumber: null,
    ...over,
  });
}

/**
 * その物件に既に紐づいている、住所なしの所有者(自動取得側)を仕込む。
 * ⚠`owner.findUnique`(ロック後の読み直し・レビュー round1 #3)も揃える。
 */
function linkedOwner(overrides: { corporateNumber?: string | null } = {}) {
  const corporateNumber = overrides.corporateNumber ?? null;
  pm.propertyOwner.findMany.mockResolvedValue([
    {
      owner: {
        id: "owner-existing",
        name: "山田太郎",
        address: null,
        isArchived: false,
        corporateNumber,
      },
    },
  ]);
  pm.owner.findUnique.mockResolvedValue({ corporateNumber });
}

beforeEach(() => {
  vi.clearAllMocks();
  setProperty();
  pm.auditLog.findFirst.mockResolvedValue(null);
  pm.auditLog.create.mockResolvedValue({ id: "ledger-1" });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.property.update.mockResolvedValue({});
  pm.property.findFirst.mockResolvedValue(null);
  pm.property.create.mockResolvedValue({ id: PROP_ID });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.attachment.count.mockResolvedValue(0);
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.findUnique.mockResolvedValue({ corporateNumber: null });
  pm.owner.create.mockResolvedValue({ id: "owner-x" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.findMany.mockResolvedValue([]);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  uploadMock().mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: null,
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [],
    warnings: [],
    confidence: 0.9,
  });
  (extractTextFromPdf as Mock).mockResolvedValue("dummy registry text");
  (isPdfBuffer as Mock).mockReturnValue(true);
  (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);
});

function autoFetchAuditCall() {
  return (writeAuditLog as Mock).mock.calls.find(
    (c) => c[0]?.action === "registry_auto_fetch" && c[0]?.detail?.status === "success",
  );
}

function runLib() {
  const provider = new MockRegistryFetchProvider({
    providerRequestId: "req-mock",
    now: new Date(0),
    pdfBuffer: PROVIDER_PDF,
  } as unknown as Record<string, unknown>);
  return runRegistryAutoFetch({ session: SESSION, propertyId: PROP_ID, confirmed: true }, provider);
}

describe("D10: 自動取得の監査detailに編集中の鍵フラグが載る", () => {
  it("鍵が無ければ、両方のフラグとも false のまま監査に載る", async () => {
    await runLib();
    const call = autoFetchAuditCall();
    expect(call).toBeTruthy();
    expect(call![0].detail.propertyFillSkippedByEditLock).toBe(false);
    expect(call![0].detail.ownerCorporateFillSkippedByEditLock).toBe(false);
  });

  it("見送りが起きた実行では、監査detailに両方のフラグの値が入る(@codex R7 P2)", async () => {
    setProperty({
      registryStatus: "unconfirmed",
      realEstateNumber: null,
      lotNumber: null,
      buildingNumber: null,
    });
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: "0100012345678",
      address: "東京都千代田区一番町1",
      lotNumber: "1番",
      buildingNumber: "2号",
      landCategory: null,
      area: null,
      owners: [{ name: "山田太郎", address: null, share: null }],
      warnings: [],
      confidence: 0.9,
    });
    linkedOwner({ corporateNumber: null });
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    // 物件・所有者のどちらも「今まさに編集中」を模擬する。
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);

    await runLib();

    const call = autoFetchAuditCall();
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.propertyFillSkippedByEditLock).toBe(true);
    expect(detail.ownerCorporateFillSkippedByEditLock).toBe(true);
    // 空欄補完・法人番号補完は実際に書かれていない(見送りが本物であること)。
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
});
