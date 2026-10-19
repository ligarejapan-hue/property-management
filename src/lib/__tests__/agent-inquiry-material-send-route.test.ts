import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const h = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  loadMailSendConfig: vi.fn(),
  sendMailWithAttachments: vi.fn(),
  read: vi.fn(),
  authorize: vi.fn(),
  meta: vi.fn(),
}));
vi.mock("@/lib/uploads-authorization", async (orig) => ({
  ...(await orig<typeof import("@/lib/uploads-authorization")>()),
  authorizeUploadAccess: h.authorize,
  resolveProtectedServeMeta: h.meta,
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
    propertyPhoto: { findMany: vi.fn(async () => []) },
    buildingPhoto: { findMany: vi.fn(async () => []) },
    fieldSurveyPinPhoto: { findMany: vi.fn(async () => []) },
    mailConfig: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ name: "山田" })) },
    agentInquiryMaterialSend: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "s1" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => ({ result: "sending", errorCode: null })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    $queryRaw: vi.fn(async () => []),
    auditLog: { createMany: vi.fn(async () => ({ count: 1 })), create: vi.fn(async () => ({})) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { MATERIAL_SEND_LIMITS } from "@/lib/agent-inquiry/material-send";
import { POST, GET as LIST } from "../../app/api/agent-inquiries/[id]/material-sends/route";
import { GET as CANDIDATES } from "../../app/api/agent-inquiries/[id]/material-candidates/route";
import { POST as APPLY } from "../../app/api/agent-inquiries/[id]/material-sends/apply/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { findUnique: Fn; update: Fn };
  attachment: { findMany: Fn };
  propertyPhoto: { findMany: Fn };
  buildingPhoto: { findMany: Fn };
  fieldSurveyPinPhoto: { findMany: Fn };
  mailConfig: { findUnique: Fn };
  agentInquiryMaterialSend: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn; updateMany: Fn; count: Fn; findUnique: Fn };
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
  pm.attachment.findMany.mockReset().mockResolvedValue([att()]);
  pm.propertyPhoto.findMany.mockReset().mockResolvedValue([]);
  pm.buildingPhoto.findMany.mockReset().mockResolvedValue([]);
  pm.fieldSurveyPinPhoto.findMany.mockReset().mockResolvedValue([]);
  // clearAllMocks は戻り値の設定を消さない=前のテストの「押し直し」設定を毎回戻す。
  pm.agentInquiryMaterialSend.findFirst.mockReset().mockResolvedValue(null);
  pm.agentInquiryMaterialSend.create.mockReset().mockResolvedValue({ id: "s1" });
  pm.agentInquiryMaterialSend.update.mockReset().mockResolvedValue({});
  pm.agentInquiryMaterialSend.findUnique.mockReset().mockResolvedValue({ result: "sending", errorCode: null });
  (prismaMock as never as { $transaction: Fn }).$transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  h.loadMailSendConfig.mockResolvedValue(CONFIG);
  h.read.mockResolvedValue({ body: Buffer.from("pdf"), contentType: "application/pdf", size: 3 });
  h.sendMailWithAttachments.mockResolvedValue({ ok: true });
  h.authorize.mockReset().mockResolvedValue("ok");
  h.meta.mockReset().mockResolvedValue(null);
  pm.agentInquiry.update.mockReset().mockResolvedValue({ version: 3 });
  // 反響へまだ反映していない「送信済み」=この中で作った予約の行(送信済みにした後に読む)。
  pending = () => {
    const c = pm.agentInquiryMaterialSend.create.mock.calls.at(-1);
    return c
      ? [{ id: "s1", toAddress: c[0].data.toAddress, statusAtSend: c[0].data.statusAtSend, contactEmailAtSend: c[0].data.contactEmailAtSend }]
      : [];
  };
  history = [];
  applied = [];
  pm.agentInquiryMaterialSend.findMany.mockReset().mockImplementation(async (a: { where: Record<string, unknown> }) =>
    !("inquiryAppliedAt" in a.where) ? history : a.where.inquiryAppliedAt === null ? pending() : applied,
  );
  pm.agentInquiryMaterialSend.updateMany.mockReset().mockResolvedValue({ count: 1 });
  pm.agentInquiryMaterialSend.count.mockReset().mockImplementation(async () => pending().length);
});
let pending: () => { id: string; toAddress: string; statusAtSend: string; contactEmailAtSend: string | null }[] = () => [];
let history: unknown[] = [];
let applied: { toAddress: string }[] = [];
/** 監査の行(取引の中で書いたもの+別に書いたもの)。 */
const auditLogMock = () => (prismaMock as never as { auditLog: { createMany: Fn; create: Fn } }).auditLog;
/** 反響への反映の監査(反映と同じ取引で書く=auditLog.create・@codex 12巡目 P2)。 */
const applyAudits = () => auditLogMock().create.mock.calls.map((c) => c[0].data).filter((d) => d.action === "agent_inquiry_material_apply");
const audits = (): { action: string; detail?: unknown; targetId?: string }[] => [
  ...auditLogMock().createMany.mock.calls.flatMap((c) => c[0].data),
  ...auditLogMock().create.mock.calls.map((c) => c[0].data),
  ...h.writeAuditLog.mock.calls.map((c) => c[0]),
];

