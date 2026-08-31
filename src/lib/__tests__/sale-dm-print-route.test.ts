import { vi } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

// requireSaleDmAccess は Plan 1 の route-guard。ここではゲートを mock し、許可/403 を切り替える。
const { requireSaleDmAccess } = vi.hoisted(() => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess,
  filterDraftsByFieldStaffScope: (drafts: Array<{ property: { createdBy: string | null; assignedTo: string | null } }>, session: { id: string; role?: string }) =>
    session.role === "field_staff" ? drafts.filter((d) => d.property.createdBy === session.id || d.property.assignedTo === session.id) : drafts,
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    dmCampaign: { findUnique: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
    // 印刷直前の terminal(拒否/宛先不明)再検査(@codex #384 R1 P1)。既定=記録なし。
    propertyDmLog: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []), // Owner FOR SHARE
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/print/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
  propertyDmLog: { findMany: ReturnType<typeof vi.fn> };
};

const variant = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: null,
};
const draft = {
  id: "r1",
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区",
  body: "本文です",
  status: "confirmed",
  trackingToken: "tok1",
  variant,
};

const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = () => new Request("http://x/api/properties/sale-dm/campaigns/c1/print");

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  // 郵送QRには絶対URLが必須。通常系は追跡baseを設定して通す。
  process.env = { ...ENV, SALE_DM_TRACKING_BASE_URL: "https://dm.example.com", SALE_DM_LP_URL: "https://lp.example.com", SALE_DM_SENDER_NAME: "△△不動産", SALE_DM_SENDER_CONTACT: "03-0000-0000", NEXTAUTH_SECRET: "print-test-secret" };
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト", createdBy: "u1" });
  pm.dmRecipientDraft.findMany.mockResolvedValue([draft]);
});

describe("GET .../campaigns/[id]/print", () => {
  it("確定分を text/html + no-store で返す", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("田中 一郎");
    expect(html).toContain("本文です");
    // 追跡QR/短縮URL が印刷HTMLへ配線されている(P5 slot 連携・宛先固有 /t/<token>)
    expect(html).toContain("sale-dm-tracking");
    expect(html).toContain("https://dm.example.com/t/tok1");
    // confirmed かつ body あり(生成失敗の空letterは印刷しない)のみ問い合わせること。
    const arg = pm.dmRecipientDraft.findMany.mock.calls[0][0];
    expect(arg.where.campaignId).toBe("c1");
    expect(arg.where.status).toBe("confirmed");
    expect(arg.where.body).toEqual({ not: "" });
  });

  it("配信停止QR(署名付き /u/)が紙面に配線されている(追跡QRとは別トークン)", async () => {
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    // 停止枠(専用クラス)+ /u/<trackingToken>.<署名> の絶対URL
    expect(html).toContain("sale-dm-unsubscribe");
    expect(html).toMatch(/https:\/\/dm\.example\.com\/u\/tok1\.[A-Za-z0-9_-]{22}/);
    // 追跡トークン素のままでは /u/ に載らない(署名なしURLを紙面に出さない)
    expect(html).not.toContain("https://dm.example.com/u/tok1<");
    expect(html).not.toMatch(/\/u\/tok1["<]/);
  });

  it("NEXTAUTH_SECRET 未設定なら 503(停止QRを署名できない手紙を刷らせない=fail-closed)", async () => {
    delete process.env.NEXTAUTH_SECRET;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("追跡baseURL(SALE_DM_TRACKING_BASE_URL)未設定なら 503(郵送QRが相対パスで機能しないため fail-closed)", async () => {
    delete process.env.SALE_DM_TRACKING_BASE_URL;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("LP URL(SALE_DM_LP_URL)未設定なら 503(郵送QRの遷移先が無く dead-link になるため)", async () => {
    delete process.env.SALE_DM_LP_URL;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("非絶対の LP URL(lp.example.com)も 503(未設定扱い)", async () => {
    process.env.SALE_DM_LP_URL = "lp.example.com";
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("差出人(SALE_DM_SENDER_NAME/CONTACT)未設定なら 503(差出人欄が不正な郵送物を印刷しない・生成/再生成と統一・Codex)", async () => {
    delete process.env.SALE_DM_SENDER_NAME;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("印刷出力を非PIIメタで監査する(本文・宛名を含まない・直GETも追跡可能に)", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalled();
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.campaignId).toBe("c1");
    expect(detail.count).toBe(1);
    expect(JSON.stringify(detail)).not.toContain("田中");
    expect(JSON.stringify(detail)).not.toContain("本文");
  });

  it("複数共有者(coOwnerCount>1)は宛名に『他共有者様』が付く", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ ...draft, coOwnerCount: 2 }]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).toContain("他共有者様");
  });

  it("単独所有者(coOwnerCount=1)は『他共有者様』が付かない", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ ...draft, coOwnerCount: 1 }]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).not.toContain("他共有者様");
  });

  it("確定 0 件でも 200(空ドキュメント)", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("letter-page ");
  });

  it("field_staff は担当外物件の宛先を印刷しない(record scope・GET campaign / CSV と統一)", async () => {
    requireSaleDmAccess.mockResolvedValue({ session: { id: "u1", role: "field_staff" } });
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { ...draft, recipientName: "担当内オーナー", property: { createdBy: "u1", assignedTo: "x" } },
      { ...draft, id: "r2", trackingToken: "tok2", recipientName: "担当外オーナー", property: { createdBy: "x", assignedTo: "x" } },
    ]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).toContain("担当内オーナー");
    expect(html).not.toContain("担当外オーナー");
    // 監査件数は実際に印刷した可視分のみ(担当内1件)。drafts 全体(2件)で過大計上しない。
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.count).toBe(1);
  });

  it("campaign 不在は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(404);
  });

  it("権限不足(ゲートが 403 throw)で 403・DB を読まない", async () => {
    requireSaleDmAccess.mockRejectedValue(new ApiError(403, "x", "FORBIDDEN"));
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmCampaign.findUnique).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 拒否・宛先不明(terminal)の**印刷直前**再検査(@codex #384 R1 P1)。
// 作成〜印刷の間に記録された拒否を素通りさせない(A=宛名CSVのDL時再検査と同じ関所)。
// ============================================================================
describe("印刷直前の terminal 再検査", () => {
  const dA = { ...draft, id: "rA", propertyId: "pA", representativeOwnerId: "oA", draftOwners: [{ ownerId: "oA" }], recipientName: "甲野 太郎", trackingToken: "tokA" };
  const dB = { ...draft, id: "rB", propertyId: "pB", representativeOwnerId: "oB", draftOwners: [{ ownerId: "oB" }], recipientName: "乙山 次郎", trackingToken: "tokB" };

  it("拒否が付いた宛先は印刷から除外し、件数を紙面と監査に出す", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([dA, dB]);
    pm.propertyDmLog.findMany.mockResolvedValueOnce([
      { ownerId: "oA", propertyId: null, logOwners: [] },
    ]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("1 件の宛先は、この印刷から除外しました");
    expect(html).not.toContain("甲野 太郎"); // 除外された手紙は紙面に載らない
    expect(html).toContain("乙山 次郎");
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.excludedTerminal).toBe(1);
    expect(detail.count).toBe(1); // 実際に刷った数
  });

  it("全宛先が terminal なら 409 ALL_EXCLUDED_TERMINAL(白紙を刷らせない)", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([dA]);
    pm.propertyDmLog.findMany.mockResolvedValueOnce([
      { ownerId: "oA", propertyId: null, logOwners: [] },
    ]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(409);
  });

  it("terminal 記録が無ければ従来どおり全件印刷・excludedTerminal=0", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([dA, dB]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.excludedTerminal).toBe(0);
    expect(detail.count).toBe(2);
  });
});

