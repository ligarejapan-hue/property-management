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

import * as XLSX from "xlsx";
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

describe("Excel", () => {
  function xlsxBase64(sheets: Record<string, string[][]>): string {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
  }
  const LEAD = [["姓名", "物件所在地", "電話番号"], ["山田太郎", "東京都練馬区氷川台4-1-1", "090-0000-0000"]];

  it("査定サイトの顧客管理表 → Excelから物件化", async () => {
    const res = await POST(jsonReq({ fileName: "顧客管理表.xlsx", xlsxBase64: xlsxBase64({ 一覧: LEAD }) }));
    expect(await target(res)).toBe("lead_excel");
  });

  it("見出しの上に空の行が続く顧客管理表も見分ける(Excel まとめ取込と同じ範囲を読む・@codex #607 P2)", async () => {
    const blank = Array.from({ length: 45 }, () => [""]);
    const res = await POST(jsonReq({ fileName: "顧客管理表.xlsx", xlsxBase64: xlsxBase64({ 一覧: [...blank, ...LEAD] }) }));
    expect(await target(res)).toBe("lead_excel");
  });

  it("取り込めない大きさ(列が200を超える)のシートは、配列にせず飛ばす(メモリを守る)", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(LEAD);
    ws["!ref"] = "A1:ZZ2"; // 列が 702 まで広がった形
    XLSX.utils.book_append_sheet(wb, ws, "一覧");
    const b64 = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
    const res = await POST(jsonReq({ fileName: "顧客管理表.xlsx", xlsxBase64: b64 }));
    expect(res.status).toBe(200);
    expect(await target(res)).not.toBe("lead_excel");
  });

  it("1枚目のシートが空でも、後ろのシートの顧客管理表を見分ける(@codex #607 P2)", async () => {
    const res = await POST(jsonReq({ fileName: "顧客管理表.xlsx", xlsxBase64: xlsxBase64({ 空: [], 一覧: LEAD }) }));
    expect(await target(res)).toBe("lead_excel");
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

describe("大きさの守り(この口は proxy の先読みの上限が効かない)", () => {
  it("表(JSON)の本文が上限を超えると、読む前に断る", async () => {
    const req = new Request("http://t/api/import/detect", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", "content-length": String(17 * 1024 * 1024) },
    }) as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it("中身が大きすぎる表は 422(受け取り箱にも取り込みにも回さない)", async () => {
    const csv = "所有者氏名\n" + "あ".repeat(4 * 1024 * 1024);
    const res = await POST(jsonReq({ fileName: "big.csv", csvText: csv }));
    expect(res.status).toBe(422);
  });

  it("壊れた・展開すると大きすぎる Excel は、顧客管理表の見分け(XLSX.read)の前に 422 で断る(@codex #607 P1)", async () => {
    const res = await POST(jsonReq({ fileName: "x.xlsx", xlsxBase64: Buffer.from("not a zip").toString("base64") }));
    expect(res.status).toBe(422);
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