/** 物件の添付一覧(targetId で読む)と、同じファイルを指す記録の逆引き(fileUrl で読む)を分けて返す。 */
const sameFileRecords = (others: Record<string, unknown>[]) =>
  pm.attachment.findMany.mockImplementation(async (a: { where: Record<string, unknown> }) =>
    "OR" in a.where ? [att(), ...others] : [att()],
  );

describe("同じファイルを別の物件の記録が指していれば送らない(@codex P2)", () => {
  const OTHER = "77777777-7777-4777-8777-777777777777";
  it("別の物件の添付が同じファイルを指す=送らない・候補にも出さない", async () => {
    sameFileRecords([att({ id: "x", targetId: OTHER })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
    expect((await (await CANDIDATES(new Request("http://x"), ctx)).json()).files).toEqual([]);
  });
  it("削除済みでも、別の物件の記録なら送らない", async () => {
    sameFileRecords([att({ id: "x", targetId: OTHER, isDeleted: true })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
  it("propertyId が別の物件を指す記録も送らない", async () => {
    sameFileRecords([att({ id: "x", propertyId: OTHER })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
  it("所有者に付いた記録が同じファイルを指せば送らない", async () => {
    sameFileRecords([att({ id: "x", targetType: "owner", targetId: OTHER })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
  it("別の物件の写真・棟の写真・巡回の写真が同じファイルなら送らない", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([{ propertyId: OTHER, fileUrl: "/uploads/attachments/a.pdf" }]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    pm.propertyPhoto.findMany.mockResolvedValue([]);
    pm.buildingPhoto.findMany.mockResolvedValue([{ buildingId: "b", fileUrl: "/uploads/attachments/a.pdf" }]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    pm.buildingPhoto.findMany.mockResolvedValue([]);
    pm.fieldSurveyPinPhoto.findMany.mockResolvedValue([{ fileUrl: "/uploads/attachments/a.pdf", thumbnailUrl: null }]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じ物件の写真・同じ物件の別の記録なら送れる/名前が似ているだけの別ファイルは数えない", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([{ propertyId: PID, fileUrl: "/uploads/attachments/a.pdf" }]);
    sameFileRecords([att({ id: "y" }), att({ id: "z", targetId: OTHER, fileUrl: "/uploads/attachments/a.pdf.bak" })]);
    expect((await POST(json("POST", body()), ctx)).status).toBe(201);
  });
  it("別の物件の写真・棟の写真のサムネイルが同じファイルでも送らない(@codex 3巡目)", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([{ propertyId: OTHER, fileUrl: "/uploads/x.jpg", thumbnailUrl: "/uploads/attachments/a.pdf" }]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(pm.propertyPhoto.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ fileUrl: expect.anything() }, { thumbnailUrl: expect.anything() }] },
    }));
    pm.propertyPhoto.findMany.mockResolvedValue([]);
    pm.buildingPhoto.findMany.mockResolvedValue([{ buildingId: "b", fileUrl: "/uploads/x.jpg", thumbnailUrl: "/uploads/attachments/a.pdf" }]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("置き場所が別の物件・写真の置き場所なら、記録が無くても送らない", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ fileUrl: `/uploads/properties/${OTHER}/attachments/a.pdf` })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    pm.attachment.findMany.mockResolvedValue([att({ fileUrl: `/uploads/properties/${PID}/photos/a.jpg` })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    pm.attachment.findMany.mockResolvedValue([att({ fileUrl: `/uploads/properties/${PID}/attachments/a.pdf` })]);
    expect((await POST(json("POST", body()), ctx)).status).toBe(201);
  });
  it("候補の一覧は、ファイルの数によらず決まった回数だけ DB を引く(@codex 4巡目 P2)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => att({ id: `f${i}`, fileUrl: `/uploads/attachments/f${i}.pdf` }));
    pm.attachment.findMany.mockResolvedValue(many);
    const d = await (await CANDIDATES(new Request("http://x"), ctx)).json();
    expect(d.files).toHaveLength(60);
    expect(pm.attachment.findMany.mock.calls.length).toBeLessThanOrEqual(3);
    expect(pm.propertyPhoto.findMany.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("受け取り箱の置き場所のファイルは送らない", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ fileUrl: "/uploads/report-inbox/a.pdf" })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
});

describe("ファイルの守り(/uploads と同じ判定・最終レビュー C1)", () => {
  it("/uploads で開けないファイル(守りが forbidden)は送らない", async () => {
    h.authorize.mockResolvedValue("forbidden");
    const res = await POST(json("POST", body()), ctx);
    expect((await res.json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
    expect(h.authorize).toHaveBeenCalledWith(expect.objectContaining({ key: "attachments/a.pdf", downloadIntent: true }));
  });
  it("同じファイルを反響資料・査定報告書の記録が指していれば送らない(ふつうの添付として登録し直されていても)", async () => {
    h.meta.mockResolvedValue({ kind: "report", attachmentId: "r", propertyId: PID, createdAt: null });
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じファイルを謄本の記録が指していれば謄本として扱う(謄本の権限が要る・監査に残す)", async () => {
    h.meta.mockResolvedValue({ kind: "registry", isRegistry: true, attachmentId: "g", propertyId: PID, createdAt: null, certificateType: null });
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    expect((await POST(json("POST", body()), ctx)).status).toBe(201);
    expect(audits().some((a) => a.action === "registry_pdf_mail_send")).toBe(true);
  });
  it("記録の大きさではなく、実際に読んだ大きさで上限を確かめる", async () => {
    const over = MATERIAL_SEND_LIMITS.maxTotalBytes + 1;
    h.read.mockResolvedValue({ body: Buffer.alloc(over), contentType: "application/pdf", size: over });
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("TOO_LARGE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("ファイルの種類はストレージの値を使う(記録の値は手で書ける)", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ mimeType: "text/html" })]);
    await POST(json("POST", body()), ctx);
    expect(h.sendMailWithAttachments.mock.calls[0][1].attachments[0].contentType).toBe("application/pdf");
  });
  it("候補にも同じ守り(開けないもの・反響資料と同じファイルは出さない・謄本と同じファイルは注意つき)", async () => {
    grant(["agent_inquiry", "read"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    const own = [att(), att({ id: A2, fileUrl: "/uploads/attachments/b.pdf" }), att({ id: "c", fileUrl: "/uploads/attachments/c.pdf" })];
    // 候補は記録をまとめて引いて決める(@codex 4巡目 P2): b は削除済みの反響資料の記録と同じファイル・c は謄本の記録と同じファイル。
    pm.attachment.findMany.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      "OR" in a.where
        ? [
            ...own,
            att({ id: "x", type: "referral", isDeleted: true, fileUrl: "/uploads/attachments/b.pdf" }),
            att({ id: "g", type: "registry", isDeleted: true, fileUrl: "/uploads/attachments/c.pdf" }),
          ]
        : own,
    );
    const d = await (await CANDIDATES(new Request("http://x"), ctx)).json();
    expect(d.files.map((f: { id: string }) => f.id)).toEqual([A1, "c"]);
    expect(d.files[1].warning).toContain("所有者の名前・住所");
  });
});

describe("送れた後に反響の更新が落ちたら、あとで反映し直す(@codex 2巡目 P2)", () => {
  // 送った時点の反響=open・宛先 sato@agent.jp(inquiry() と同じ)。
  const stuck = () => [{ id: "s0", toAddress: "new@agent.jp", statusAtSend: "open", contactEmailAtSend: "sato@agent.jp" }];
  it("予約のときに反響を押さえて読み直し、その時点の状態と宛先を残す(@codex 18巡目 P2)", async () => {
    pm.agentInquiry.findUnique
      .mockResolvedValueOnce(inquiry()) // 最初の読み込み(open)
      .mockResolvedValueOnce({ status: "in_progress", contactEmail: "mid@agent.jp" }); // 予約の直前に別の人が変えた
    await POST(json("POST", body()), ctx);
    const raw = (prismaMock as never as { $queryRaw: Fn }).$queryRaw;
    expect((raw.mock.calls[0][0] as string[]).join("?")).toMatch(/FROM agent_inquiries WHERE id = \?::uuid FOR UPDATE/);
    expect(pm.agentInquiryMaterialSend.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ statusAtSend: "in_progress", contactEmailAtSend: "mid@agent.jp" }),
    }));
  });
  it("予約の時刻はアプリの時計で入れる(反映の時刻と同じ時計で比べる・@codex 18巡目 P2)", async () => {
    await POST(json("POST", body()), ctx);
    expect(pm.agentInquiryMaterialSend.create.mock.calls[0][0].data.createdAt).toBeInstanceOf(Date);
  });
  it("予約の行に、送った時点の反響の状態と宛先を残す", async () => {
    await POST(json("POST", body({ to: "new@agent.jp" })), ctx);
    expect(pm.agentInquiryMaterialSend.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ statusAtSend: "open", contactEmailAtSend: "sato@agent.jp" }),
    }));
  });
  it("送信のあとの反映は、反映済みの印を付けてから反響を done にする(同じ取引の中)", async () => {
    await POST(json("POST", body()), ctx);
    expect(pm.agentInquiryMaterialSend.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ inquiryAppliedAt: null }),
      data: expect.objectContaining({ inquiryAppliedAt: expect.any(Date) }),
    }));
    expect(pm.agentInquiry.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done" }) }));
  });
  it("同じ鍵の押し直しで、前回の送信済みが反響に反映されていなければ反映し直す(監査に残す)", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sent", inquiryId: IID, createdAt: new Date() });
    pending = stuck;
    const res = await POST(json("POST", body()), ctx);
    expect(await res.json()).toMatchObject({ result: "sent", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
    expect(pm.agentInquiry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: IID }, data: expect.objectContaining({ status: "done", contactEmail: "new@agent.jp" }),
    }));
    expect(applyAudits()).toEqual([expect.objectContaining({ targetId: IID, userId: "u1" })]);
  });
  it("記録を読む(GET)は書き換えない=未反映があるとだけ返す", async () => {
    pending = stuck;
    const d = await (await LIST(new Request("http://x"), ctx)).json();
    expect(d.needsApply).toBe(true);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
    expect(pm.agentInquiryMaterialSend.updateMany).not.toHaveBeenCalled();
  });
  it("反映し直しの口(POST)は書ける人だけ=反映して監査に残す", async () => {
    pending = stuck;
    const res = await APPLY(json("POST", {}), ctx);
    expect(await res.json()).toMatchObject({ applied: true });
    expect(pm.agentInquiry.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done" }) }));
    expect(applyAudits()).toEqual([expect.objectContaining({ userId: "u1" })]);
    expect(h.writeAuditLog).not.toHaveBeenCalled(); // 取引の外で書かない
  });
  it("読むだけの人は反映し直しの口を使えない", async () => {
    grant(["agent_inquiry", "read"], ["property", "read"]);
    pending = stuck;
    const res = await APPLY(json("POST", {}), ctx);
    expect(res.status).toBe(403);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("別の人が先に反映した(印が付けられなかった)なら、反響は書き換えない", async () => {
    pending = stuck;
    pm.agentInquiryMaterialSend.updateMany.mockResolvedValue({ count: 0 });
    expect(await (await APPLY(json("POST", {}), ctx)).json()).toMatchObject({ applied: false });
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
    expect(applyAudits()).toEqual([]);
  });
  it("送った後に状態も宛先も手で変えられていれば上書きしない=印だけ付ける", async () => {
    pending = stuck;
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "in_progress", contactEmail: "other@agent.jp" }));
    expect(await (await APPLY(json("POST", {}), ctx)).json()).toMatchObject({ applied: false });
    expect(pm.agentInquiryMaterialSend.updateMany).toHaveBeenCalled();
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("メモ・担当など別の欄を直しただけなら反映する(@codex 8巡目 P2)", async () => {
    pending = stuck;
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ updatedAt: new Date("2026-10-19T03:05:00Z"), note: "電話した" }));
    expect(await (await APPLY(json("POST", {}), ctx)).json()).toMatchObject({ applied: true });
    expect(pm.agentInquiry.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "done", contactEmail: "new@agent.jp" }),
    }));
  });
  it("反映し直しは反響の行を鍵で押さえてから読む(同じ反響の反映し直しを1つずつ・@codex 9巡目 P2)", async () => {
    pending = stuck;
    await APPLY(json("POST", {}), ctx);
    const raw = (prismaMock as never as { $queryRaw: Fn }).$queryRaw;
    expect(raw).toHaveBeenCalled();
    expect((raw.mock.calls[0][0] as string[]).join("?")).toMatch(/FROM agent_inquiries WHERE id = \?::uuid FOR UPDATE/);
  });
  it("同時に送った2件目: 1件目の反映で変わった宛先・状態は「手の変更」と見なさず、2件目の宛先にする(@codex 9巡目 P2)", async () => {
    pending = () => [{ id: "s2", toAddress: "second@agent.jp", statusAtSend: "open", contactEmailAtSend: "sato@agent.jp" }];
    applied = [{ toAddress: "first@agent.jp" }];
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done", contactEmail: "first@agent.jp" }));
    expect(await (await APPLY(json("POST", {}), ctx)).json()).toMatchObject({ applied: true });
    const d = pm.agentInquiry.update.mock.calls[0][0].data;
    expect(d.contactEmail).toBe("second@agent.jp");
    expect(d.status).toBeUndefined();
  });
  it("未反映が2件: 1件目のあと手で宛先を直し、2件目をその宛先から送った=2件目の宛先にする(@codex 10巡目 P2)", async () => {
    pending = () => [
      { id: "s1", toAddress: "b@agent.jp", statusAtSend: "open", contactEmailAtSend: "a@agent.jp" },
      { id: "s2", toAddress: "d@agent.jp", statusAtSend: "open", contactEmailAtSend: "c@agent.jp" },
    ];
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ contactEmail: "c@agent.jp" }));
    await APPLY(json("POST", {}), ctx);
    expect(pm.agentInquiry.update.mock.calls[0][0].data.contactEmail).toBe("d@agent.jp");
  });
  it("未反映が2件: 古い送信の時点の状態に手で戻した=最新の送信より後の手の変更なので done にしない(@codex 14巡目 P2)", async () => {
    pending = () => [
      { id: "s1", toAddress: "sato@agent.jp", statusAtSend: "open", contactEmailAtSend: "sato@agent.jp" },
      { id: "s2", toAddress: "sato@agent.jp", statusAtSend: "in_progress", contactEmailAtSend: "sato@agent.jp" },
    ];
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "open" }));
    await APPLY(json("POST", {}), ctx);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("未反映が2件: 手で1件目の送り先(まだ反映していない)に直した=手の変更なので上書きしない(@codex 15巡目 P2)", async () => {
    pending = () => [
      { id: "s1", toAddress: "b@agent.jp", statusAtSend: "done", contactEmailAtSend: "a@agent.jp" },
      { id: "s2", toAddress: "d@agent.jp", statusAtSend: "done", contactEmailAtSend: "c@agent.jp" },
    ];
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done", contactEmail: "b@agent.jp" }));
    await APPLY(json("POST", {}), ctx);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("宛先を実際に書いた反映済みの送信だけを「資料送付が書いた宛先」とみなす(@codex 16巡目 P2)", async () => {
    pending = stuck;
    await APPLY(json("POST", {}), ctx);
    const appliedQuery = pm.agentInquiryMaterialSend.findMany.mock.calls
      .map((c) => c[0].where)
      .find((w) => w.inquiryAppliedAt && w.inquiryAppliedAt !== null && "wroteContact" in w);
    expect(appliedQuery).toMatchObject({ wroteContact: true });
    // 今回宛先を書いた送信(最新)に印を付ける
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith({ where: { id: "s0" }, data: { wroteContact: true } });
  });
  it("「資料送付が書いた宛先」は、最新の未反映の送信より後に書いた直近の1件だけ(@codex 17巡目 P2)", async () => {
    const at = new Date("2026-10-19T03:00:00Z");
    pending = () => [{ id: "s2", toAddress: "d@agent.jp", statusAtSend: "done", contactEmailAtSend: "c@agent.jp", createdAt: at } as never];
    await APPLY(json("POST", {}), ctx);
    const call = pm.agentInquiryMaterialSend.findMany.mock.calls.find((c) => c[0].where.wroteContact === true)![0];
    expect(call.where.inquiryAppliedAt).toEqual({ gt: at });
    expect(call).toMatchObject({ orderBy: { inquiryAppliedAt: "desc" }, take: 1 });
  });
  it("宛先を書かなかった反映では印を付けない", async () => {
    pending = stuck;
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ contactEmail: "new@agent.jp" }));
    await APPLY(json("POST", {}), ctx);
    expect(pm.agentInquiryMaterialSend.update.mock.calls.some((c) => c[0].data.wroteContact)).toBe(false);
  });
  it("未反映が2件: 古い送信の時点の宛先に手で戻した=上書きしない", async () => {
    pending = () => [
      { id: "s1", toAddress: "b@agent.jp", statusAtSend: "done", contactEmailAtSend: "a@agent.jp" },
      { id: "s2", toAddress: "d@agent.jp", statusAtSend: "done", contactEmailAtSend: "c@agent.jp" },
    ];
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done", contactEmail: "a@agent.jp" }));
    await APPLY(json("POST", {}), ctx);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("状態だけ手で変えられていれば、宛先だけ直す(状態は残す)", async () => {
    pending = stuck;
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "in_progress" }));
    await APPLY(json("POST", {}), ctx);
    const d = pm.agentInquiry.update.mock.calls[0][0].data;
    expect(d.status).toBeUndefined();
    expect(d.contactEmail).toBe("new@agent.jp");
  });
  it("宛先だけ手で直されていれば、状態だけ done にする(宛先は残す)", async () => {
    pending = stuck;
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ contactEmail: "fixed@agent.jp" }));
    await APPLY(json("POST", {}), ctx);
    const d = pm.agentInquiry.update.mock.calls[0][0].data;
    expect(d.status).toBe("done");
    expect(d.contactEmail).toBeUndefined();
  });
  it("未反映が無ければ何もしない", async () => {
    pending = () => [];
    expect(await (await APPLY(json("POST", {}), ctx)).json()).toMatchObject({ applied: false });
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
});

