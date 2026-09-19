import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    dmInquiry: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/mail/mail-config", () => ({ loadMailSendConfig: vi.fn() }));
vi.mock("@/lib/mail/transport", () => ({ sendPlainMail: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ checkSaleDmAccessFor: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/inquiry-notify-mail", () => ({
  buildInquiryNotifyMail: vi.fn(() => ({ subject: "S", text: "T" })),
}));
vi.mock("@/lib/sale-dm-letter/tags", () => ({
  coarsePropertyLocation: vi.fn(() => "渋谷区"),
  propertyTypeLabel: vi.fn(() => "マンション"),
}));

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail } from "@/lib/mail/transport";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";
import { buildInquiryNotifyMail } from "@/lib/sale-dm-letter/inquiry-notify-mail";
import {
  notifyInquiry,
  startInquiryNotify,
  countInquiryNotifyRecipients,
  NOTIFY_RETRY_DELAYS_MS,
  NOTIFY_STALE_CLAIM_MS,
} from "@/lib/sale-dm-letter/inquiry-notify";

const pm = prisma as unknown as {
  dmInquiry: {
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  user: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
};
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const loadCfg = loadMailSendConfig as ReturnType<typeof vi.fn>;
const send = sendPlainMail as ReturnType<typeof vi.fn>;
const checkAccess = checkSaleDmAccessFor as ReturnType<typeof vi.fn>;
const buildMail = buildInquiryNotifyMail as ReturnType<typeof vi.fn>;

const INQUIRY_ID = "inq-1";
const NOW = new Date("2026-09-19T00:00:00.000Z");
const nowFn = () => NOW;

// checkSaleDmAccessFor の ok:true 応答の基準値(電話・メールとも平文=full 送信可)。
const PLAIN_ACCESS = {
  ok: true as const,
  permissions: [],
  ownerDisplayConfig: {
    name: "full",
    nameKana: "full",
    phone: "full",
    zip: "full",
    address: "full",
    note: "full",
    email: "full",
    corporateNumber: "full",
  },
};

const FULL_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "u",
  pass: "p",
  from: "from@example.com",
  appBaseUrl: null,
  inquiryMailDetail: "full" as const,
};

const PROPERTY: { address: string; propertyType: string; createdBy: string | null; assignedTo: string | null } = {
  address: "東京都渋谷区1-2-3",
  propertyType: "mansion",
  createdBy: null,
  assignedTo: null,
};

function draftRow(overrides: Partial<typeof PROPERTY> = {}) {
  return {
    id: INQUIRY_ID,
    submittedAt: NOW,
    name: "山田太郎",
    phone: "090-1234-5678",
    email: "applicant@example.com",
    contactPref: "phone",
    contactTime: null,
    message: null,
    draft: {
      campaign: { name: "秋キャンペーン" },
      variant: { label: "A型" },
      lpVariant: { label: "LP-A" },
      property: { ...PROPERTY, ...overrides },
    },
  };
}

