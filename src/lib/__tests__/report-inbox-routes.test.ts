/**
 * 査定報告書の受け取り箱の API(2026-10-10)。
 *   - 使えるのは所有者の項目をすべて素通しで見られる人だけ(報告書に依頼者の氏名が載る)
 *   - 受け取り: 報告書の手がかりを読み、受け取り箱の場所に置く(元のファイル名は記録に残さない)
 *   - 添付: 人が選んだ物件に「査定報告書」として付ける(親行ロック→作成・同時に押しても1件)
 *   - 削除: 未処理のものだけ・人が押したときだけ
 *   - 中身: 未処理のものだけ・キャッシュさせない
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

const { storage } = vi.hoisted(() => ({
  storage: {
    upload: vi.fn(async (_b: Buffer, o: { key: string }) => ({ url: `/uploads/${o.key}`, key: o.key })),
    delete: vi.fn(async () => {}),
    read: vi.fn(async () => ({ body: Buffer.from("%PDF-1.7 x"), contentType: "application/pdf", size: 10 })),
    keyFromUrl: vi.fn((u: string) => u.replace(/^\/uploads\//, "")),
  },
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));

const { extractText } = vi.hoisted(() => ({ extractText: vi.fn() }));
vi.mock("@/lib/pdf-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pdf-extract")>("@/lib/pdf-extract");
  return { ...actual, extractTextFromPdf: extractText };
});

vi.mock("@/lib/pdf-compress/fit", () => ({
  fitPdfToLimit: vi.fn(async (buf: Buffer) => ({ buffer: buf, originalSize: null, level: null })),
  reserveLargePdfSlot: () => () => {},
}));

const { db, callOrder } = vi.hoisted(() => {
  const callOrder: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用の差し替え(呼び出しを覗くため)
  const db: Record<string, any> = {
    reportInboxItem: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "item-1", ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    attachment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        callOrder.push("attachment.create");
        return { id: "att-1", ...data };
      }),
    },
    property: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    building: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => [{ id: "u-office", name: "事務 太郎" }]) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => {
    callOrder.push("lockPropertyRow");
    return [{ id: "p1" }];
  });
  return { db, callOrder };
});
vi.mock("@/lib/prisma", () => ({ default: db, prisma: db }));

import { GET as listGET, POST as uploadPOST } from "@/app/api/report-inbox/route";
import { POST as attachPOST } from "@/app/api/report-inbox/[id]/attach/route";
import { DELETE as itemDELETE } from "@/app/api/report-inbox/[id]/route";
import { GET as fileGET } from "@/app/api/report-inbox/[id]/file/route";

const FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  ...["owner_name", "owner_name_kana", "owner_address", "owner_phone", "owner_email", "owner_zip", "owner_note", "owner_corporate_number"].map(
    (resource) => ({ resource, action: "full", granted: true }),
  ),
];
const MASKED = FULL.map((p) => (p.resource === "owner_phone" ? { ...p, action: "masked" } : p));

const SRE_TEXT = "佐藤 花子 様\n不動産価格査定報告書\n名称 \t東急サンプルハイツ 305号室\n所有地 \t東京都世田谷区太子堂4丁目12ー3";
const pending = {
  id: "item-1",
  fileName: "佐藤様_査定報告書.pdf",
  fileUrl: "/uploads/report-inbox/1-abc.pdf",
  fileSize: 1000,
  originalSize: null,
  source: "sre",
  buildingName: "東急サンプルハイツ",
  roomNo: "305",
  address: "東京都世田谷区太子堂4丁目12ー3",
  status: "pending",
  uploadedBy: "u-office",
  createdAt: new Date("2026-10-10T01:00:00Z"),
};
const ctx = (id = "item-1") => ({ params: Promise.resolve({ id }) });

async function uploadReq(body: Buffer, name: string, type = "application/pdf", withLength = true) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(body)], { type }), name);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/report-inbox", {
    method: "POST",
    body: blob,
    headers: { "content-type": blob.type, ...(withLength ? { "content-length": String(blob.size) } : {}) },
  }) as unknown as NextRequest;
}
const jsonReq = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  session.current = { id: "u-office", role: "office_staff" };
  perms.current = FULL;
  extractText.mockResolvedValue(SRE_TEXT);
  db.reportInboxItem.findUnique.mockResolvedValue(pending);
  db.reportInboxItem.updateMany.mockResolvedValue({ count: 1 });
  db.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u-other", assignedTo: null, isArchived: false });
});

describe("使える人", () => {
  it.each([
    ["一覧", () => listGET()],
    ["中身", () => fileGET(new Request("http://t/x") as unknown as NextRequest, ctx())],
    ["削除", () => itemDELETE(new Request("http://t/x") as unknown as NextRequest, ctx())],
    ["添付", () => attachPOST(jsonReq("http://t/x", { propertyId: "0b6f6c1e-0000-4000-8000-000000000000" }), ctx())],
  ])("★所有者の項目が1つでも伏せられている人は 403(%s)", async (_label, call) => {
    perms.current = MASKED;
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("所有者情報をすべて見られる方だけ");
  });

  it("★物件を見る権限(property:read)を外された人は 403(候補の住所を見せない・@codex PR#500 2巡目)", async () => {
    perms.current = FULL.filter((p) => !(p.resource === "property" && p.action === "read"));
    const res = await listGET();
    expect(res.status).toBe(403);
  });

  it("受け取りも 403(本文を読む前)", async () => {
    perms.current = MASKED;
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 x"), "a.pdf"));
    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe("受け取り", () => {
  it("★報告書の手がかりを読み、受け取り箱の場所に置く(依頼者名は記録しない)", async () => {
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 body"), "佐藤様_査定報告書.pdf"));
    expect(res.status).toBe(201);
    const key = (storage.upload.mock.calls[0] as unknown as [Buffer, { key: string }])[1].key;
    expect(key).toMatch(/^report-inbox\/\d+-[0-9a-f-]{36}\.pdf$/);
    const data = db.reportInboxItem.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "sre",
      buildingName: "東急サンプルハイツ",
      roomNo: "305",
      address: "東京都世田谷区太子堂4丁目12ー3",
      uploadedBy: "u-office",
    });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0])).not.toContain("佐藤");
  });

  it("文字が読めない PDF でも受け取る(手がかりは空・手で探せる)", async () => {
    extractText.mockRejectedValueOnce(new Error("bad"));
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 body"), "x.pdf"));
    expect(res.status).toBe(201);
    expect(db.reportInboxItem.create.mock.calls[0][0].data).toMatchObject({ source: "unknown", buildingName: null });
  });

  it("PDF でないものは 422・置かない", async () => {
    const res = await uploadPOST(await uploadReq(Buffer.from("hello"), "a.pdf", "application/octet-stream"));
    expect(res.status).toBe(422);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("Content-Length の無い送信は 411", async () => {
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 x"), "a.pdf", "application/pdf", false));
    expect(res.status).toBe(411);
  });

  it("★記録が作れなかったら、置いたファイルを消す(どこからも見えない個人情報を残さない)", async () => {
    db.reportInboxItem.create.mockRejectedValueOnce(new Error("db down"));
    const res = await uploadPOST(await uploadReq(Buffer.from("%PDF-1.7 body"), "x.pdf"));
    expect(res.status).toBe(500);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
});

describe("添付", () => {
  const PID = "0b6f6c1e-0000-4000-8000-000000000000";

  it("★選んだ物件に「査定報告書」として付ける(元の名前は使わない・親行ロックが先)", async () => {
    db.property.findUnique.mockResolvedValueOnce({ id: PID, createdBy: "u-other", assignedTo: null, isArchived: false });
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(200);
    const data = db.attachment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "report", propertyId: PID, fileUrl: pending.fileUrl, mimeType: "application/pdf" });
    expect(data.fileName).toMatch(/^査定報告書_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(callOrder.indexOf("lockPropertyRow")).toBeLessThan(callOrder.indexOf("attachment.create"));
    expect(db.reportInboxItem.updateMany.mock.calls[0][0].where).toEqual({ id: "item-1", status: "pending" });
  });

  it("★すでに添付・削除済み(同時に押した2人目)は 409・添付を作らない", async () => {
    db.reportInboxItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(409);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("担当外の物件(現地担当)には付けられない", async () => {
    session.current = { id: "u-field", role: "field_staff" };
    db.property.findUnique.mockResolvedValueOnce({ id: PID, createdBy: "u-other", assignedTo: "u-other2", isArchived: false });
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(403);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("しまってある物件には付けない(422)", async () => {
    db.property.findUnique.mockResolvedValueOnce({ id: PID, createdBy: "u-other", assignedTo: null, isArchived: true });
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(422);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("物件の指定が無ければ 422", async () => {
    const res = await attachPOST(jsonReq("http://t/x", {}), ctx());
    expect(res.status).toBe(422);
  });

  it("★ロックを取った後に担当が替わっていたら付けない(古い判断で書き込まない・@codex PR#500)", async () => {
    session.current = { id: "u-field", role: "field_staff" };
    db.property.findUnique
      .mockResolvedValueOnce({ id: PID, createdBy: "u-field", assignedTo: null, isArchived: false }) // 事前の確認
      .mockResolvedValueOnce({ createdBy: "u-other", assignedTo: "u-other2", isArchived: false }); // ロック後
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(403);
    expect(db.reportInboxItem.updateMany).not.toHaveBeenCalled();
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("★ロックを取った後にしまわれていたら付けない", async () => {
    db.property.findUnique
      .mockResolvedValueOnce({ id: PID, createdBy: "u-other", assignedTo: null, isArchived: false })
      .mockResolvedValueOnce({ createdBy: "u-other", assignedTo: null, isArchived: true });
    const res = await attachPOST(jsonReq("http://t/x", { propertyId: PID }), ctx());
    expect(res.status).toBe(422);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });
});

describe("削除", () => {
  it("未処理のものを「削除中」にしてファイルを消し、もう読めないのを確かめて「削除済み」", async () => {
    storage.read.mockResolvedValueOnce(null as never);
    const res = await itemDELETE(new Request("http://t/x") as unknown as NextRequest, ctx());
    expect(res.status).toBe(200);
    const calls = db.reportInboxItem.updateMany.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls[0]).toEqual({ where: { id: "item-1", status: { in: ["pending", "discarding"] } }, data: { status: "discarding" } });
    expect(storage.delete).toHaveBeenCalledWith("report-inbox/1-abc.pdf");
    expect(calls[1]).toMatchObject({ where: { id: "item-1", status: "discarding" }, data: { status: "discarded" } });
  });

  it("★ファイルを消せなかったら「削除中」のまま 500(未処理に戻さない=同時に押されても添付できない・@codex PR#500)", async () => {
    storage.delete.mockRejectedValueOnce(Object.assign(new Error("io"), { code: "EIO" }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await itemDELETE(new Request("http://t/x") as unknown as NextRequest, ctx());
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain("もう一度「削除」を押してください");
    const calls = db.reportInboxItem.updateMany.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls.some((c: { data: { status: string } }) => c.data.status !== "discarding")).toBe(false);
  });

  it("★「消した」はずでもファイルが読めたら(黙って失敗する保存先)削除済みにしない", async () => {
    // 既定の read はファイルを返す=まだ残っている
    const res = await itemDELETE(new Request("http://t/x") as unknown as NextRequest, ctx());
    expect(res.status).toBe(500);
    const calls = db.reportInboxItem.updateMany.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((c: { data: { status: string } }) => c.data.status === "discarded")).toBe(false);
  });

  it("★添付済み(物件の添付が同じファイルを指す)は 409・ファイルを消さない", async () => {
    db.reportInboxItem.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await itemDELETE(new Request("http://t/x") as unknown as NextRequest, ctx());
    expect(res.status).toBe(409);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe("中身", () => {
  it("★未処理のものはキャッシュさせずに返し、元のファイル名は出さない", async () => {
    const res = await fileGET(new Request("http://t/x") as unknown as NextRequest, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
  });

  it("添付済み・削除済みは 404(添付は /uploads の守りで開く)", async () => {
    db.reportInboxItem.findUnique.mockResolvedValueOnce({ ...pending, status: "attached" });
    const res = await fileGET(new Request("http://t/x") as unknown as NextRequest, ctx());
    expect(res.status).toBe(404);
  });
});

describe("一覧", () => {
  it("未処理だけを新しい順に、候補と受け取った人の名前つきで返す", async () => {
    db.reportInboxItem.findMany.mockResolvedValueOnce([pending]);
    db.property.findMany.mockResolvedValueOnce([
      { id: "p1", address: "東京都世田谷区太子堂4-12-3", buildingName: "東急サンプルハイツ", roomNo: "305", propertyType: "apartment_unit", buildingId: null },
    ]);
    const res = await listGET();
    const body = await res.json();
    expect(db.reportInboxItem.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: { in: ["pending", "discarding"] } },
      orderBy: { createdAt: "desc" },
    });
    expect(body.data[0]).toMatchObject({ id: "item-1", uploaderName: "事務 太郎", status: "pending" });
    expect(body.data[0].candidates[0]).toMatchObject({ propertyId: "p1", match: "name_room" });
  });

  it("★候補は呼び出した人が開ける物件だけ(現地担当に担当外の住所・建物名を見せない・@codex PR#500)", async () => {
    session.current = { id: "u-field", role: "field_staff" };
    db.reportInboxItem.findMany.mockResolvedValueOnce([pending]);
    db.property.findMany.mockResolvedValueOnce([
      { id: "mine", address: "東京都世田谷区太子堂4-12-3", buildingName: "東急サンプルハイツ", roomNo: "305", propertyType: "apartment_unit", buildingId: null, createdBy: "u-field", assignedTo: null },
      { id: "others", address: "東京都世田谷区太子堂4-12-3", buildingName: "東急サンプルハイツ", roomNo: "305", propertyType: "apartment_unit", buildingId: null, createdBy: "u-x", assignedTo: "u-y" },
    ]);
    const body = await (await listGET()).json();
    expect(body.data[0].candidates.map((c: { propertyId: string }) => c.propertyId)).toEqual(["mine"]);
  });
});