describe("送信のあとの扱い(最終レビュー I2・I3・M1・M2)", () => {
  it("送れた後に反響の更新が失敗しても、記録は送信済みにして 201(状態は直せなかったと返す)", async () => {
    pm.agentInquiry.update.mockRejectedValue(new Error("db down"));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ result: "sent", statusUpdated: false });
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ result: "sent" }) }));
  });
  it("送れたら「送信済み」と監査の行を同じ取引で書く(監査だけ抜けない・@codex 10巡目 P2)", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "registry" })]);
    await POST(json("POST", body()), ctx);
    const cm = (prismaMock as never as { auditLog: { createMany: Fn } }).auditLog.createMany;
    expect(cm).toHaveBeenCalledTimes(1);
    const actions = cm.mock.calls[0][0].data.map((d: { action: string }) => d.action);
    expect(actions).toEqual(["agent_inquiry_material_send", "registry_pdf_mail_send"]);
    expect(h.writeAuditLog.mock.calls.some((c) => c[0].action === "agent_inquiry_material_send")).toBe(false);
  });
  it("対応済みの反響に別の宛先で送った=宛先だけ変えたときも監査に残す(@codex 11巡目 P2)", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done" }));
    await POST(json("POST", body({ to: "new@agent.jp" })), ctx);
    expect(pm.agentInquiry.update.mock.calls[0][0].data).toMatchObject({ contactEmail: "new@agent.jp" });
    expect(applyAudits()).toEqual([expect.objectContaining({ detail: { statusChanged: false, contactChanged: true } })]);
  });
  it("書き込みは済んだのに応答だけ落ちてやり直した=監査を二重に書かない(@codex 19巡目 P2)", async () => {
    const tx = (prismaMock as never as { $transaction: Fn }).$transaction;
    // 予約(1回目)はそのまま・送信済みの書き込み(2回目)は中身が済んでから応答だけ落ちる
    tx.mockImplementationOnce(async (fn: (t: unknown) => unknown) => fn(prismaMock))
      .mockImplementationOnce(async (fn: (t: unknown) => unknown) => {
        await fn(prismaMock);
        throw new Error("connection lost after commit");
      });
    // やり直しのときは、もう送信済みになっている
    pm.agentInquiryMaterialSend.findUnique
      .mockResolvedValueOnce({ result: "sending", errorCode: null })
      .mockResolvedValue({ result: "sent", errorCode: null });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(201);
    const cm = (prismaMock as never as { auditLog: { createMany: Fn } }).auditLog.createMany;
    expect(cm).toHaveBeenCalledTimes(1);
  });
  it("送れたか分からないときも、印と監査を同じ取引で書く", async () => {
    h.sendMailWithAttachments.mockResolvedValue({ ok: false, code: "ETIMEDOUT" });
    await POST(json("POST", body()), ctx);
    const cm = (prismaMock as never as { auditLog: { createMany: Fn } }).auditLog.createMany;
    expect(cm.mock.calls[0][0].data[0]).toMatchObject({ action: "agent_inquiry_material_send", detail: { outcome: "unknown" } });
  });
  it("送れた後に「送信済み」の書き込みが一時的に落ちても、やり直して送信済みにする(@codex 6巡目 P1)", async () => {
    pm.agentInquiryMaterialSend.update.mockReset()
      .mockRejectedValueOnce(new Error("db blip"))
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValue({});
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(201);
    const sentCalls = pm.agentInquiryMaterialSend.update.mock.calls.filter((c) => c[0].data.result === "sent");
    expect(sentCalls.length).toBe(3);
  });
  it("「送信済み」の書き込みがずっと落ちても、送れたことは返す(エラーにして押し直させない)", async () => {
    pm.agentInquiryMaterialSend.update.mockReset().mockRejectedValue(new Error("db down"));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ result: "sent", recorded: false });
    expect(h.sendMailWithAttachments).toHaveBeenCalledTimes(1);
  });
  it("押し直しの応答に状態の表示(10分を過ぎた送信中=結果不明)を付ける", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sending", inquiryId: IID, createdAt: new Date(Date.now() - 11 * 60 * 1000) });
    expect(await (await POST(json("POST", body()), ctx)).json()).toMatchObject({ id: "s0", result: "sending", state: "結果不明", replayed: true });
  });
  it("別の反響に同じ鍵を使ったら 409(前の結果を返さない)", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sent", inquiryId: "other", createdAt: new Date() });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(409);
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("本文に目に見えない制御文字があれば 422", async () => {
    expect((await POST(json("POST", body({ body: "a\u0007b" })), ctx)).status).toBe(422);
  });
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
  it("合計が上限を超えると 400 TOO_LARGE", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ fileSize: MATERIAL_SEND_LIMITS.maxTotalBytes + 1 })]);
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
      data: expect.objectContaining({ result: "sending", clientToken: TOKEN, sentById: "u1", toAddress: "new@agent.jp", totalSize: 3 }),
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
  it("SMTP 失敗(はっきり断られた): failed を残し 502・状態は変えない", async () => {
    h.sendMailWithAttachments.mockResolvedValue({ ok: false, code: "EAUTH" });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("SEND_FAILED");
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ result: "failed", errorCode: "EAUTH" }),
    }));
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("SMTP 失敗(送れたか分からない=時間切れ・切断): 送信中のまま結果不明にし、2通目が出ないようにする(@codex 4巡目 P1)", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ type: "registry" })]);
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    for (const code of ["ETIMEDOUT", "ECONNECTION", null]) {
      vi.clearAllMocks();
      h.sendMailWithAttachments.mockResolvedValue({ ok: false, code });
      const res = await POST(json("POST", body()), ctx);
      expect(res.status).toBe(502);
      expect((await res.json()).error.code).toBe("SEND_UNKNOWN");
      const upd = pm.agentInquiryMaterialSend.update.mock.calls.at(-1)![0];
      expect(upd.data.result).toBeUndefined();
      expect(upd.data).toMatchObject({ errorCode: code ?? "UNKNOWN" });
      expect(pm.agentInquiry.update).not.toHaveBeenCalled();
      // 届いたかもしれない=謄本の取り扱いの記録は残す
      expect(audits().some((a) => a.action === "registry_pdf_mail_send")).toBe(true);
    }
  });
  it("結果不明の押し直しは、前の結果(結果不明)を返して送らない", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sending", inquiryId: IID, createdAt: new Date(), errorCode: "ETIMEDOUT" });
    expect(await (await POST(json("POST", body()), ctx)).json()).toMatchObject({ result: "sending", state: "結果不明", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じ鍵の押し直しは送らずに前の結果を返す(Review Focus 2)", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sending", inquiryId: IID, createdAt: new Date() });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "s0", result: "sending", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じ鍵が同時に届いて一意制約にぶつかった方は送らない", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s0", result: "sending", inquiryId: IID, createdAt: new Date() });
    pm.agentInquiryMaterialSend.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await POST(json("POST", body()), ctx);
    expect(await res.json()).toMatchObject({ id: "s0", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("謄本を送ったら監査に1行(宛先は書かない)", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "registry", fileName: "謄本.pdf" })]);
    await POST(json("POST", body()), ctx);
    const call = audits().find((a) => a.action === "registry_pdf_mail_send");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain("sato@agent.jp");
  });
});

describe("候補と記録の API", () => {
  it("候補: 送れないものは出さず・謄本は権限があるときだけ注意つきで出す・文面は差し込み済み", async () => {
    grant(["agent_inquiry", "read"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([
      att(),
      att({ id: A2, type: "registry", fileName: "謄本.pdf", fileUrl: "/uploads/attachments/t.pdf" }),
      att({ id: "r", type: "report", fileUrl: "/uploads/attachments/r.pdf" }),
    ]);
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
    history = [
      { id: "s1", createdAt: new Date(), result: "sent", sentBy: { name: "山田" }, toAddress: "a@x.jp", subject: "s", body: "b", attachments: [], totalSize: 1, errorCode: null },
    ];
    const d = await (await LIST(new Request("http://x"), ctx)).json();
    expect(d.items[0].state).toBe("送信済み");
    expect(pm.agentInquiryMaterialSend.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: "desc" } }));
  });
});