function user(id: string, opts: Partial<{ role: string; email: string; inquiryNotifyEmail: string | null }> = {}) {
  return { id, email: opts.email ?? `${id}@example.com`, role: opts.role ?? "office_staff", inquiryNotifyEmail: opts.inquiryNotifyEmail ?? null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  pm.dmInquiry.updateMany.mockResolvedValue({ count: 1 });
  pm.dmInquiry.findUnique.mockResolvedValue(draftRow());
  pm.dmInquiry.update.mockResolvedValue({});
  pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
  pm.user.count.mockResolvedValue(0);
  loadCfg.mockResolvedValue(FULL_CONFIG);
  checkAccess.mockResolvedValue(PLAIN_ACCESS);
  send.mockResolvedValue({ ok: true });
  buildMail.mockReturnValue({ subject: "S", text: "T" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notifyInquiry: 取り合い", () => {
  it("最初の updateMany の where/data が仕様どおり・count 0 なら skipped で何もしない", async () => {
    pm.dmInquiry.updateMany.mockResolvedValue({ count: 0 });
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("skipped");
    expect(pm.dmInquiry.updateMany).toHaveBeenCalledWith({
      where: {
        id: INQUIRY_ID,
        OR: [
          { notifyStatus: { in: ["pending", "failed"] } },
          { notifyStatus: "sending", notifyClaimedAt: { lt: new Date(NOW.getTime() - NOTIFY_STALE_CLAIM_MS) } },
        ],
      },
      data: { notifyStatus: "sending", notifyClaimedAt: NOW },
    });
    expect(pm.dmInquiry.findUnique).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(pm.dmInquiry.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("notifyInquiry: 設定未完成", () => {
  it("loadMailSendConfig が null なら送らず failed・監査・再試行タイマーなし", async () => {
    loadCfg.mockResolvedValue(null);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "failed", notifyLastError: "mail_not_configured", notifyAttempts: { increment: 1 } },
    });
    expect(audit).toHaveBeenCalledWith({
      action: "inquiry_notify_failed",
      targetTable: "dm_inquiries",
      targetId: INQUIRY_ID,
      detail: { attempt: 1, code: "mail_not_configured" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("notifyInquiry: 宛先0人", () => {
  it("通知ONの利用者がいない場合 no_recipients・再試行なし", async () => {
    pm.user.findMany.mockResolvedValue([]);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("failed");
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "failed", notifyLastError: "no_recipients", notifyAttempts: { increment: 1 } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "inquiry_notify_failed", detail: { attempt: 1, code: "no_recipients" } }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("全員 checkSaleDmAccessFor が ok:false でも no_recipients", async () => {
    checkAccess.mockResolvedValue({ ok: false, reason: "display" });
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("failed");
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "failed", notifyLastError: "no_recipients", notifyAttempts: { increment: 1 } },
    });
  });

  it("checkSaleDmAccessFor が DB 例外を投げても、その宛先だけ諦めて他は続行(全員が例外なら no_recipients)", async () => {
    checkAccess.mockRejectedValue(new Error("db down"));
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("failed");
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "failed", notifyLastError: "no_recipients", notifyAttempts: { increment: 1 } },
    });
  });

  it("1人の checkSaleDmAccessFor が例外でも他の宛先は届く(1人の失敗で全体を止めない)", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    checkAccess.mockImplementation(async (userId: string) => {
      if (userId === "u-a") throw new Error("db down");
      return PLAIN_ACCESS;
    });
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("sent");
    const toAddresses = send.mock.calls.map((c) => c[1].to);
    expect(toAddresses).toEqual(["u-b@example.com"]);
    const call = audit.mock.calls[0][0];
    expect(call.detail).toEqual({ attempt: 1, recipientUserIds: ["u-b"] });
  });
});

describe("notifyInquiry: field_staff の範囲", () => {
  it("物件の createdBy/assignedTo どちらでもない field_staff には送らない。office/admin には送る", async () => {
    pm.dmInquiry.findUnique.mockResolvedValue(draftRow({ createdBy: "u-owner" }));
    pm.user.findMany.mockResolvedValue([
      user("u-owner", { role: "field_staff" }),
      user("u-other-field", { role: "field_staff" }),
      user("u-office", { role: "office_staff" }),
      user("u-admin", { role: "admin" }),
    ]);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("sent");
    const toAddresses = send.mock.calls.map((c) => c[1].to);
    expect(toAddresses).toEqual(
      expect.arrayContaining(["u-owner@example.com", "u-office@example.com", "u-admin@example.com"]),
    );
    expect(toAddresses).not.toContain("u-other-field@example.com");
    expect(send).toHaveBeenCalledTimes(3);
    const sentAudit = audit.mock.calls[0][0];
    expect(sentAudit.detail.recipientUserIds.sort()).toEqual(["u-admin", "u-office", "u-owner"]);
  });

  it("field_staff が assignedTo で一致していれば送る", async () => {
    pm.dmInquiry.findUnique.mockResolvedValue(draftRow({ assignedTo: "u-assignee" }));
    pm.user.findMany.mockResolvedValue([user("u-assignee", { role: "field_staff" })]);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledWith(FULL_CONFIG, expect.objectContaining({ to: "u-assignee@example.com" }));
  });
});

describe("notifyInquiry: 宛先アドレス", () => {
  it("inquiryNotifyEmail が設定されていればそちら優先・無ければ email", async () => {
    pm.user.findMany.mockResolvedValue([
      user("u-a", { email: "a@example.com", inquiryNotifyEmail: "a-notify@example.com" }),
      user("u-b", { email: "b@example.com", inquiryNotifyEmail: null }),
    ]);
    await notifyInquiry(INQUIRY_ID, { now: nowFn });
    const toAddresses = send.mock.calls.map((c) => c[1].to);
    expect(toAddresses).toEqual(expect.arrayContaining(["a-notify@example.com", "b@example.com"]));
  });
});

describe("notifyInquiry: 受け手ごとの詳しさ", () => {
  it("設定 full で、電話/メールとも平文の受け手は full・メールが masked の受け手は minimal", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    checkAccess.mockImplementation(async (userId: string) =>
      userId === "u-b" ? { ok: true, permissions: [], ownerDisplayConfig: { ...PLAIN_ACCESS.ownerDisplayConfig, email: "masked" } } : PLAIN_ACCESS,
    );
    await notifyInquiry(INQUIRY_ID, { now: nowFn });
    const details = buildMail.mock.calls.map((c) => c[1].detail);
    expect(details.sort()).toEqual(["full", "minimal"]);
  });

  it("設定 minimal なら電話/メールとも平文でも全員 minimal", async () => {
    loadCfg.mockResolvedValue({ ...FULL_CONFIG, inquiryMailDetail: "minimal" });
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    await notifyInquiry(INQUIRY_ID, { now: nowFn });
    const details = buildMail.mock.calls.map((c) => c[1].detail);
    expect(details).toEqual(["minimal", "minimal"]);
  });
});

describe("notifyInquiry: 成功", () => {
  it("全員成功 → sent・監査にアドレスを含まない recipientUserIds", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("sent");
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: 1 } },
    });
    const call = audit.mock.calls[0][0];
    expect(call.action).toBe("inquiry_notify_sent");
    expect(call.detail).toEqual({ attempt: 1, recipientUserIds: ["u-a", "u-b"] });
    expect(JSON.stringify(call)).not.toContain("@example.com");
  });
});

