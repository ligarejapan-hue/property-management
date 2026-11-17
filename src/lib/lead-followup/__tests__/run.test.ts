import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// 追客メールの1回分の実行。DB は差し替え($transaction は自分自身を tx として渡す)。

const db = vi.hoisted(() => {
  const self = {
    mailConfig: { findUnique: vi.fn() },
    leadFollowupStep: { findMany: vi.fn() },
    leadFollowup: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
    leadFollowupSend: { createMany: vi.fn(), count: vi.fn() },
    mailUnsubscribe: { findUnique: vi.fn(), findMany: vi.fn() },
    property: { findMany: vi.fn() },
    dmInquiry: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(self)),
  };
  return self;
});
vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
const setup = vi.hoisted(() => ({
  loadFollowupSetupContext: vi.fn(),
}));
vi.mock("@/lib/lead-followup/settings-store", () => setup);
const mail = vi.hoisted(() => ({ loadMailSendConfig: vi.fn() }));
vi.mock("@/lib/mail/mail-config", () => ({ MAIL_CONFIG_ID: "singleton", loadMailSendConfig: mail.loadMailSendConfig }));

import { isWithinSendHoursJst, normalizeFollowupEmail, runLeadFollowups } from "@/lib/lead-followup/run";
import { NEW_FLOW_ENDED_BY_HOLD } from "@/lib/lead-followup/decide";
import { writeAuditLog } from "@/lib/audit";

const savedSecret = process.env.NEXTAUTH_SECRET;
process.env.NEXTAUTH_SECRET = "test-secret-for-followup-run-0123456789";
afterAll(() => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
});

// 日本時間 2026-12-03 10:00(送る時間帯)
const NOW = new Date("2026-12-03T01:00:00Z");
const ENABLED_AT = new Date("2026-11-30T00:00:00Z");
const CREATED = new Date("2026-12-01T00:00:00Z");
const ROW_ID = "2d9a5e3c-7f4b-4c8d-9e0f-3a4b5c6d7e8f";
const PROP_ID = "0b9c7f1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";
const sender = { companyName: "見本不動産", address: "見本県見本市1-1", tel: "000-0000-0000", email: "info@example.test" };
const STEP_ROWS = [
  { series: "new", delayDays: 0, subject: "ご挨拶", body: "挨拶の本文" },
  { series: "new", delayDays: 3, subject: "その後いかがですか", body: "3日目の本文" },
  { series: "hold", delayDays: 7, subject: "保留のご案内", body: "保留の本文" },
];
const activeRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  targetType: "property",
  propertyId: PROP_ID,
  inquiryId: null,
  emailNormalized: "owner@example.test",
  newStartedAt: CREATED,
  newNextPosition: 2,
  holdStartedAt: null,
  holdNextPosition: 1,
  ...over,
});
const property = (over: Record<string, unknown> = {}) => ({
  id: PROP_ID,
  caseStatus: "contact_attempting",
  propertyOwners: [{ owner: { email: " Owner@Example.test " } }],
  ...over,
});

const sendMail = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  db.mailConfig.findUnique.mockResolvedValue({ followupEnabled: true, followupEnabledAt: ENABLED_AT });
  db.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  db.leadFollowupStep.findMany.mockResolvedValue(STEP_ROWS);
  db.leadFollowup.updateMany.mockResolvedValue({ count: 1 });
  db.leadFollowup.findMany.mockResolvedValue([]);
  db.leadFollowup.findFirst.mockResolvedValue(null);
  db.leadFollowup.createMany.mockResolvedValue({ count: 1 });
  db.leadFollowupSend.createMany.mockResolvedValue({ count: 1 });
  db.leadFollowupSend.count.mockResolvedValue(0);
  db.mailUnsubscribe.findUnique.mockResolvedValue(null);
  db.mailUnsubscribe.findMany.mockResolvedValue([]);
  db.property.findMany.mockResolvedValue([]);
  db.dmInquiry.findMany.mockResolvedValue([]);
  setup.loadFollowupSetupContext.mockResolvedValue({ sender, unsubscribeBaseUrl: "https://pub.example.test/", problems: [] });
  mail.loadMailSendConfig.mockResolvedValue({ host: "h", port: 465, secure: true, user: "u", pass: "p", from: "f@example.test" });
  sendMail.mockResolvedValue({ ok: true });
});

const run = (now = NOW, opts: Record<string, unknown> = {}) =>
  runLeadFollowups(now, { sendMail, deadline: Date.now() + 60_000, ...opts });

