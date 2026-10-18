import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const h = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  loadMailSendConfig: vi.fn(),
  sendMailWithAttachments: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: h.writeAuditLog }));
vi.mock("@/lib/mail/mail-config", () => ({ loadMailSendConfig: h.loadMailSendConfig, MAIL_CONFIG_ID: "singleton" }));
vi.mock("@/lib/mail/transport", () => ({ sendMailWithAttachments: h.sendMailWithAttachments }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ keyFromUrl: (u: string) => u.replace("/uploads/", ""), read: h.read }) }));
vi.mock("@/lib/agent-inquiry/property-access", () => ({ assertPropertyReadable: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: { findUnique: vi.fn(), update: vi.fn(async () => ({ version: 3 })) },
    attachment: { findMany: vi.fn(async () => []) },
    mailConfig: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ name: "山田" })) },
    agentInquiryMaterialSend: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "s1" })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { POST, GET as LIST } from "../../app/api/agent-inquiries/[id]/material-sends/route";
import { GET as CANDIDATES } from "../../app/api/agent-inquiries/[id]/material-candidates/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { findUnique: Fn; update: Fn };
  attachment: { findMany: Fn };
  mailConfig: { findUnique: Fn };
  agentInquiryMaterialSend: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn };
};
const IID = "33333333-3333-4333-8333-333333333333";
const PID = "11111111-1111-4111-8111-111111111111";
const A1 = "44444444-4444-4444-8444-444444444444";
const A2 = "55555555-5555-4555-8555-555555555555";
const TOKEN = "66666666-6666-4666-8666-666666666666";
const ctx = { params: Promise.resolve({ id: IID }) };
const inquiry = (o: Record<string, unknown> = {}) => ({
  id: IID, kind: "material_request", status: "open", version: 2, propertyId: PID,
  contactName: "佐藤", contactEmail: "sato@agent.jp",
  agent: { companyName: "△△不動産" }, property: { id: PID, propertyType: "mansion_unit", buildingName: "サンプル荘", roomNo: "101", address: "東京都品川区南品川1-2-3", building: null, adPermissions: [] }, ...o,
});
const att = (o: Record<string, unknown> = {}) => ({
  id: A1, targetType: "property", targetId: PID, type: "general", isDeleted: false, fileName: "図面.pdf",
  fileSize: 1000, fileUrl: "/uploads/attachments/a.pdf", mimeType: "application/pdf", createdAt: new Date(), ...o,
});
const body = (o: Record<string, unknown> = {}) => ({ to: "sato@agent.jp", subject: "件名", body: "本文", attachmentIds: [A1], clientToken: TOKEN, ...o });
const grant = (...p: [string, string][]) =>
  (getUserPermissions as Fn).mockResolvedValue(p.map(([resource, action]) => ({ resource, action, granted: true })));
const CONFIG = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@example.jp", appBaseUrl: null, inquiryMailDetail: "minimal" };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  grant(["agent_inquiry", "read"], ["agent_inquiry", "write"], ["property", "read"]);
  pm.agentInquiry.findUnique.mockResolvedValue(inquiry());
  pm.attachment.findMany.mockResolvedValue([att()]);
  // clearAllMocks は戻り値の設定を消さない=前のテストの「押し直し」設定を毎回戻す。
  pm.agentInquiryMaterialSend.findFirst.mockReset().mockResolvedValue(null);
  pm.agentInquiryMaterialSend.create.mockReset().mockResolvedValue({ id: "s1" });
  h.loadMailSendConfig.mockResolvedValue(CONFIG);
  h.read.mockResolvedValue({ body: Buffer.from("pdf"), contentType: "application/pdf", size: 3 });
  h.sendMailWithAttachments.mockResolvedValue({ ok: true });
});

