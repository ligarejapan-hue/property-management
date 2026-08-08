/**
 * A-2b: 謄本PDF確定取込で PDF 本体を Attachment(type="registry") として保存する
 *       ことを検証する。
 *
 *  - multipart(PDF binary) → targetPropertyId 確定後に保存（Mode A/B 共通）。
 *  - text 貼り付けモード → PDF が無いため保存しない。
 *  - 保存先 key は properties/{propertyId}/registry/{timestamp}.pdf。
 *  - 保存失敗は取込本体を成功扱いのまま warning として返す（部分成功）。
 *  - AuditLog detail / レスポンスに載せるのは attachmentId のみ
 *    （fileUrl 全文 / PDF 本文 / rawText / 所有者名 / 住所は載せない）。
 *
 * 既存 registry-pdf 系テスト（field-scope / import-edited）と同じ mock 方式。
 * storage は本テストで新規にモックする（route が getStorage/upload を使うため）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn().mockResolvedValue([]),
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn().mockResolvedValue("dummy registry text"),
  isPdfBuffer: vi.fn().mockReturnValue(true),
}));

// storage はモジュール内 closure で安定した upload mock を保持し、
// getStorage() が常に同じ { upload } を返すようにする（テストから参照/制御可能）。
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: vi.fn(() => ({ upload, delete: del })),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: new Set(["application/pdf"]),
  };
});

// P2: registry PDF の storage key 一意化検証用に randomUUID を deterministic 化。
// 他の crypto API は実物を維持する。
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn() };
});

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // A-2c: Mode B でも owner 反映が走るため、owner 反映ケース(#12)用に owner/
    // propertyOwner/$transaction を mock する（既定は新規 owner 作成パス）。
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
  };
  // link の親行ロック(#364 R10): $transaction は callback に同じ db を渡す。
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { getStorage } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { POST as REGISTRY_PDF_POST } from "../../app/api/import/registry-pdf/route";

const SESSION_ID = "user-1";
const EXISTING_PROP_ID = "11111111-1111-4111-8111-111111111111";
const NEW_PROP_ID = "22222222-2222-4222-8222-222222222222";
const PDF_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // length 10

const pm = prisma as unknown as {
  property: {
    findUnique: Mock;
    findFirst: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

// getStorage() の factory は常に同じ closure { upload } を返すため、
// 毎回 getStorage().upload で安定した upload mock を取得できる。
function uploadMock(): Mock {
  return (getStorage() as unknown as { upload: Mock }).upload;
}

function deleteMock(): Mock {
  return (getStorage() as unknown as { delete: Mock }).delete;
}

function setSession(role = "admin") {
  (getApiSession as Mock).mockResolvedValue({
    id: SESSION_ID,
    role,
    email: "u@test",
    name: "U",
  });
}

function multipartReq(opts: { propertyId?: string } = {}) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([PDF_BYTES], { type: "application/pdf" }),
    "謄本.pdf",
  );
  if (opts.propertyId) form.append("propertyId", opts.propertyId);
  return new Request("http://test/api/import/registry-pdf", {
    method: "POST",
    body: form,
  }) as never;
}

function jsonReq(body: unknown) {
  return new Request("http://test/api/import/registry-pdf", {
    method: "POST",
    headers: { "content-type": "application/json" , "content-length": String(Buffer.byteLength(JSON.stringify(body))) },
    body: JSON.stringify(body),
  }) as never;
}

const MODE_B_PARSED = () => ({
  realEstateNumber: null,
  address: "東京都千代田区一番町1",
  lotNumber: null,
  buildingNumber: null,
  landCategory: null,
  area: null,
  owners: [],
  warnings: [],
  confidence: 0.9,
});

const MODE_A_PARSED = () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  setSession("admin");
  (hasPermission as Mock).mockReturnValue(true);
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.property.create.mockResolvedValue({ id: NEW_PROP_ID });
  pm.property.findFirst.mockResolvedValue(null);
  // P1: Attachment 保存前のスコープ確認用 findUnique 既定（admin はどの値でも許可）。
  pm.property.findUnique.mockResolvedValue({
    createdBy: SESSION_ID,
    assignedTo: null,
  });
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  // A-2c: owner 反映の既定（候補なし→新規作成パス。owner を持つ #12 用）。
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-x" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  uploadMock().mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  deleteMock().mockResolvedValue(undefined);
  (randomUUID as Mock).mockReturnValue("00000000-0000-4000-8000-000000000000");
  (parseRegistryText as Mock).mockReturnValue(MODE_B_PARSED());
});

function attachmentData() {
  return pm.attachment.create.mock.calls[0]?.[0]?.data as
    | Record<string, unknown>
    | undefined;
}

// ── multipart Mode B（新規 Property 作成）→ Attachment 保存 ──────────────────
describe("A-2b: multipart Mode B (新規Property) で Attachment 保存", () => {
  it("1. multipart PDF 取込で prisma.attachment.create が呼ばれる", async () => {
    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
  });

  it("2. 作成される Attachment が type:'registry'", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    expect(attachmentData()?.type).toBe("registry");
  });

  it("3+9. targetType/targetId/propertyId が新規 propertyId と一致", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    const d = attachmentData();
    expect(d?.targetType).toBe("property");
    expect(d?.targetId).toBe(NEW_PROP_ID);
    expect(d?.propertyId).toBe(NEW_PROP_ID);
  });

  it("4. key が properties/{propertyId}/registry/ 配下 (timestamp-uuid.pdf)", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    const opts = uploadMock().mock.calls[0]?.[1] as { key: string };
    // prefix 維持 + {Date.now()}-{randomUUID()}.pdf 形式（P2: 一意化）
    expect(opts.key).toMatch(
      new RegExp(
        `^properties/${NEW_PROP_ID}/registry/\\d+-[0-9a-fA-F-]{36}\\.pdf$`,
      ),
    );
  });

  it("5. mimeType が application/pdf（attachment + upload 両方）", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    expect(attachmentData()?.mimeType).toBe("application/pdf");
    const opts = uploadMock().mock.calls[0]?.[1] as { mimeType: string };
    expect(opts.mimeType).toBe("application/pdf");
  });

  it("6. fileSize が buffer.length(=10) と一致", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    expect(attachmentData()?.fileSize).toBe(PDF_BYTES.length);
  });

  it("7. uploadedBy が session.id", async () => {
    await REGISTRY_PDF_POST(multipartReq());
    expect(attachmentData()?.uploadedBy).toBe(SESSION_ID);
  });

  it("fileName は元ファイル名、レスポンスに attachmentId を返す", async () => {
    const res = await REGISTRY_PDF_POST(multipartReq());
    const body = await res.json();
    expect(attachmentData()?.fileName).toBe("謄本.pdf");
    expect(body.attachmentId).toBe("att-1");
    expect(body.propertyId).toBe(NEW_PROP_ID);
    expect(body.warning).toBeUndefined();
  });
});

// ── P2: storage key の一意化（同一 timestamp でも衝突しない）─────────────────
describe("A-2b/P2: registry PDF の storage key を一意化する", () => {
  it("同一 Date.now() でも 2 回の保存で key が異なる（randomUUID 由来）", async () => {
    const fixedTs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedTs);
    (randomUUID as Mock)
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    await REGISTRY_PDF_POST(multipartReq());
    await REGISTRY_PDF_POST(multipartReq());

    const key1 = (uploadMock().mock.calls[0]?.[1] as { key: string }).key;
    const key2 = (uploadMock().mock.calls[1]?.[1] as { key: string }).key;

    // 同一 timestamp prefix だが key は衝突しない
    expect(key1).not.toBe(key2);
    expect(key1).toBe(
      `properties/${NEW_PROP_ID}/registry/${fixedTs}-11111111-1111-4111-8111-111111111111.pdf`,
    );
    expect(key2).toBe(
      `properties/${NEW_PROP_ID}/registry/${fixedTs}-22222222-2222-4222-8222-222222222222.pdf`,
    );
    // prefix は維持されている
    expect(key1.startsWith(`properties/${NEW_PROP_ID}/registry/`)).toBe(true);
    expect(key2.startsWith(`properties/${NEW_PROP_ID}/registry/`)).toBe(true);

    nowSpy.mockRestore();
  });
});

// ── multipart Mode A（既存 Property 指定）→ Attachment 保存 ──────────────────
describe("A-2b: multipart Mode A (既存Property) でも Attachment 保存", () => {
  beforeEach(() => {
    (parseRegistryText as Mock).mockReturnValue(MODE_A_PARSED());
    pm.property.findUnique.mockResolvedValue({
      id: EXISTING_PROP_ID,
      createdBy: "someone-else",
      assignedTo: "another",
      registryStatus: "obtained",
      version: 0,
      realEstateNumber: "REN",
      lotNumber: "1",
      buildingNumber: "1",
    });
  });

  it("既存 propertyId 指定で Attachment(type=registry) が作成される", async () => {
    const res = await REGISTRY_PDF_POST(
      multipartReq({ propertyId: EXISTING_PROP_ID }),
    );
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    const d = attachmentData();
    expect(d?.type).toBe("registry");
    expect(d?.targetId).toBe(EXISTING_PROP_ID);
    expect(d?.propertyId).toBe(EXISTING_PROP_ID);
  });
});

// ── text 貼り付けモード → Attachment 作成しない ──────────────────────────────
describe("A-2b: text 貼り付けモードでは Attachment を作成しない", () => {
  it("8. JSON(text) 取込では attachment.create が呼ばれず warning も無い", async () => {
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "registry text" }));
    expect(res.status).toBe(201);
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(uploadMock()).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.attachmentId).toBeUndefined();
    expect(body.warning).toBeUndefined();
  });
});

// ── 保存失敗 → 取込本体は成功 + warning ─────────────────────────────────────
describe("A-2b: storage upload 失敗時は取込本体成功 + warning", () => {
  it("10. upload が失敗しても取込本体は 201 成功（property は作成済み）", async () => {
    uploadMock().mockRejectedValueOnce(new Error("disk full"));
    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.propertyId).toBe(NEW_PROP_ID);
    // import job は completed で finalize（failed にしない）
    expect(pm.importJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    // upload で失敗しているため attachment.create には到達しない
    expect(pm.attachment.create).not.toHaveBeenCalled();
  });

  it("11. upload 失敗時は warning を返し attachmentId は付かない", async () => {
    uploadMock().mockRejectedValueOnce(new Error("disk full"));
    const res = await REGISTRY_PDF_POST(multipartReq());
    const body = await res.json();
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("保存");
    expect(body.attachmentId).toBeUndefined();
  });
});

// ── 孤児ファイル防止: attachment.create 失敗時に uploaded PDF を best-effort 削除 ──
describe("A-2b/orphan: attachment.create 失敗時に uploaded PDF を best-effort 削除", () => {
  it("upload 成功後 attachment.create 失敗で getStorage().delete(uploaded.key) を呼ぶ", async () => {
    const KEY = "properties/p/registry/123-uuid.pdf";
    uploadMock().mockResolvedValue({ url: "/uploads/k.pdf", key: KEY });
    pm.attachment.create.mockRejectedValueOnce(new Error("db down"));

    const res = await REGISTRY_PDF_POST(multipartReq());

    // 取込本体は成功扱いのまま
    expect(res.status).toBe(201);
    // uploaded.key で best-effort 削除されている
    expect(deleteMock()).toHaveBeenCalledTimes(1);
    expect(deleteMock()).toHaveBeenCalledWith(KEY);
    const body = await res.json();
    expect(typeof body.warning).toBe("string");
    expect(body.attachmentId).toBeUndefined();
  });

  it("delete が失敗しても取込本体は成功し warning が返る", async () => {
    pm.attachment.create.mockRejectedValueOnce(new Error("db down"));
    deleteMock().mockRejectedValueOnce(new Error("delete failed"));

    const res = await REGISTRY_PDF_POST(multipartReq());

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.propertyId).toBe(NEW_PROP_ID);
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("保存");
    expect(body.attachmentId).toBeUndefined();
  });

  it("upload 自体が失敗した場合は delete を呼ばない（削除対象なし）", async () => {
    uploadMock().mockRejectedValueOnce(new Error("disk full"));

    const res = await REGISTRY_PDF_POST(multipartReq());

    expect(res.status).toBe(201);
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(deleteMock()).not.toHaveBeenCalled();
    const body = await res.json();
    expect(typeof body.warning).toBe("string");
  });

  it("正常時（create 成功）は delete を呼ばない", async () => {
    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(deleteMock()).not.toHaveBeenCalled();
  });
});

// ── AuditLog detail は attachmentId のみ（PII を載せない）────────────────────
describe("A-2b: AuditLog detail に attachmentId は載るが PII は載せない", () => {
  it("12. detail に attachmentId が入り fileUrl/rawText/所有者名/住所は入らない", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      ...MODE_B_PARSED(),
      // PII が detail に漏れないことの確認用に所有者・住所を持たせる
      owners: [{ name: "山田太郎", address: "東京都港区2", share: null }],
    });
    await REGISTRY_PDF_POST(multipartReq());

    const call = (writeAuditLog as Mock).mock.calls.find(
      (c) => c[0]?.targetTable === "properties",
    );
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.attachmentId).toBe("att-1");

    const keys = Object.keys(detail);
    expect(keys).not.toContain("fileUrl");
    expect(keys).not.toContain("rawText");
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("owners");
    expect(keys).not.toContain("ownerNames");
    expect(keys).not.toContain("address");

    // detail 全体を文字列化しても所有者名・住所・URL が含まれない
    const json = JSON.stringify(detail);
    expect(json).not.toContain("山田太郎");
    expect(json).not.toContain("東京都港区2");
    expect(json).not.toContain("/uploads/");
  });
});

// ── 既存挙動（A-2d スコープ / import:write）を壊さない ───────────────────────
describe("A-2b: 既存アクセス制御を壊さない（保存はアクセス許可後のみ）", () => {
  it("13a. import:write 無しは 403 で attachment 保存に到達しない", async () => {
    (hasPermission as Mock).mockReturnValue(false);
    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(403);
    expect(uploadMock()).not.toHaveBeenCalled();
    expect(pm.attachment.create).not.toHaveBeenCalled();
  });

  it("13b. field_staff がアクセス不可物件を指定すると 403 で保存しない", async () => {
    setSession("field_staff");
    (parseRegistryText as Mock).mockReturnValue(MODE_A_PARSED());
    pm.property.findUnique.mockResolvedValue({
      id: EXISTING_PROP_ID,
      createdBy: "someone-else",
      assignedTo: "another",
      registryStatus: "unconfirmed",
      version: 0,
      realEstateNumber: null,
      lotNumber: null,
      buildingNumber: null,
    });
    const res = await REGISTRY_PDF_POST(
      multipartReq({ propertyId: EXISTING_PROP_ID }),
    );
    expect(res.status).toBe(403);
    expect(uploadMock()).not.toHaveBeenCalled();
    expect(pm.attachment.create).not.toHaveBeenCalled();
  });
});

// ── P1: Mode B でも対象 property のスコープを確認してから保存 ────────────────
describe("A-2b/P1: Mode B で targetPropertyId のスコープ確認後に Attachment 保存", () => {
  const MATCHED_ID = "33333333-3333-4333-8333-333333333333";

  it("1+2. Mode B match で field_staff がアクセス不可なら upload も create も実行しない", async () => {
    setSession("field_staff");
    // 地番/住所マッチで既存物件に targetPropertyId が決まる
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
    // 対象 property は担当外/作成外 → field_staff はアクセス不可
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: "another",
    });

    const res = await REGISTRY_PDF_POST(multipartReq());

    // 取込本体（matched）は既存仕様どおり成功
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.propertyId).toBe(MATCHED_ID);
    // Attachment は作成されず、upload も実行されない（最優先要件）
    expect(uploadMock()).not.toHaveBeenCalled();
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(body.attachmentId).toBeUndefined();
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("アクセス");
  });

  it("3. Mode B で field_staff が作成者(アクセス可)なら Attachment 作成", async () => {
    setSession("field_staff");
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
    pm.property.findUnique.mockResolvedValue({
      createdBy: SESSION_ID, // 本人作成 → アクセス可
      assignedTo: null,
    });

    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    const d = attachmentData();
    expect(d?.type).toBe("registry");
    expect(d?.targetId).toBe(MATCHED_ID);
    const body = await res.json();
    expect(body.attachmentId).toBe("att-1");
    expect(body.warning).toBeUndefined();
  });

  it("3b. Mode B で field_staff が担当(assignedTo)物件ならアクセス可で作成", async () => {
    setSession("field_staff");
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: SESSION_ID, // 担当者 → アクセス可
    });

    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(attachmentData()?.targetId).toBe(MATCHED_ID);
  });

  it("4. office_staff は担当外物件でも従来どおり Attachment 作成（既存挙動維持）", async () => {
    setSession("office_staff");
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: "another",
    });

    const res = await REGISTRY_PDF_POST(multipartReq());
    expect(res.status).toBe(201);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(attachmentData()?.targetId).toBe(MATCHED_ID);
  });
});

// ── source-assertion: 実装の固定化 ─────────────────────────────────────────
const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
// PR1: 取込コアは @/lib/registry-pdf/process へ移動。実装の所在に依存しないよう
// route.ts + process.ts の連結に対して source-assertion を行う。
const routeSrc =
  read("src/app/api/import/registry-pdf/route.ts") +
  "\n" +
  read("src/lib/registry-pdf/process.ts");

describe("A-2b: registry-pdf route source-assertion", () => {
  it("14. route.ts は POST handler のみ export している", () => {
    // export 検証だけは route.ts 単独で行う（handler 以外を export しないことの確認）。
    const routeOnlySrc = read("src/app/api/import/registry-pdf/route.ts");
    const exports =
      routeOnlySrc.match(/^export (async function|function|const) \w+/gm) || [];
    expect(exports.join("\n")).toMatch(/export async function POST/);
    expect(exports.length).toBe(1);
  });

  it("storage(getStorage/validateFile/ALLOWED_ATTACHMENT_MIMES) を利用する", () => {
    expect(routeSrc).toMatch(
      /import \{[\s\S]*?getStorage,[\s\S]*?\} from "@\/lib\/storage"/,
    );
    expect(routeSrc).toMatch(/getStorage\(\)\.upload\(/);
    expect(routeSrc).toMatch(/validateFile\(/);
  });

  it("type:'registry' / key は properties/{id}/registry 配下で一意化(P2)", () => {
    expect(routeSrc).toMatch(/type: "registry"/);
    // P2: prefix 維持 + {Date.now()}-{randomUUID()}.pdf で一意化
    expect(routeSrc).toMatch(
      /properties\/\$\{targetPropertyId\}\/registry\/\$\{Date\.now\(\)\}-\$\{randomUUID\(\)\}\.pdf/,
    );
    expect(routeSrc).toMatch(
      /import \{ randomUUID \} from "node:crypto"/,
    );
  });

  it("AuditLog/本文に rawText を増やしていない", () => {
    expect(routeSrc).not.toMatch(/rawText/);
  });

  it("P1: Attachment 書き込み前に canAccessPropertyRecord でスコープ確認する", () => {
    // 保存前に対象 property の createdBy/assignedTo を取得しスコープ判定している
    expect(routeSrc).toMatch(/canAccessPropertyRecord\(session, target\)/);
    expect(routeSrc).toMatch(
      /findUnique\(\{[\s\S]*?id: targetPropertyId[\s\S]*?createdBy: true[\s\S]*?assignedTo: true/,
    );
  });

  it("孤児防止: uploaded.key を保持し catch で getStorage().delete を best-effort 実行", () => {
    expect(routeSrc).toMatch(/uploadedKey = uploaded\.key/);
    // upload 成功時のみ（uploadedKey 非 null）削除する
    expect(routeSrc).toMatch(
      /if \(uploadedKey\) \{[\s\S]*?getStorage\(\)\.delete\(uploadedKey\)/,
    );
  });
});