/** 進行中の行の一覧(findMany の2回目以降=評価)を返すように */
function withActiveRows(rows: unknown[], props: unknown[] = [property()]) {
  db.leadFollowup.findMany.mockResolvedValue(rows);
  // 1回目=新しい対象探し(物件)、2回目=評価する行の物件
  db.property.findMany.mockResolvedValueOnce([]).mockResolvedValue(props);
}

describe("小さな決まり", () => {
  it("アドレスは比べる形(前後の空白を除き小文字)・形がおかしいものは null", () => {
    expect(normalizeFollowupEmail(" A@Example.Test ")).toBe("a@example.test");
    for (const v of [null, "", "a@b", "a b@c.d", "a@b.c\r\nBcc:x@y.z", "<a@b.c>", "a@b.c,d@e.f"]) expect(normalizeFollowupEmail(v)).toBeNull();
  });

  it("送る時間帯は日本時間 9:00〜20:00", () => {
    expect(isWithinSendHoursJst(new Date("2026-12-03T00:00:00Z"))).toBe(true); // 9:00
    expect(isWithinSendHoursJst(new Date("2026-12-02T23:59:00Z"))).toBe(false); // 8:59
    expect(isWithinSendHoursJst(new Date("2026-12-03T10:59:00Z"))).toBe(true); // 19:59
    expect(isWithinSendHoursJst(new Date("2026-12-03T11:00:00Z"))).toBe(false); // 20:00
  });
});

describe("OFF・準備不足", () => {
  it("OFF なら進行中を全部 disabled で止めて終わり(探さない・送らない)", async () => {
    db.mailConfig.findUnique.mockResolvedValue({ followupEnabled: false, followupEnabledAt: ENABLED_AT });
    db.leadFollowup.updateMany.mockResolvedValueOnce({ count: 3 });
    const s = await run();
    expect(s).toMatchObject({ enabled: false, disabledStopped: 3 });
    expect(db.leadFollowup.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: "active" },
      data: { status: "stopped", stopReason: "disabled" },
    });
    expect(db.property.findMany).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("送っている途中のまま30分を過ぎた行は interrupted で止める(送り直さない)", async () => {
    await run();
    const stale = db.leadFollowup.updateMany.mock.calls[0][0];
    expect(stale.where.status).toBe("sending");
    expect(stale.where.claimedAt.lt).toEqual(new Date(NOW.getTime() - 30 * 60_000));
    expect(stale.data).toMatchObject({ status: "stopped", stopReason: "interrupted" });
  });

  it("会社の設定・外向きの URL・文面が欠けていたら、行に触らず終わり", async () => {
    setup.loadFollowupSetupContext.mockResolvedValueOnce({ sender, unsubscribeBaseUrl: null, problems: ["外向きの URL がありません"] });
    expect(await run()).toMatchObject({ enabled: true, ready: false, notReadyCount: 1 });
    db.leadFollowupStep.findMany.mockResolvedValueOnce([{ series: "new", delayDays: 0, subject: "", body: "x" }]);
    expect(await run()).toMatchObject({ ready: false });
    mail.loadMailSendConfig.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ ready: false });
    expect(db.property.findMany).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("新しい対象を見つける", () => {
  it("ON にした時刻より後・一括査定・行が無い・終わっていない・メールのある所有者がいる物件を探す", async () => {
    await run();
    const where = db.property.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ introductionRoute: "bulk_assessment", createdAt: { gte: ENABLED_AT }, leadFollowup: { is: null } });
    expect(where.caseStatus.notIn).toContain("negotiating");
    expect(where.caseStatus.notIn).not.toContain("hold");
    const inq = db.dmInquiry.findMany.mock.calls[0][0].where;
    expect(inq).toMatchObject({ autoReplyStatus: "sent", submittedAt: { gte: ENABLED_AT }, handleStatus: { not: "done" }, leadFollowup: { is: null } });
  });

  it("物件の行を作る(アドレスの鍵の下・起点=登録日・比べる形のアドレス)", async () => {
    db.property.findMany.mockResolvedValueOnce([{ id: PROP_ID, createdAt: CREATED, propertyOwners: [{ owner: { email: null } }, { owner: { email: " Owner@Example.test " } }] }]);
    const s = await run();
    expect(s.started).toBe(1);
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.leadFollowup.createMany.mock.calls[0][0]).toEqual({
      data: [{ targetType: "property", propertyId: PROP_ID, emailNormalized: "owner@example.test", status: "active", stopReason: null, newStartedAt: CREATED }],
      skipDuplicates: true,
    });
  });

  it("配信停止のアドレス・同じアドレスで進行中の追客があれば、止めた行として作る", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([
      { id: "q1", submittedAt: CREATED, email: "a@example.test" },
      { id: "q2", submittedAt: CREATED, email: "b@example.test" },
    ]);
    db.mailUnsubscribe.findUnique.mockResolvedValueOnce({ id: "u" }).mockResolvedValueOnce(null);
    db.leadFollowup.findFirst.mockResolvedValueOnce({ id: "other" });
    const s = await run();
    expect(s.startedStopped).toBe(2);
    expect(db.leadFollowup.createMany.mock.calls[0][0].data[0]).toMatchObject({ inquiryId: "q1", status: "stopped", stopReason: "unsubscribed" });
    expect(db.leadFollowup.createMany.mock.calls[1][0].data[0]).toMatchObject({ inquiryId: "q2", status: "stopped", stopReason: "duplicate_address" });
  });

  it("担当が先に止めた印がある(作れない)ときは数えない", async () => {
    db.property.findMany.mockResolvedValueOnce([{ id: PROP_ID, createdAt: CREATED, propertyOwners: [{ owner: { email: "o@example.test" } }] }]);
    db.leadFollowup.createMany.mockResolvedValueOnce({ count: 0 });
    const s = await run();
    expect(s.started + s.startedStopped).toBe(0);
  });
});