describe("資料の送信 API", () => {
  it("書く権限が無ければ 403・何も送らない", async () => {
    grant(["agent_inquiry", "read"]);
    expect((await POST(json("POST", body()), ctx)).status).toBe(403);
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("物件を開けなければ送らない", async () => {
    (assertPropertyReadable as Fn).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).not.toBe(201);
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("資料請求でない反響は 400", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ kind: "viewing" }));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("NOT_MATERIAL_REQUEST");
  });
  it("宛先が2件なら 400 INVALID_ADDRESS", async () => {
    const res = await POST(json("POST", body({ to: "a@x.jp, b@y.jp" })), ctx);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });
  it("メール設定が無ければ 409 MAIL_NOT_CONFIGURED", async () => {
    h.loadMailSendConfig.mockResolvedValue(null);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("MAIL_NOT_CONFIGURED");
  });
  it("別の物件の添付 ID を混ぜると 400・予約の行も作らない", async () => {
    pm.attachment.findMany.mockResolvedValue([att(), att({ id: A2, targetId: "other" })]);
    const res = await POST(json("POST", body({ attachmentIds: [A1, A2] })), ctx);
    expect((await res.json()).error.code).toBe("NOT_SELECTABLE");
    expect(pm.agentInquiryMaterialSend.create).not.toHaveBeenCalled();
  });
  it("小窓を開いた後にゴミ箱へ入った添付は送らない(Review Focus 1)", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ isDeleted: true })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("反響資料は権限があっても送れない", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["owner", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "referral" })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
  it("合計 20MB 超は 400 TOO_LARGE", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ fileSize: 20 * 1024 * 1024 + 1 })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("TOO_LARGE");
  });
  it("ファイルが読めなければ 409 FILE_UNAVAILABLE・送らない", async () => {
    h.read.mockResolvedValue(null);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("FILE_UNAVAILABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("成功: 予約→送信→sent・反響を done(version を見ずに進める)・宛先を保存", async () => {
    const res = await POST(json("POST", body({ to: "new@agent.jp" })), ctx);
    expect(res.status).toBe(201);
    expect(pm.agentInquiryMaterialSend.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ result: "sending", clientToken: TOKEN, sentById: "u1", toAddress: "new@agent.jp", totalSize: 1000 }),
    }));
    const sent = h.sendMailWithAttachments.mock.calls[0][1];
    expect(sent).toMatchObject({ to: "new@agent.jp", subject: "件名", text: "本文" });
    expect(sent.attachments[0]).toMatchObject({ filename: "図面.pdf", contentType: "application/pdf" });
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ result: "sent" }) }));
    const upd = pm.agentInquiry.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: IID }); // version を条件にしない(Review Focus 5)
    expect(upd.data).toMatchObject({ status: "done", contactEmail: "new@agent.jp", version: { increment: 1 } });
  });
  it("既に done で宛先も同じなら反響は更新しない", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done" }));
    await POST(json("POST", body()), ctx);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("SMTP 失敗: failed を残し 502・状態は変えない", async () => {
    h.sendMailWithAttachments.mockResolvedValue({ ok: false, code: "ECONNECTION" });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(502);
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ result: "failed", errorCode: "ECONNECTION" }),
    }));
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("同じ鍵の押し直しは送らずに前の結果を返す(Review Focus 2)", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sending" });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "s0", result: "sending", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じ鍵が同時に届いて一意制約にぶつかった方は送らない", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s0", result: "sending" });
    pm.agentInquiryMaterialSend.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await POST(json("POST", body()), ctx);
    expect(await res.json()).toMatchObject({ id: "s0", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("謄本を送ったら監査に1行(宛先は書かない)", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "registry", fileName: "謄本.pdf" })]);
    await POST(json("POST", body()), ctx);
    const call = h.writeAuditLog.mock.calls.find((c) => c[0].action === "registry_pdf_mail_send");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain("sato@agent.jp");
  });
});

describe("候補と記録の API", () => {
  it("候補: 送れないものは出さず・謄本は権限があるときだけ注意つきで出す・文面は差し込み済み", async () => {
    grant(["agent_inquiry", "read"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att(), att({ id: A2, type: "registry", fileName: "謄本.pdf" }), att({ id: "r", type: "report" })]);
    const res = await CANDIDATES(new Request("http://x"), ctx);
    const d = await res.json();
    expect(d.files.map((f: { id: string }) => f.id)).toEqual([A1, A2]);
    expect(d.files[1].warning).toContain("所有者の名前・住所");
    expect(d.subject).toBe("【資料送付】サンプル荘 101");
    expect(d.body).toContain("佐藤 様");
    expect(d.to).toBe("sato@agent.jp");
    expect(d.mailConfigured).toBe(true);
  });
  it("記録: 新しい順・状態の表示つき", async () => {
    pm.agentInquiryMaterialSend.findMany.mockResolvedValue([
      { id: "s1", createdAt: new Date(), result: "sent", sentBy: { name: "山田" }, toAddress: "a@x.jp", subject: "s", body: "b", attachments: [], totalSize: 1, errorCode: null },
    ]);
    const d = await (await LIST(new Request("http://x"), ctx)).json();
    expect(d.items[0].state).toBe("送信済み");
    expect(pm.agentInquiryMaterialSend.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: "desc" } }));
  });
});
