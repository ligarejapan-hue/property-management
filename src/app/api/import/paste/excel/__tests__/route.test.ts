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
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_name_kana", action: "full", granted: true },
  { resource: "owner_phone", action: "full", granted: true },
  { resource: "owner_email", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
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

  it("★owner:write が無ければ403(登録で所有者を作るため・下見の時点で断る)", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner");
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([])) }));
    expect(res.status).toBe(403);
    expect(lookupCalls).toHaveLength(0);
  });

  it("★所有者の備考を書けない人(既定の事務担当=読むだけ)は403で、理由を伝える", async () => {
    // 管理の列は所有者の備考へ入れる。書けない人が登録すると全行403になるか、
    // 管理の情報を黙って捨てることになる。下見の時点で分かる言葉で断る。
    mockPerms = [
      ...FULL_PERMS.filter((p) => p.resource !== "owner_note"),
      { resource: "owner_note", action: "read", granted: true },
    ];
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([])) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("所有者の備考");
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

  it("★シートの範囲が大きすぎるファイルは、中身を読む前に400(@codex PR#456 2巡目 ③)", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([HEADER, row({ 姓名: "一人目", "住所　物件名": "東京都港区1-1", 物件種別: "戸建" })]);
    ws["!ref"] = "A1:N200000";
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const b64 = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: b64 }));
    expect(res.status).toBe(400);
    expect(lookupCalls).toHaveLength(0);
  });

  it("書式だけ下まで付いた実物程度の範囲(1シート約1,000行×3枚)は通る", async () => {
    const wb = XLSX.utils.book_new();
    for (const name of ["A", "B", "C"]) {
      const ws = XLSX.utils.aoa_to_sheet([HEADER, row({ 姓名: name, "住所　物件名": "東京都港区1-1", 物件種別: "戸建" })]);
      ws["!ref"] = "A1:AJ1015";
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const b64 = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: b64 }));
    expect(res.status).toBe(200);
  });

  it("★展開すると大きすぎるファイル(ZIP爆弾)は、Excelとして読む前に400(@codex PR#456 5巡目)", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const data = Buffer.alloc(80 * 1024 * 1024, 0x20);
    const name = Buffer.from("xl/worksheets/sheet1.xml");
    const comp = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + comp.length, 16);
    const zip = Buffer.concat([local, name, comp, central, name, eocd]);
    const res = await POST(req({ fileName: "a.xlsx", xlsxBase64: zip.toString("base64") }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("大きすぎる");
    expect(lookupCalls).toHaveLength(0);
  });

  it("★数値で入った長い案件IDが指数表記に丸められず、別々の反響番号になる(@codex PR#456 6巡目)", async () => {
    const H = ["案件ID", "姓名", "物件所在地", "物件種別/経営プラン", "登録日時"];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      H,
      [123456100000, "一人目", "東京都港区1-1", "一戸建て", "2024/6/22"],
      [123456200000, "二人目", "東京都港区2-2", "一戸建て", "2024/6/23"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "リビンマッチ");
    const b64 = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
    const body = await (await POST(req({ fileName: "a.xlsx", xlsxBase64: b64 }))).json();
    expect(body.rows.map((r: { draft: { externalLinkKey: string } }) => r.draft.externalLinkKey))
      .toEqual(["123456100000", "123456200000"]);
  });

  it("★反響番号の無い行の鍵は、本文から読んだ氏名・住所で作る(補助の列が空でも同じ日の別の反響を区別する・9巡目)", async () => {
    const mailA = "物件種別：戸建\n物件所在地：東京都港区1-1\nお名前：一人目";
    const mailB = "物件種別：戸建\n物件所在地：東京都港区2-2\nお名前：二人目";
    const body = await (await POST(req({
      fileName: "a.xlsx",
      xlsxBase64: xlsxBase64(sheet([
        row({ 依頼日付: "2025/07/22", URL: mailA }),
        row({ 依頼日付: "2025/07/22", URL: mailB }),
      ])),
    }))).json();
    const [a, b] = body.rows.map((r: { draft: { externalLinkKey: string } }) => r.draft.externalLinkKey);
    expect(a).toMatch(/^xlsx-/);
    expect(a).not.toBe(b);
  });

  it("★書き込み権限の無い所有者の項目(電話など)が入った行は、登録できるとは言わず要確認(11巡目 ②)", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner_phone");
    const body = await (await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([row({ URL: MAIL })])) }))).json();
    expect(body.rows[0].status).toBe("review");
    expect(body.rows[0].reasons).toContain("電話番号を書き込む権限がありません");
  });

  it("★メールアドレスの形式が正しくない行は要確認(登録で400になる行を「登録できる」と言わない・11巡目 ③)", async () => {
    mockPerms = [
      ...FULL_PERMS,
      ...["owner_name", "owner_name_kana", "owner_phone", "owner_email", "owner_address"].map((resource) => ({
        resource, action: "full", granted: true,
      })),
    ];
    // 「@」はあるが形式が正しくない(「@」の無い値はそもそもメールとして扱わない)。
    const bad = MAIL + "\nE-mail：taro yamada@example.com";
    const body = await (await POST(req({ fileName: "a.xlsx", xlsxBase64: xlsxBase64(sheet([row({ URL: bad })])) }))).json();
    expect(body.rows[0].status).toBe("review");
    expect(body.rows[0].reasons).toContain("メールアドレスの形式が正しくありません");
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