describe("送る", () => {
  it("日が来た通を送る: 元の書き方のアドレス・件名・本文+末尾(最初の1通の一文)・配信停止のヘッダー", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    const s = await run();
    expect(s.sent).toBe(1);
    const [, m] = sendMail.mock.calls[0];
    expect(m.to).toBe("Owner@Example.test");
    expect(m.subject).toBe("ご挨拶");
    expect(m.text).toContain("挨拶の本文");
    expect(m.text).toContain("送信者: 見本不動産");
    expect(m.text).toContain("お心当たりのない場合は");
    expect(m.listUnsubscribeUrl).toMatch(/^https:\/\/pub\.example\.test\/u\/f[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(m.text).toContain(m.listUnsubscribeUrl);
    // 取り合い(active→sending)は進み具合も条件にする
    const claim = db.leadFollowup.updateMany.mock.calls.find((c) => c[0].data.status === "sending")![0];
    expect(claim.where).toEqual({ id: ROW_ID, status: "active", newNextPosition: 1, holdNextPosition: 1 });
    // 書き戻しは sending のときだけ・次の通へ
    const fin = db.leadFollowup.updateMany.mock.calls.find((c) => c[0].where.status === "sending" && c[0].where.id)![0];
    expect(fin.data).toEqual({ status: "active", newNextPosition: 2, claimedAt: null });
    // 送った時刻は状態の条件なしで残す(送信中に止められた行でも「20時間に1通」が効く・@codex #757 P2)
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].where.id === ROW_ID && c[0].where.status === undefined && c[0].data.lastSentAt === NOW)).toBe(true);
    expect(db.leadFollowupSend.createMany.mock.calls[0][0].data[0]).toMatchObject({ followupId: ROW_ID, series: "new", position: 1, result: "sent", subject: "ご挨拶" });
    // 監査は定型の項目だけ(アドレス・件名・本文なし)
    expect(writeAuditLog).toHaveBeenCalledWith({
      action: "lead_followup_send",
      targetTable: "lead_followups",
      targetId: ROW_ID,
      detail: { result: "sent", series: "new", position: 1 },
    });
    expect(JSON.stringify(vi.mocked(writeAuditLog).mock.calls)).not.toMatch(/example\.test|ご挨拶|本文/);
  });

  it("2通目からは「お心当たりのない場合」の一文を付けない", async () => {
    withActiveRows([activeRow()]);
    db.leadFollowupSend.count.mockResolvedValueOnce(1);
    await run(new Date("2026-12-04T01:00:00Z"));
    expect(sendMail.mock.calls[0][1].text).not.toContain("お心当たりのない場合は");
  });

  it("送れなかったら止める(send_failed・送り直さない)・監査は定型のコードだけ", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    sendMail.mockResolvedValueOnce({ ok: false, code: "EENVELOPE" });
    const s = await run();
    expect(s.failed).toBe(1);
    const fin = db.leadFollowup.updateMany.mock.calls.find((c) => c[0].where.status === "sending" && c[0].where.id)![0];
    expect(fin.data).toMatchObject({ status: "stopped", stopReason: "send_failed" });
    expect(db.leadFollowupSend.createMany.mock.calls[0][0].data[0].result).toBe("failed");
    expect(vi.mocked(writeAuditLog).mock.calls[0][0].detail).toEqual({ result: "failed", series: "new", position: 1, code: "EENVELOPE" });
  });

  it("時間帯の外・1回の上限・持ち時間切れでは送らない(行は変えず次の実行へ)", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    expect(await run(new Date("2026-12-03T12:00:00Z"))).toMatchObject({ sent: 0, deferred: 1 }); // 21:00
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    expect(await run(NOW, { maxSends: 0 })).toMatchObject({ sent: 0, deferred: 1 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].data.status === "sending")).toBe(false);
  });

  it("同じアドレスへ直近20時間に送っていたら送らない(1アドレス1日1通)", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    db.leadFollowup.findFirst.mockResolvedValueOnce({ id: "x" });
    const s = await run();
    expect(s).toMatchObject({ sent: 0, deferred: 1 });
    expect(db.leadFollowup.findFirst.mock.calls[0][0].where.lastSentAt.gt).toEqual(new Date(NOW.getTime() - 20 * 3_600_000));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("取り合いに負けたら(担当が止めた・ほかの実行が先)送らない", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    db.leadFollowup.updateMany.mockImplementation(async (a: { data: { status?: string } }) => ({ count: a.data.status === "sending" ? 0 : 1 }));
    expect((await run()).sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("鍵の下で配信停止を見つけたら止めて送らない", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    db.mailUnsubscribe.findUnique.mockResolvedValueOnce({ id: "u" });
    const s = await run();
    expect(s).toMatchObject({ sent: 0, stopped: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("止める・飛ばす・保留", () => {
  it("物件が消えた・メールが無くなった/変わった・配信停止済みは止める", async () => {
    withActiveRows([activeRow({ propertyId: null })], []);
    await run();
    withActiveRows([activeRow()], [property({ propertyOwners: [{ owner: { email: "new@example.test" } }] })]);
    await run();
    withActiveRows([activeRow()]);
    db.mailUnsubscribe.findMany.mockResolvedValueOnce([{ emailNormalized: "owner@example.test" }]);
    await run();
    const reasons = db.leadFollowup.updateMany.mock.calls.map((c) => c[0].data.stopReason).filter((r) => r && r !== "interrupted");
    expect(reasons).toEqual(["target_deleted", "no_address", "unsubscribed"]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("やりとり中の間に日が来た通は飛ばした記録を残して次へ", async () => {
    withActiveRows([activeRow()], [property({ caseStatus: "contacting_owner" })]);
    const s = await run(new Date("2026-12-04T01:00:00Z"));
    expect(s.skipped).toBe(1);
    expect(db.leadFollowupSend.createMany.mock.calls[0][0].data[0]).toMatchObject({ series: "new", position: 2, result: "skipped" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("保留になったら保留の流れへ(起点=今)", async () => {
    withActiveRows([activeRow()], [property({ caseStatus: "hold" })]);
    await run();
    const upd = db.leadFollowup.updateMany.mock.calls.find((c) => c[0].data.newNextPosition === NEW_FLOW_ENDED_BY_HOLD)![0];
    expect(upd.data).toEqual({ newNextPosition: NEW_FLOW_ENDED_BY_HOLD, holdStartedAt: NOW });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("全部の通を終えたら completed", async () => {
    withActiveRows([activeRow({ newNextPosition: 3 })]);
    expect((await run()).completed).toBe(1);
  });
});

describe("失敗・途中の OFF に強くする(内部レビュー)", () => {
  const row2 = () => activeRow({ id: "3e8b6f4d-8a5c-4d9e-af10-4b5c6d7e8f90", newNextPosition: 1 });

  it("接続・認証の失敗(確実に送っていない)は止めずに進行中へ戻し、その回はもう送らない", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 }), row2()], [property()]);
    sendMail.mockResolvedValueOnce({ ok: false, code: "EAUTH" });
    const s = await run();
    expect(s).toMatchObject({ sent: 0, failed: 0 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const back = db.leadFollowup.updateMany.mock.calls.find((c) => c[0].where.status === "sending" && c[0].data.status === "active")![0];
    expect(back.data).toEqual({ status: "active", claimedAt: null });
    expect(db.leadFollowupSend.createMany).not.toHaveBeenCalled();
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].data.stopReason === "send_failed")).toBe(false);
    expect(vi.mocked(writeAuditLog).mock.calls[0][0].detail).toEqual({ result: "deferred", series: "new", position: 1, code: "EAUTH" });
  });

  it("それ以外の失敗はその追客を止め、その回はもう送らない(大勢を一度に止めない)", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 }), row2()], [property()]);
    sendMail.mockResolvedValueOnce({ ok: false, code: "EENVELOPE" });
    const s = await run();
    expect(s).toMatchObject({ failed: 1, sent: 0, deferred: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("実行の途中で画面から OFF にされていたら、鍵の下で気づいて送らない", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    db.mailConfig.findUnique
      .mockResolvedValueOnce({ followupEnabled: true, followupEnabledAt: ENABLED_AT })
      .mockResolvedValueOnce({ followupEnabled: false, followupEnabledAt: ENABLED_AT });
    const s = await run();
    expect(s.sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].data.status === "sending")).toBe(false);
  });

  it("1行の判断で例外が出ても、残りの行は続けて見る", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 }), row2()], [property()]);
    db.mailUnsubscribe.findUnique.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await run();
    expect(s.errors).toBe(1);
    expect(s.sent).toBe(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain("db down");
    err.mockRestore();
  });
});

describe("ON の期間と送った時刻(@codex #757)", () => {
  it("探している最中に OFF(または OFF→ON で別の期間)になっていたら、行を作らない", async () => {
    db.property.findMany.mockResolvedValueOnce([{ id: PROP_ID, createdAt: CREATED, propertyOwners: [{ owner: { email: "o@example.test" } }] }]);
    db.mailConfig.findUnique
      .mockResolvedValueOnce({ followupEnabled: true, followupEnabledAt: ENABLED_AT })
      .mockResolvedValueOnce({ followupEnabled: false, followupEnabledAt: ENABLED_AT });
    expect((await run()).started).toBe(0);
    db.property.findMany.mockResolvedValueOnce([{ id: PROP_ID, createdAt: CREATED, propertyOwners: [{ owner: { email: "o@example.test" } }] }]);
    db.mailConfig.findUnique
      .mockResolvedValueOnce({ followupEnabled: true, followupEnabledAt: ENABLED_AT })
      .mockResolvedValueOnce({ followupEnabled: true, followupEnabledAt: new Date("2026-12-02T00:00:00Z") });
    expect((await run()).started).toBe(0);
    expect(db.leadFollowup.createMany).not.toHaveBeenCalled();
  });

  it("設定の行は FOR UPDATE で押さえる(画面の OFF の保存と順番をそろえる)", async () => {
    db.property.findMany.mockResolvedValueOnce([{ id: PROP_ID, createdAt: CREATED, propertyOwners: [{ owner: { email: "o@example.test" } }] }]);
    await run();
    const sql = (db.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/SELECT 1 FROM mail_config WHERE id = \? FOR UPDATE/);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.leadFollowup.createMany.mock.invocationCallOrder[0]);
  });

  it("送信中に担当が止めた行でも、送った時刻を残す", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    db.leadFollowup.updateMany.mockImplementation(async (a: { where: { status?: string } }) => ({ count: a.where.status === "sending" ? 0 : 1 }));
    await run();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].where.status === undefined && c[0].data.lastSentAt === NOW)).toBe(true);
  });
});

describe("@codex #757 2回目", () => {
  it("ECONNECTION(本文を渡したあとに切れたかもしれない)は届いた扱い: 送り直さずに止め、送った時刻も残す", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    sendMail.mockResolvedValueOnce({ ok: false, code: "ECONNECTION" });
    const s = await run();
    expect(s).toMatchObject({ failed: 1 });
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].data.stopReason === "send_failed")).toBe(true);
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].where.status === undefined && c[0].data.lastSentAt === NOW)).toBe(true);
    expect(db.leadFollowup.updateMany.mock.calls.some((c) => c[0].where.status === "sending" && c[0].data.status === "active")).toBe(false);
  });

  it("送る前の押さえる順番は、行を作るときと同じ(設定の行 → アドレスの鍵)", async () => {
    withActiveRows([activeRow({ newNextPosition: 1 })]);
    await run();
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.$executeRaw.mock.invocationCallOrder[0]);
  });
});
