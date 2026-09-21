/**
 * 添付済みの謄本から所有者を登録する API の振る舞いを固定する。
 *
 * ⚠ここで守りたい事故:
 *  1. **同じ謄本がもう一度添付される**   → `pdfBuffer` は必ず null で渡す
 *  2. **全部事項から所有者を登録する**   → 取り出すのは種別 "owner" だけ
 *  3. **既に所有者がいる物件への二重登録** → 409 で止める(取込処理を呼ばない)
 *  4. **下見が保存してしまう**           → GET では取込処理を呼ばない
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
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(() => true),
}));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/pdf-extract", () => ({ extractTextFromPdf: vi.fn() }));
vi.mock("@/lib/registry-pdf/process", () => ({
  processRegistryPdf: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    attachment: { findFirst: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { processRegistryPdf } from "@/lib/registry-pdf/process";
import { GET, POST } from "@/app/api/properties/[id]/registry-owners/route";

/** 実物の所有者事項の並びを写した見本(氏名・住所は架空)。 */
const REGISTRY_TEXT = [
  "東京都渋谷区神宮前三丁目123-4 所有者事項 （土地）",
  "┏━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠────────┬───────┨",
  "┃ 住 所 │ 氏 名 ┃",
  "┠────────┼───────┨",
  "┃東京都渋谷区神宮前三丁目12番3号 │山田太郎 ┃",
  "┗━━━━━━━━┷━━━━━━┛",
].join("\n");

const PROPERTY_ID = "11111111-1111-1111-1111-111111111111";
const context = { params: Promise.resolve({ id: PROPERTY_ID }) };
const request = new Request("http://localhost/x") as never;
/** POST は下見で見せた添付IDを body で受け取る。 */
const postRequest = (attachmentId: unknown = "att-1") =>
  new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify({ attachmentId }),
  }) as never;

function setProperty(ownerCount: number) {
  (prisma.property.findUnique as unknown as Mock).mockResolvedValue({
    id: PROPERTY_ID,
    assignedTo: null,
    createdBy: "user-1",
    propertyOwners: Array.from({ length: ownerCount }, (_, i) => ({ id: `o${i}` })),
  });
}

function setAttachment(certificateType: string | null) {
  (prisma.attachment.findFirst as unknown as Mock).mockImplementation(
    async (args: { where: { registryCertificateType?: string } }) =>
      args.where.registryCertificateType === certificateType
        ? {
            id: "att-1",
            fileName: "山田太郎_謄本.pdf", // ⚠PIIを含む名前でも外に出ないことを確かめる
            fileUrl: "/uploads/registry/att-1.pdf",
            createdAt: new Date("2026-09-15T00:00:00Z"),
          }
        : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({
    id: "user-1",
    role: "admin",
  });
  (getUserPermissions as unknown as Mock).mockResolvedValue([]);
  (hasPermission as unknown as Mock).mockReturnValue(true);
  (getStorage as unknown as Mock).mockReturnValue({
    keyFromUrl: () => "registry/att-1.pdf",
    read: async () => ({ body: Buffer.from("pdf"), contentType: "application/pdf", size: 3 }),
  });
  (extractTextFromPdf as unknown as Mock).mockResolvedValue(REGISTRY_TEXT);
  setProperty(0);
  setAttachment("owner");
});

describe("GET（下見）", () => {
  it("読み取れた所有者を返し、何も保存しない", async () => {
    const res = await GET(request, context);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.owners).toEqual([
      {
        name: "山田太郎",
        address: "東京都渋谷区神宮前三丁目12番3号",
        share: null,
      },
    ]);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠生のファイル名を返さない（氏名や住所を含みうる）", async () => {
    const res = await GET(request, context);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("山田太郎_謄本");
    expect(body.attachment.fileName).toBeUndefined();
    expect(body.attachment.label).toBe("謄本(所有者事項)_2026-09-15.pdf");
  });

  it("⚠下見も閲覧の記録に残す（氏名・住所・ファイル名は載せない）", async () => {
    await GET(request, context);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registry_pdf_preview",
        targetTable: "attachments",
        targetId: "att-1",
      }),
    );
    const call = (writeAuditLog as unknown as Mock).mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain("山田太郎");
  });

  it("謄本の閲覧権限が無ければ 403", async () => {
    (hasPermission as unknown as Mock).mockImplementation(
      (_p: unknown, resource: string) => resource !== "registry_pdf",
    );
    const res = await GET(request, context);
    expect(res.status).toBe(403);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });
});