describe("notifyInquiry: 申込が消えていた", () => {
  it("findUnique が null なら状態を戻さず skipped", async () => {
    pm.dmInquiry.findUnique.mockResolvedValue(null);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("skipped");
    expect(pm.dmInquiry.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("notifyInquiry: 再試行", () => {
  it(
    "1回目でBだけ失敗→30秒後にBだけへ再送→成功でsent",
    { timeout: 20_000 },
    async () => {
      pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
      let bCalls = 0;
      send.mockImplementation(async (_config, mail: { to: string }) => {
        if (mail.to === "u-b@example.com") {
          bCalls += 1;
          return bCalls === 1 ? { ok: false, code: "ECONNECTION" } : { ok: true };
        }
        return { ok: true };
      });

      const promise = notifyInquiry(INQUIRY_ID, { now: nowFn });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[0]);
      const result = await promise;

      expect(result).toBe("sent");
      expect(send).toHaveBeenCalledTimes(3);
      // 2回目はBにだけ送っている(Aは1回のみ)。
      const aCalls = send.mock.calls.filter((c) => c[1].to === "u-a@example.com");
      expect(aCalls).toHaveLength(1);
      expect(pm.dmInquiry.update).toHaveBeenCalledWith({
        where: { id: INQUIRY_ID },
        data: { notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: 2 } },
      });
    },
  );

  it(
    "Bが4回とも(1回目+再試行3回)失敗し続けたらfailed+partial・待ち時間はNOTIFY_RETRY_DELAYS_MSの順",
    { timeout: 20_000 },
    async () => {
      pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
      send.mockImplementation(async (_config, mail: { to: string }) =>
        mail.to === "u-b@example.com" ? { ok: false, code: "ECONNECTION" } : { ok: true },
      );

      const promise = notifyInquiry(INQUIRY_ID, { now: nowFn });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2); // attempt 1: A, B

      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[0]);
      expect(send).toHaveBeenCalledTimes(3); // attempt 2: B only

      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[1]);
      expect(send).toHaveBeenCalledTimes(4); // attempt 3: B only

      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[2]);
      const result = await promise;
      expect(send).toHaveBeenCalledTimes(5); // attempt 4: B only

      expect(result).toBe("failed");
      expect(pm.dmInquiry.update).toHaveBeenCalledWith({
        where: { id: INQUIRY_ID },
        data: { notifyStatus: "failed", notifyLastError: "partial", notifyAttempts: { increment: 4 } },
      });
      expect(audit).toHaveBeenCalledWith({
        action: "inquiry_notify_failed",
        targetTable: "dm_inquiries",
        targetId: INQUIRY_ID,
        detail: { attempt: 4, code: "partial" },
      });
    },
  );

  it(
    "全員が失敗し続けたらsend_failed",
    { timeout: 20_000 },
    async () => {
      pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
      send.mockResolvedValue({ ok: false, code: "ECONNECTION" });

      const promise = notifyInquiry(INQUIRY_ID, { now: nowFn });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[0]);
      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[1]);
      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[2]);
      const result = await promise;

      expect(result).toBe("failed");
      expect(pm.dmInquiry.update).toHaveBeenCalledWith({
        where: { id: INQUIRY_ID },
        data: { notifyStatus: "failed", notifyLastError: "send_failed", notifyAttempts: { increment: 4 } },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "inquiry_notify_failed", detail: { attempt: 4, code: "send_failed" } }),
      );
    },
  );
});