// 注記は**画面専用**(@codex #384 R2 P2): 印刷媒体ではお客様の紙面に内部運用の
// 文言を刷り込まない。
describe("除外注記は印刷に出ない", () => {
  it("@media print で非表示にするスタイルと画面専用クラスが入る", async () => {
    const dA2 = { ...draft, id: "rA", propertyId: "pA", representativeOwnerId: "oA", draftOwners: [{ ownerId: "oA" }], trackingToken: "tokA" };
    const dB2 = { ...draft, id: "rB", propertyId: "pB", representativeOwnerId: "oB", draftOwners: [{ ownerId: "oB" }], trackingToken: "tokB" };
    pm.dmRecipientDraft.findMany.mockResolvedValue([dA2, dB2]);
    pm.propertyDmLog.findMany.mockResolvedValueOnce([
      { ownerId: "oA", propertyId: null, logOwners: [] },
    ]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).toContain('class="pm-terminal-note"');
    expect(html).toContain("@media print{.pm-terminal-note{display:none");
  });
});

// 事前読取〜ロックの間に所有者統合が入ったら負けを認めて 409(@codex #384 R3 P1)。
describe("ロック後の読み直しで所有者集合が変わったら 409 RETRY", () => {
  it("読み直しの owner がロック集合の外なら印刷しない", async () => {
    const d1 = { ...draft, id: "rA", propertyId: "pA", representativeOwnerId: "oA", draftOwners: [{ ownerId: "oA" }], trackingToken: "tokA" };
    // 1回目(事前読取)=oA / 2回目(tx内読み直し)=oMaster(統合後)
    pm.dmRecipientDraft.findMany
      .mockResolvedValueOnce([d1])
      .mockResolvedValueOnce([{ id: "rA", propertyId: "pA", representativeOwnerId: "oMaster", draftOwners: [{ ownerId: "oMaster" }] }]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("RETRY");
  });
});
