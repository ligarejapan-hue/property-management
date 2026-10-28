/**
 * POST /api/import/detect — 「ファイルを入れる」の行き先(2026-10-28 第2段)。保存しない・中身を返さない。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { perms } = vi.hoisted(() => ({
  perms: { value: [{ resource: "import", action: "write", granted: true }] as { resource: string; action: string; granted: boolean }[] },
}));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u-1", role: "office_staff" })),
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
const { extractHead } = vi.hoisted(() => ({ extractHead: vi.fn() }));
vi.mock("@/lib/pdf-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf-extract")>();
  return { ...actual, extractHeadTextFromPdf: extractHead };
});

import { POST } from "@/app/api/import/detect/route";

function jsonReq(body: unknown) {
  const text = JSON.stringify(body);
  return new Request("http://t/api/import/detect", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length) },
  }) as unknown as NextRequest;
}

async function pdfReq(bytes: Buffer, name = "x.pdf") {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/import/detect", {
    method: "POST",
    body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}

const target = async (res: Response) => ((await res.json()) as { target: string }).target;

beforeEach(() => {
  vi.clearAllMocks();
  perms.value = [{ resource: "import", action: "write", granted: true }];
});

describe("表(CSV)", () => {
  it("受付帳の列(8列目 都道府県・9列目 市区町村)→ 受付帳", async () => {
    const csv = "No,DL,受付番号,日付,新既,種別,他,都道府県,市区町村,住所\n1,〇,123,2026/10/01,既,土地,,東京都,練馬区,氷川台4-1";
    expect(await target(await POST(jsonReq({ fileName: "10月.csv", csvText: csv })))).toBe("reception");
  });

  it("所有者の列(所有者氏名)→ 所有者の一覧", async () => {
    const csv = "所有者氏名,所有者住所,物件住所\n山田太郎,東京都…,東京都…";
    expect(await target(await POST(jsonReq({ fileName: "list.csv", csvText: csv })))).toBe("owner");
  });

  it("中身で決まらない CSV は、ファイル名(受付帳/所有者)で補う・それも無ければ人が選ぶ", async () => {
    const csv = "a,b\n1,2";
    expect(await target(await POST(jsonReq({ fileName: "所有者_10月.csv", csvText: csv })))).toBe("owner");
    expect(await target(await POST(jsonReq({ fileName: "メモ.csv", csvText: csv })))).toBe("unknown");
  });

  it("返すのは行き先だけ(中身を返さない)", async () => {
    const csv = "所有者氏名,所有者住所\n山田太郎,東京都練馬区";
    const body = await (await POST(jsonReq({ fileName: "list.csv", csvText: csv }))).json();
    expect(Object.keys(body)).toEqual(["target"]);
  });
});

describe("PDF", () => {
  const PDF = Buffer.from("%PDF-1.7\n%x\n");

  it("謄本の見出し → 謄本の取り込み", async () => {
    extractHead.mockResolvedValueOnce("東京都練馬区… 全部事項証明書(建物)\n表題部");
    expect(await target(await POST(await pdfReq(PDF)))).toBe("registry_pdf");
  });

  it("HOME4U の反響 → 貼り付けて物件化", async () => {
    extractHead.mockResolvedValueOnce("査定ナンバー：1234\nお名前：…");
    expect(await target(await POST(await pdfReq(PDF)))).toBe("paste_pdf");
  });

  it("ほかの書類・文字を読めない PDF・PDF でないもの → 書類", async () => {
    extractHead.mockResolvedValueOnce("不動産売買契約書");
    expect(await target(await POST(await pdfReq(PDF)))).toBe("document");
    extractHead.mockRejectedValueOnce(new Error("broken"));
    expect(await target(await POST(await pdfReq(PDF)))).toBe("document");
    expect(await target(await POST(await pdfReq(Buffer.from("hello"))))).toBe("document");
  });
});

describe("権限", () => {
  it("取り込みの権限が無い人は 403(本文を読まない)", async () => {
    perms.value = [];
    const res = await POST(await pdfReq(Buffer.from("%PDF-1.7")));
    expect(res.status).toBe(403);
    expect(extractHead).not.toHaveBeenCalled();
  });
});