describe("POST（反映）", () => {
  it("⚠添付を作らないよう pdfBuffer は null、種別は owner 固定", async () => {
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(200);

    const args = (processRegistryPdf as unknown as Mock).mock.calls[0][0];
    expect(args.pdfBuffer).toBeNull();
    expect(args.certificateType).toBe("owner");
    expect(args.propertyId).toBe(PROPERTY_ID);
    expect(args.edited).toBeUndefined();
  });

  it("⚠すでに所有者がいる物件は 409 で止め、取込処理を呼ばない", async () => {
    setProperty(1);
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(409);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠全部事項しか無い物件は対象外（404）", async () => {
    setAttachment("all");
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(404);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("謄本から文字が読めないときは登録せず 422", async () => {
    (extractTextFromPdf as unknown as Mock).mockResolvedValue("   ");
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(422);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("所有者が読み取れないときは登録せず 422", async () => {
    (extractTextFromPdf as unknown as Mock).mockResolvedValue("所有者の表が無いテキスト");
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(422);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠監査記録には添付の生ファイル名を渡さない（氏名を含みうる）", async () => {
    await POST(postRequest(), context);
    const args = (processRegistryPdf as unknown as Mock).mock.calls[0][0];
    expect(args.fileName).not.toContain("謄本(所有者事項)");
    expect(args.fileName).toBe("添付済みの謄本から所有者を反映");
  });

  it("⚠物件の項目は書き換えない（不動産番号が入ると謄本が取れなくなる）", async () => {
    await POST(postRequest(), context);
    const args = (processRegistryPdf as unknown as Mock).mock.calls[0][0];
    // 所有者だけを入れる指定。これが外れると、下見で見せていない
    // 不動産番号・地番・家屋番号・登記状況が黙って書き換わる。
    expect(args.ownersOnly).toBe(true);
  });

  it("⚠書き込みのロックの中で担当者スコープを見直す指定を渡す", async () => {
    await POST(postRequest(), context);
    const args = (processRegistryPdf as unknown as Mock).mock.calls[0][0];
    // これが外れると、事前の権限確認のあと(書き込みまでの間)に担当を外された
    // 担当者でも、所有者を作って紐づけられてしまう。
    expect(args.enforcePropertyScope).toBe(true);
  });

  it("⚠確認した添付と違う謄本が最新になっていたら 409", async () => {
    const res = await POST(postRequest("att-old"), context);
    expect(res.status).toBe(409);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠添付IDの指定が無ければ 400（どれを承認したか分からない）", async () => {
    // ⚠postRequest(undefined) は既定値が入ってしまうので、field ごと落とした body を作る
    const noField = new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({}),
    }) as never;
    const res = await POST(noField, context);
    expect(res.status).toBe(400);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠所有者の編集権限(owner:write)が無ければ 403（import:write だけでは通さない）", async () => {
    (hasPermission as unknown as Mock).mockImplementation(
      (_p: unknown, resource: string) => resource !== "owner",
    );
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(403);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });

  it("取込の権限が無ければ 403", async () => {
    (hasPermission as unknown as Mock).mockImplementation(
      (_p: unknown, resource: string) => resource !== "import",
    );
    const res = await POST(postRequest(), context);
    expect(res.status).toBe(403);
    expect(processRegistryPdf).not.toHaveBeenCalled();
  });
});