describe("notifyInquiry: 想定外の例外で sending のまま残さない(controller ruling 2)", () => {
  it("findUnique が reject しても終端状態(failed/send_failed)を記録してから投げ直す", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyInquiry(INQUIRY_ID, { now: nowFn })).rejects.toThrow("db down");
    expect(pm.dmInquiry.update).toHaveBeenCalledWith({
      where: { id: INQUIRY_ID },
      data: { notifyStatus: "failed", notifyLastError: "send_failed", notifyAttempts: { increment: 1 } },
    });
    const call = audit.mock.calls.at(-1)?.[0];
    expect(call).toEqual({
      action: "inquiry_notify_failed",
      targetTable: "dm_inquiries",
      targetId: INQUIRY_ID,
      detail: { attempt: 1, code: "send_failed" },
    });
  });

  it("終端状態の記録自体が失敗しても例外は投げ直す(取り合い済み行が残っても15分後に取り直せる)", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(new Error("db down"));
    pm.dmInquiry.update.mockRejectedValue(new Error("update also down"));
    await expect(notifyInquiry(INQUIRY_ID, { now: nowFn })).rejects.toThrow("db down");
  });
});

describe("startInquiryNotify: 例外で落ちない", () => {
  it("内部で何が throw しても外に投げず、console.error は name/code だけ", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(Object.assign(new Error("db down"), { code: "ECONNECTION" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => startInquiryNotify(INQUIRY_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    const call = spy.mock.calls.find((c) => c[0] === "[sale_dm_inquiry_notify] failed");
    expect(call?.[1]).toEqual({ name: "Error", code: "ECONNECTION" });
    spy.mockRestore();
  });
});

describe("countInquiryNotifyRecipients", () => {
  it("isActive && inquiryNotifyEnabled で数える", async () => {
    pm.user.count.mockResolvedValue(4);
    const result = await countInquiryNotifyRecipients();
    expect(result).toBe(4);
    expect(pm.user.count).toHaveBeenCalledWith({ where: { isActive: true, inquiryNotifyEnabled: true } });
  });
});
