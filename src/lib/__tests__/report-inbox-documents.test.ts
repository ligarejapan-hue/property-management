/**
 * 書類の受け取り箱(2026-10-24 全書類へ): 査定報告書以外の書類を受け取り、種類を当て、通常の添付として付ける。
 *   - PDF 以外(Excel・画像)も受ける(物件の添付と同じ種類・20MB)。本文は読まず、種類は名前だけで当てる
 *   - PDF は本文から種類・日付・登録済みの物件名を読む
 *   - 通常の書類の添付は、ファイルを物件の置き場所へ写してから general で付ける(段階・種類・そろえた名前つき)
 *   - 査定報告書(SRE の書式)は今までどおり report で付ける(ファイルは写さない・案件ステータスの自動切替)
 *   - 人が種類を選び直すと manual。知らない種類は 422。写した後に記録を切り替えられなければ写しを消して 409
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    nextUrl: URL;
    constructor(input: string, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(input);
    }
  }
  return { NextRequest: MockNextRequest };
});

const { session, perms } = vi.hoisted(() => ({
  session: { current: { id: "u-office", role: "office_staff" } as { id: string; role: string } },
  perms: { current: [] as { resource: string; action: string; granted: boolean }[] },
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
    getApiSession: vi.fn(async () => session.current),
    getUserPermissions: vi.fn(async () => perms.current),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: String(error) } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { autoAdvanceCaseStatus } = vi.hoisted(() => ({ autoAdvanceCaseStatus: vi.fn(async () => true) }));
vi.mock("@/lib/case-status-auto", () => ({ autoAdvanceCaseStatus }));

const { storage, deletedKeys } = vi.hoisted(() => {
  // 消したキーは読めなくなる(removeFileAndVerify の「消せたと確かめる」を実物に寄せる)
  const deletedKeys = new Set<string>();
  return {
    deletedKeys,
    storage: {
      upload: vi.fn(async (_b: Buffer, o: { key: string }) => ({ url: `/uploads/${o.key}`, key: o.key })),
      delete: vi.fn(async (k: string) => {
        deletedKeys.add(k);
      }),
      read: vi.fn(async (k: string) =>
        deletedKeys.has(k) ? null : { body: Buffer.from("%PDF-1.7 x"), contentType: "application/pdf", size: 10 },
      ),
      keyFromUrl: vi.fn((u: string) => u.replace(/^\/uploads\//, "")),
      getUrl: vi.fn(async (k: string) => `/uploads/${k}`),
    },
  };
});
vi.mock("@/lib/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
  return { ...actual, getStorage: () => storage };
});

const { extractText } = vi.hoisted(() => ({ extractText: vi.fn() }));
vi.mock("@/lib/pdf-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pdf-extract")>("@/lib/pdf-extract");
  return { ...actual, extractTextFromPdf: extractText };
});
vi.mock("@/lib/pdf-compress/fit", () => ({
  fitPdfToLimit: vi.fn(async (buf: Buffer) => ({ buffer: buf, originalSize: null, level: null })),
  reserveLargePdfSlot: () => () => {},
}));

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用の差し替え
  const db: Record<string, any> = {
    reportInboxItem: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "item-1", ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    attachment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "att-1", ...data })),
      findMany: vi.fn(async () => []),
    },
    property: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    building: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { db };
});
vi.mock("@/lib/prisma", () => ({ default: db, prisma: db }));

import { POST as uploadPOST } from "@/app/api/report-inbox/route";
import { POST as attachPOST } from "@/app/api/report-inbox/[id]/attach/route";

const FULL = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  ...["owner_name", "owner_name_kana", "owner_address", "owner_phone", "owner_email", "owner_zip", "owner_note", "owner_corporate_number"].map(
    (resource) => ({ resource, action: "full", granted: true }),
  ),
];
const PID = "0b6f6c1e-0000-4000-8000-000000000000";
const PROPERTY = { id: PID, createdBy: "u-other", assignedTo: null, isArchived: false, buildingName: "ハマイハイライズ", roomNo: "305号室", address: "東京都…" };
const ctx = (id = "item-1") => ({ params: Promise.resolve({ id }) });

async function uploadReq(body: Buffer, name: string, type = "application/pdf") {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(body)], { type }), name);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/report-inbox", {
    method: "POST",
    body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}
const jsonReq = (body: unknown) =>
  new Request("http://t/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as NextRequest;

const generalPending = {
  id: "item-1",
  fileName: "【完成版】売買契約書.pdf",
  fileUrl: "/uploads/report-inbox/1-abc.pdf",
  fileSize: 1000,
  originalSize: null,
  mimeType: "application/pdf",
  source: "unknown",
  buildingName: "ハマイハイライズ",
  roomNo: "305",
  address: null,
  docKind: "sales_contract",
  docStage: "contract",
  docConfidence: "high",
  docDate: "20261001",
  status: "pending",
  uploadedBy: "u-office",
  createdAt: new Date("2026-10-24T01:00:00Z"),
};
const created = () => db.attachment.create.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  deletedKeys.clear();
  session.current = { id: "u-office", role: "office_staff" };
  perms.current = FULL;
  extractText.mockResolvedValue("");
  db.reportInboxItem.updateMany.mockResolvedValue({ count: 1 });
  db.reportInboxItem.findUnique.mockResolvedValue(generalPending);
  db.property.findUnique.mockResolvedValue(PROPERTY);
  db.property.findMany.mockResolvedValue([]);
  db.attachment.findMany.mockResolvedValue([]);
});

describe("受け取り(全書類)", () => {
  it("Excel も受ける: 本文は読まず、種類は名前で当て、置き場所の拡張子も合わせる", async () => {
    const res = await uploadPOST(
      await uploadReq(Buffer.from("PK..."), "付帯設備表　ハマイハイライズ305号室.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    );
    expect(res.status).toBe(201);
    expect(extractText).not.toHaveBeenCalled();
    const key = (storage.upload.mock.calls[0] as unknown as [Buffer, { key: string; fileName: string }])[1];
    expect(key.key).toMatch(/^report-inbox\/\d+-[0-9a-f-]{36}\.xlsx$/);
    // ⚠置き場所の名前にも元のファイル名を使わない
    expect(key.fileName).toBe("document.xlsx");
    const data = db.reportInboxItem.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      docKind: "fixtures_list",
      docStage: "contract",
      docConfidence: "high",
      docDate: null,
      source: "unknown",
    });
  });

  it("許可していない種類(テキストなど)は 422・置かない", async () => {
    const res = await uploadPOST(await uploadReq(Buffer.from("hello"), "memo.txt", "text/plain"));
    expect(res.status).toBe(422);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("PDF の本文から種類・日付を読み、見出しに名前が無ければ登録済みの物件名を本文から探す", async () => {
    extractText.mockResolvedValueOnce("不動産売買契約書\n\n物件の表示: ハマイハイライズ 305号室\n契約日 2026年10月1日");
    db.property.findMany.mockResolvedValueOnce([{ buildingName: "ハマイハイライズ" }, { buildingName: "西荻リリエンハイム" }]);
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 body"), "scan001.pdf"));
    expect(res.status).toBe(201);
    const data = db.reportInboxItem.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      mimeType: "application/pdf",
      docKind: "sales_contract",
      docStage: "contract",
      docConfidence: "high",
      docDate: "20261001",
      buildingName: "ハマイハイライズ",
      roomNo: "305",
    });
    // 登録済みの名前は、呼び出した人が開ける・しまっていない物件だけから引く
    expect(db.property.findMany.mock.calls[0][0].where).toMatchObject({ isArchived: false });
  });
});

describe("添付(通常の書類)", () => {
  it("★ファイルを物件の置き場所へ写してから general で付け、段階・種類・そろえた名前を付ける。査定中への自動切替は呼ばない", async () => {
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    expect(storage.read).toHaveBeenCalledWith("report-inbox/1-abc.pdf");
    const copied = (storage.upload.mock.calls[0] as unknown as [Buffer, { key: string }])[1].key;
    expect(copied).toMatch(new RegExp(`^properties/${PID}/attachments/\\d+-[0-9a-f-]{36}\\.pdf$`));
    const data = created();
    expect(data).toMatchObject({
      type: "general",
      propertyId: PID,
      fileName: "【完成版】売買契約書.pdf",
      fileUrl: `/uploads/${copied}`,
      mimeType: "application/pdf",
      docKind: "sales_contract",
      docStage: "contract",
      docConfidence: "high",
      docTitle: "売買契約書_ハマイハイライズ305_20261001.pdf",
    });
    expect(autoAdvanceCaseStatus).not.toHaveBeenCalled();
    // 受け取り箱の側のファイルは消しにいく(写し終えたので)。消せたので「削除中」には戻さない
    expect(storage.delete).toHaveBeenCalledWith("report-inbox/1-abc.pdf");
    expect(db.reportInboxItem.updateMany.mock.calls.some((c: [{ data: { status?: string } }]) => c[0].data.status === "discarding")).toBe(false);
    // 監査にファイル名は出さない
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0])).not.toContain("売買契約書.pdf");
  });

  it("★受け取り箱側のファイルを消せたと確かめられなければ「削除中」に戻す(一覧に残って「削除」で片付けられる・@codex #565)", async () => {
    // 消しても読めたまま(黙って失敗する保存先)
    storage.delete.mockImplementationOnce(async () => {});
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    expect(db.attachment.create).toHaveBeenCalled();
    const back = db.reportInboxItem.updateMany.mock.calls.find((c: [{ data: { status?: string } }]) => c[0].data.status === "discarding");
    expect(back).toBeTruthy();
    expect(back[0].where).toEqual({ id: "item-1", status: "attached" });
  });

  it("人が種類を選び直すと manual で、その種類の名前になる", async () => {
    const res = await attachPOST(jsonReq({ propertyId: PID, docKind: "disclosure" }), ctx());
    expect(res.status).toBe(200);
    expect(created()).toMatchObject({
      docKind: "disclosure",
      docStage: "contract",
      docConfidence: "manual",
      docTitle: "重要事項説明書_ハマイハイライズ305_20261001.pdf",
    });
  });

  it("「その他」(null)を選ぶと4列とも付けない", async () => {
    const res = await attachPOST(jsonReq({ propertyId: PID, docKind: null }), ctx());
    expect(res.status).toBe(200);
    expect(created()).toMatchObject({ type: "general", docKind: null, docStage: null, docTitle: null, docConfidence: null });
  });

  it("知らない種類は 422・何も写さない", async () => {
    const res = await attachPOST(jsonReq({ propertyId: PID, docKind: "nope" }), ctx());
    expect(res.status).toBe(422);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("★写した後に記録を切り替えられなければ(同時に押した2人目)、写しを消して 409", async () => {
    db.reportInboxItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(409);
    const copied = (storage.upload.mock.calls[0] as unknown as [Buffer, { key: string }])[1].key;
    expect(storage.delete).toHaveBeenCalledWith(copied);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("★写しの保存が失敗したら、置きかけの写しを消して失敗を返す(記録は未処理のまま・@codex #565)", async () => {
    storage.upload.mockRejectedValueOnce(new Error("storage down"));
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(500);
    const attempted = (storage.upload.mock.calls[0] as unknown as [Buffer, { key: string }])[1].key;
    expect(storage.delete).toHaveBeenCalledWith(attempted);
    expect(db.reportInboxItem.updateMany).not.toHaveBeenCalled();
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("すでに添付済み・削除済みの行は 409(写す前)", async () => {
    db.reportInboxItem.findUnique.mockResolvedValueOnce({ ...generalPending, status: "attached" });
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(409);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("査定サイトの書式(source=sre)は今までどおり report で付ける(写さない・種類は査定報告書・査定中へ)", async () => {
    db.reportInboxItem.findUnique.mockResolvedValueOnce({ ...generalPending, source: "sre", docKind: null, docConfidence: null });
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(created()).toMatchObject({
      type: "report",
      fileUrl: generalPending.fileUrl,
      docKind: "appraisal_report",
      docStage: "pre_contract",
    });
    // 名前は定型のまま(そろえた名前は付けない)
    expect("docTitle" in created()).toBe(false);
    expect(created().fileName).toMatch(/^査定報告書_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(autoAdvanceCaseStatus).toHaveBeenCalled();
  });

  it("画像の「査定書」は report にしない(写して general・種類は査定書のまま・mime は画像)", async () => {
    db.reportInboxItem.findUnique.mockResolvedValueOnce({
      ...generalPending,
      fileName: "査定書.jpg",
      fileUrl: "/uploads/report-inbox/1-abc.jpg",
      mimeType: "image/jpeg",
      docKind: "appraisal_report",
      docStage: "pre_contract",
    });
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    expect(storage.upload).toHaveBeenCalled();
    expect(created()).toMatchObject({ type: "general", mimeType: "image/jpeg", docKind: "appraisal_report", docStage: "pre_contract" });
    expect(created().docTitle).toBe("査定書・査定報告書_ハマイハイライズ305_20261001.jpg");
    expect(autoAdvanceCaseStatus).not.toHaveBeenCalled();
  });

  it("種類が「査定書・査定報告書」なら書式が不明でも report で付ける", async () => {
    db.reportInboxItem.findUnique.mockResolvedValueOnce({ ...generalPending, docKind: "appraisal_report" });
    const res = await attachPOST(jsonReq({ propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    expect(created()).toMatchObject({ type: "report", docKind: "appraisal_report" });
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
