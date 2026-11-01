/**
 * まとめてある PDF を書類ごとに保存する(2026-10-28 発注者依頼)。
 *   POST /api/properties/[id]/attachments/split-analyze … 案だけ返す(保存しない・文字を返さない)
 *   POST /api/properties/[id]/attachments/split         … 元の1冊+分けた書類を保存
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { perms } = vi.hoisted(() => ({
  perms: {
    value: [
      { resource: "property", action: "read", granted: true },
      { resource: "property", action: "write", granted: true },
    ],
  },
}));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u-admin", role: "admin" })),
    getUserPermissions: vi.fn(async () => perms.value),
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
const { storageStub } = vi.hoisted(() => ({
  storageStub: { upload: vi.fn(async (_b: Buffer, o: { key: string }) => ({ url: `/uploads/${o.key}` })), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({
  getStorage: () => storageStub,
  MAX_FILE_SIZE: 8 * 1024 * 1024,
  ALLOWED_ATTACHMENT_MIMES: new Set(["application/pdf"]),
  validateFile: () => null,
}));
const { fitPdfToLimit, reserveLargePdfSlot } = vi.hoisted(() => ({
  fitPdfToLimit: vi.fn(async (buf: Buffer) => ({ buffer: buf, originalSize: null, level: null })),
  reserveLargePdfSlot: vi.fn(() => () => {}),
}));
vi.mock("@/lib/pdf-compress/fit", () => ({ fitPdfToLimit, reserveLargePdfSlot }));
const { splitPdfByRanges } = vi.hoisted(() => ({ splitPdfByRanges: vi.fn() }));
vi.mock("@/lib/pdf-split/run", () => ({ splitPdfByRanges }));
const { analyzeBundlePdf } = vi.hoisted(() => ({ analyzeBundlePdf: vi.fn() }));
vi.mock("@/lib/pdf-split/analyze", () => ({ analyzeBundlePdf }));
const { fillAreas } = vi.hoisted(() => ({ fillAreas: vi.fn(async () => ({ filled: [], skippedByEditLock: false })) }));
vi.mock("@/lib/registry-pdf/fill-areas", () => ({ fillBasicInfoFromRegistryPdfBestEffort: fillAreas }));
vi.mock("@/lib/prisma", () => {
  let n = 0;
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(async () => ({
        id: "p-1", createdBy: "u-admin", assignedTo: null,
        buildingName: "藤和氷川台コープ", roomNo: "710", address: "東京都練馬区…",
      })),
    },
    attachment: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `a-${++n}`, type: data.type })),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p-1" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { POST as SPLIT } from "@/app/api/properties/[id]/attachments/split/route";
import { POST as ANALYZE } from "@/app/api/properties/[id]/attachments/split-analyze/route";

const db = prisma as unknown as { attachment: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } };
const PDF = Buffer.from("%PDF-1.7\n%bundle\n");
const params = { params: Promise.resolve({ id: "p-1" }) };

async function req(path: string, fields: Record<string, string> = {}, bytes: Buffer = PDF, name = "物件概要書 藤和氷川台コープ710.pdf") {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const blob = await new Response(fd).blob();
  return new Request(`http://t/api/properties/p-1/attachments/${path}`, {
    method: "POST", body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}
const rows = () => db.attachment.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const SEGMENTS = [
  { from: 1, to: 1, kind: "property_summary" },
  { from: 2, to: 3, kind: "drawings" },
  { from: 4, to: 5, kind: "registry" },
];

beforeEach(() => {
  vi.clearAllMocks();
  perms.value = [
    { resource: "property", action: "read", granted: true },
    { resource: "property", action: "write", granted: true },
  ];
  splitPdfByRanges.mockResolvedValue({
    ok: true,
    pageCount: 5,
    parts: [Buffer.from("%PDF-p1"), Buffer.from("%PDF-p2"), Buffer.from("%PDF-p3")],
  });
});

describe("split-analyze(案だけ)", () => {
  it("案を返し、何も保存しない", async () => {
    analyzeBundlePdf.mockResolvedValueOnce({
      pageCount: 5, pageKinds: ["property_summary", null, null, "registry", "registry"],
      segments: SEGMENTS, ocr: "done", tooManyPages: false,
    });
    const res = await ANALYZE(await req("split-analyze"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.segments).toEqual(SEGMENTS);
    expect(JSON.stringify(body)).not.toMatch(/text/);
    expect(db.attachment.create).not.toHaveBeenCalled();
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("読めない PDF は「分けない」と答える", async () => {
    analyzeBundlePdf.mockResolvedValueOnce(null);
    const body = await (await ANALYZE(await req("split-analyze"), params)).json();
    expect(body.segments).toEqual([]);
  });

  it("PDF でなければ 422", async () => {
    const res = await ANALYZE(await req("split-analyze", {}, Buffer.from("hello")), params);
    expect(res.status).toBe(422);
  });

  it("物件を編集できない人は 403(本文を読まない)", async () => {
    perms.value = [{ resource: "property", action: "read", granted: true }];
    const res = await ANALYZE(await req("split-analyze"), params);
    expect(res.status).toBe(403);
    expect(analyzeBundlePdf).not.toHaveBeenCalled();
  });
});

describe("split(分けて保存)", () => {
  it("元の1冊+分けた書類を保存する。謄本は謄本として・ほかは人が決めた種類で名前をそろえる", async () => {
    const res = await SPLIT(await req("split", { segments: JSON.stringify(SEGMENTS) }), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ originalId: "a-1", parts: 3, registryParts: 1, registryNotice: null });
    expect(splitPdfByRanges).toHaveBeenCalledWith(expect.any(Buffer), SEGMENTS);

    const [orig, summary, drawings, registry] = rows();
    // ⚠謄本が入っている1冊は、元の名前(所有者名を含み得る)を使わず決まった名前で保存する。
    expect(orig).toMatchObject({
      type: "general", fileName: "まとめてあるPDF.pdf",
      docKind: "bundle_original", docStage: "pre_contract", docConfidence: "manual",
    });
    expect(summary).toMatchObject({
      type: "general", fileName: "まとめてあるPDF_p1.pdf",
      docKind: "property_summary", docConfidence: "manual",
    });
    expect(String(summary.docTitle)).toMatch(/^物件概要書_藤和氷川台コープ710_\d{8}\.pdf$/);
    expect(drawings).toMatchObject({ docKind: "drawings", fileName: "まとめてあるPDF_p2-3.pdf" });
    expect(registry).toMatchObject({ type: "registry", fileName: "まとめてあるPDF_p4-5.pdf" });
    expect(registry.docKind).toBeUndefined();
    expect(JSON.stringify(rows())).not.toContain("藤和氷川台コープ710.pdf");
    // 謄本の部分は面積を読む・縮めない。
    expect(fillAreas).toHaveBeenCalledTimes(1);
    expect(fitPdfToLimit).toHaveBeenCalledTimes(3);
    // 謄本が入っている1冊は、どの行の監査にもファイル名を出さない。
    for (const c of writeAuditLog.mock.calls) expect(c[0].detail).toEqual({ propertyId: "p-1" });
  });

  it("謄本が入っていなければ元の名前のまま。その他(null)の書類は種類なし", async () => {
    const segs = [{ from: 1, to: 2, kind: null }, { from: 3, to: 5, kind: "drawings" }];
    splitPdfByRanges.mockResolvedValueOnce({ ok: true, pageCount: 5, parts: [Buffer.from("%PDF-a"), Buffer.from("%PDF-b")] });
    await SPLIT(await req("split", { segments: JSON.stringify(segs) }), params);
    expect(rows()[0]).toMatchObject({ fileName: "物件概要書 藤和氷川台コープ710.pdf" });
    expect(rows()[1]).toMatchObject({ type: "general", docKind: null, docTitle: null, fileName: "物件概要書 藤和氷川台コープ710_p1-2.pdf" });
    expect(writeAuditLog.mock.calls[0][0].detail).toEqual({ propertyId: "p-1", fileName: "物件概要書 藤和氷川台コープ710.pdf" });
  });

  it("⚠分け方に謄本が無くても、画面が「謄本のページが入っている」と知らせたら元の名前を使わない(@codex #604 P1)", async () => {
    const segs = [{ from: 1, to: 2, kind: "property_summary" }, { from: 3, to: 5, kind: "drawings" }];
    splitPdfByRanges.mockResolvedValueOnce({ ok: true, pageCount: 5, parts: [Buffer.from("%PDF-a"), Buffer.from("%PDF-b")] });
    await SPLIT(await req("split", { segments: JSON.stringify(segs), containsRegistry: "1" }), params);
    expect(rows().map((r) => r.fileName)).toEqual(["まとめてあるPDF.pdf", "まとめてあるPDF_p1-2.pdf", "まとめてあるPDF_p3-5.pdf"]);
    for (const c of writeAuditLog.mock.calls) expect(c[0].detail).toEqual({ propertyId: "p-1" });
  });

  it("60ページを超える分け方は 422(分けない)", async () => {
    const segs = [{ from: 1, to: 1, kind: null }, { from: 2, to: 61, kind: null }];
    const res = await SPLIT(await req("split", { segments: JSON.stringify(segs) }), params);
    expect(res.status).toBe(422);
    expect(splitPdfByRanges).not.toHaveBeenCalled();
  });

  it.each([
    ["1つだけ", [{ from: 1, to: 5, kind: null }]],
    ["隙間がある", [{ from: 1, to: 1, kind: null }, { from: 3, to: 5, kind: null }]],
    ["知らない種類", [{ from: 1, to: 1, kind: "nope" }, { from: 2, to: 5, kind: null }]],
  ])("分け方が正しくなければ 422 で何も保存しない: %s", async (_l, segs) => {
    const res = await SPLIT(await req("split", { segments: JSON.stringify(segs) }), params);
    expect(res.status).toBe(422);
    expect(splitPdfByRanges).not.toHaveBeenCalled();
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("分け方の範囲が本当のページ数に届かなければ 422(保存しない)", async () => {
    splitPdfByRanges.mockResolvedValueOnce({
      ok: true, pageCount: 9, parts: [Buffer.from("%PDF-p1"), Buffer.from("%PDF-p2"), Buffer.from("%PDF-p3")],
    });
    const res = await SPLIT(await req("split", { segments: JSON.stringify(SEGMENTS) }), params);
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("鍵のかかった PDF は 422", async () => {
    splitPdfByRanges.mockResolvedValueOnce({ ok: false, reason: "encrypted" });
    const res = await SPLIT(await req("split", { segments: JSON.stringify(SEGMENTS) }), params);
    expect(res.status).toBe(422);
  });

  it("分ける部品が使えないときは 503", async () => {
    splitPdfByRanges.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    const res = await SPLIT(await req("split", { segments: JSON.stringify(SEGMENTS) }), params);
    expect(res.status).toBe(503);
  });

  it("分け方が JSON でなければ 422", async () => {
    const res = await SPLIT(await req("split", { segments: "{" }), params);
    expect(res.status).toBe(422);
  });
});
