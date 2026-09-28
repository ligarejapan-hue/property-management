/**
 * 顧客管理表(Excel)のまとめ取込 — 下見 API の契約テスト。
 * ⚠この API は**何も保存しない**。行ごとの下書きと「まとめて登録してよいか」を返すだけ。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

let mockPerms: unknown;
const FULL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "write", granted: true },
];
const lookupCalls: unknown[] = [];
let lookupResult: (input: { externalLinkKey: string | null }) => unknown = () => ({
  duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
  similar: [],
  ownerCandidates: [],
  ownerCandidatesTruncated: false,
});

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => ({ id: "user-1", role: "admin" })),
    getUserPermissions: vi.fn(async () => mockPerms),
  };
});
// ⚠重複の見立ては貼り付けと**同じ関数**を使う(権限・スコープの扱いも同じ)。
vi.mock("@/lib/paste-import-duplicates", () => ({
  lookupPasteDuplicates: vi.fn(async (_s: unknown, _p: unknown, input: { externalLinkKey: string | null }) => {
    lookupCalls.push(input);
    return lookupResult(input);
  }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { POST } from "../route";
import { NextRequest } from "next/server";

const HEADER = [
  "依頼日付", "姓名", "住所　物件名", "物件種別", "コンタクト", "見込度", "架電",
  "メール", "査定書", "DM", "アポ", "担当者", "メモ", "URL",
];
const MAIL = "査定ナンバー：H-0001\n物件種別：戸建\n物件所在地：東京都世田谷区赤堤9-9-9\nお名前：山田　太郎\n電話番号：090-0000-0000";

function xlsxBase64(sheets: Record<string, string[][]>): string {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
}

const req = (body: unknown) => {
  const s = JSON.stringify(body);
  return new NextRequest("http://localhost/api/import/paste/excel", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(s)) },
    body: s,
  });
};

const sheet = (rows: string[][]) => ({ HOME4U: [["顧客管理表"], HEADER, ...rows] });
const row = (over: Partial<Record<string, string>> = {}) =>
  HEADER.map((h) => over[h] ?? "");

beforeEach(() => {
  mockPerms = FULL_PERMS;
  lookupCalls.length = 0;
  lookupResult = () => ({
    duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
    similar: [],
    ownerCandidates: [],
    ownerCandidatesTruncated: false,
  });
});

describe("POST /api/import/paste/excel", () => {
  it("★import:write が無ければ403", async () => {
    mockPerms = [{ resource: "property", action: "write", granted: true }];
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([])) }));
    expect(res.status).toBe(403);
  });

  it("★property:write が無ければ403", async () => {
    mockPerms = [{ resource: "import", action: "write", granted: true }];
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([])) }));
    expect(res.status).toBe(403);
  });

  it("Excel でなければ400", async () => {
    const res = await POST(req({ fileName: "a.csv", xlsxBase64: "YWJj" }));
    expect(res.status).toBe(400);
  });

  it("取り込める行が無ければ400で、どんな表に対応しているかを伝える", async () => {
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64({ S: [["品名"], ["りんご"]] }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("姓名");
  });

  it("行ごとに下書き・所有者の備考・状態を返す", async () => {
    const res = await POST(req({
      fileName: "顧客管理.xlsx",
      xlsxBase64: xlsxBase64(sheet([row({ 姓名: "山田　太郎", 見込度: "C", 担当者: "勝地", URL: MAIL })])),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    const r = body.rows[0];
    expect(r).toMatchObject({ sheetName: "HOME4U", rowNumber: 3, status: "ready", reasons: [] });
    expect(r.draft.owner.name.value).toBe("山田　太郎");
    expect(r.draft.externalLinkKey).toBe("H-0001");
    expect(r.ownerNote).toContain("見込度: C");
    expect(r.ownerNote).toContain("担当者: 勝地");
    // 物件の備考(誰でも見える)へは管理の列を入れない
    expect(r.draft.noteFromUnmapped).not.toContain("勝地");
  });

  it("★反響番号の無い行には、個人情報を含まない鍵を付ける(取り込み直しても同じ鍵)", async () => {
    const one = row({ 依頼日付: "2025/07/22", 姓名: "鈴木　一郎", "住所　物件名": "東京都港区1-1", 物件種別: "戸建" });
    const a = (await (await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([one])) }))).json()).rows[0];
    const withMemo = [...one];
    withMemo[HEADER.indexOf("メモ")] = "後から書いたメモ";
    const b = (await (await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([withMemo])) }))).json()).rows[0];
    expect(a.draft.externalLinkKey).toMatch(/^xlsx-[0-9a-f]{16}$/);
    expect(a.draft.externalLinkKey).toBe(b.draft.externalLinkKey);
    // 下見の重複確認にも、その鍵で問い合わせている(=登録済みなら止まる)
    expect(lookupCalls[0]).toMatchObject({ externalLinkKey: a.draft.externalLinkKey });
    // 貼り付け画面へ回すときの文章にも同じ鍵が載っている
    expect(a.text).toContain(`反響番号：${a.draft.externalLinkKey}`);
  });

  it("同じ反響番号の物件があれば「登録済み」、似た物件や同名の所有者がいれば「要確認」", async () => {
    lookupResult = (input) => ({
      duplicates: {
        blocked: input.externalLinkKey === "H-0001",
        blockedByPropertyId: input.externalLinkKey === "H-0001" ? "p-1" : null,
        similarPropertyIds: [],
      },
      similar: [],
      ownerCandidates: input.externalLinkKey === "H-0001" ? [] : [{ id: "o-1" }],
      ownerCandidatesTruncated: false,
    });
    const other = MAIL.replace("H-0001", "H-0002");
    const body = await (await POST(req({
      fileName: "a.xlsx",
      xlsxBase64: xlsxBase64(sheet([row({ URL: MAIL }), row({ URL: other })])),
    }))).json();
    expect(body.rows[0]).toMatchObject({ status: "registered", registeredPropertyId: "p-1" });
    expect(body.rows[1]).toMatchObject({ status: "review", reasons: ["同じ名前の所有者がすでにいます"] });
  });

  it("★行数が多すぎれば400(1回の取込は1,000行まで)", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => row({ 姓名: `氏名${i}`, "住所　物件名": `東京都港区${i}` }));
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet(many)) }));
    expect(res.status).toBe(400);
    expect(lookupCalls).toHaveLength(0);
  });

  it("★途中に空行があっても、行番号は Excel 上の行番号のまま(元の表と突き合わせられる)", async () => {
    const body = await (await POST(req({
      fileName: "a.xlsx",
      xlsxBase64: xlsxBase64(sheet([
        row({ 姓名: "一人目", "住所　物件名": "東京都港区1-1", 物件種別: "戸建" }),
        // ⚠本物の空行=セルが1つも無い行(空文字のセルがある行とは別物)。
        [],
        [],
        row({ 姓名: "二人目", "住所　物件名": "東京都港区2-2", 物件種別: "戸建" }),
      ])),
    }))).json();
    expect(body.rows.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([3, 6]);
  });

  it("★表が1行目から始まっていなくても、行番号は Excel 上の行番号", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(ws, [HEADER, row({ 姓名: "一人目", "住所　物件名": "東京都港区1-1", 物件種別: "戸建" })], { origin: "A4" });
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const b64 = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
    const body = await (await POST(req({ fileName: "a.xlsx", xlsxBase64: b64 }))).json();
    expect(body.rows[0].rowNumber).toBe(5);
  });

  it("全シートを読む(見出しの無いシートは飛ばす)", async () => {
    const body = await (await POST(req({
      fileName: "a.xlsx",
      xlsxBase64: xlsxBase64({
        ...sheet([row({ URL: MAIL })]),
        タカウル: [["顧客管理表"], HEADER, row({ 姓名: "佐藤　花子", "住所　物件名": "東京都港区2-2", 物件種別: "戸建" })],
        メモ: [["なにか"]],
      }),
    }))).json();
    expect(body.rows.map((r: { sheetName: string }) => r.sheetName)).toEqual(["HOME4U", "タカウル"]);
  });
});
