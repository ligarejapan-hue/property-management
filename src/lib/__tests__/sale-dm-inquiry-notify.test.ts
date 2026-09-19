import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    dmInquiry: { updateMany: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/mail/mail-config", () => ({ loadMailSendConfig: vi.fn() }));
vi.mock("@/lib/mail/transport", async (importOriginal) => {
  // safeErrorCode(許可リスト検査の純関数・副作用なし)は実装をそのまま使う(Minor 3 の
  // 検証で startInquiryNotify がこれ経由で code を絞っていることを実物で確かめるため)。
  const actual = await importOriginal<typeof import("@/lib/mail/transport")>();
  return { ...actual, sendPlainMail: vi.fn() };
});
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

// finish()/refreshClaim() はどちらも dmInquiry.updateMany を使う(取り合いキーの保有チェック
// つき)。呼び出しの区別: 終端書き込みは data に notifyStatus を含む・保有更新だけの refresh は
// notifyClaimedAt のみ。
function findRefreshCall() {
  return pm.dmInquiry.updateMany.mock.calls.find(
    ([arg]) => "notifyClaimedAt" in arg.data && !("notifyStatus" in arg.data),
  );
}

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

describe("notifyInquiry: 定数", () => {
  // Important 3: 定数そのものをテストで固定する(フェイク時計を定数経由で駆動すると
  // [1,1,1] のような壊れた値でもテストが通ってしまう)。
  it("NOTIFY_RETRY_DELAYS_MS / NOTIFY_STALE_CLAIM_MS はブリーフの値に固定", () => {
    expect(NOTIFY_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000]);
    expect(NOTIFY_STALE_CLAIM_MS).toBe(900_000);
  });
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
    expect(pm.dmInquiry.updateMany).toHaveBeenCalledTimes(1);
    expect(pm.dmInquiry.findUnique).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
      data: { notifyStatus: "failed", notifyLastError: "no_recipients", notifyAttempts: { increment: 1 } },
    });
  });

  it("checkSaleDmAccessFor が DB 例外を投げても、その宛先だけ諦めて他は続行(全員が例外なら no_recipients)", async () => {
    checkAccess.mockRejectedValue(new Error("db down"));
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("failed");
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
  beforeEach(() => {
    // Minor 4: detail をそのままメール件名に埋め込み、宛先(送信先アドレス)と紐付けて検証する
    // (sort() であいまいに比較すると full/minimal が逆転していても気づけない)。
    buildMail.mockImplementation((_facts: unknown, opts: { detail: "minimal" | "full" }) => ({
      subject: `S-${opts.detail}`,
      text: `T-${opts.detail}`,
    }));
  });

  it("設定 full で、電話/メールとも平文の受け手は full・メールが masked の受け手は minimal(宛先ごとに検証)", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    checkAccess.mockImplementation(async (userId: string) =>
      userId === "u-b" ? { ok: true, permissions: [], ownerDisplayConfig: { ...PLAIN_ACCESS.ownerDisplayConfig, email: "masked" } } : PLAIN_ACCESS,
    );
    await notifyInquiry(INQUIRY_ID, { now: nowFn });
    const byAddress = Object.fromEntries(send.mock.calls.map((c) => [c[1].to, c[1].subject]));
    expect(byAddress["u-a@example.com"]).toBe("S-full");
    expect(byAddress["u-b@example.com"]).toBe("S-minimal");
  });

  it("設定 minimal なら電話/メールとも平文でも全員 minimal(宛先ごとに検証)", async () => {
    loadCfg.mockResolvedValue({ ...FULL_CONFIG, inquiryMailDetail: "minimal" });
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    await notifyInquiry(INQUIRY_ID, { now: nowFn });
    const byAddress = Object.fromEntries(send.mock.calls.map((c) => [c[1].to, c[1].subject]));
    expect(byAddress["u-a@example.com"]).toBe("S-minimal");
    expect(byAddress["u-b@example.com"]).toBe("S-minimal");
  });
});

describe("notifyInquiry: 成功", () => {
  it("全員成功 → sent・監査にアドレスを含まない recipientUserIds", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("sent");
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
    expect(pm.dmInquiry.updateMany).toHaveBeenCalledTimes(1); // 最初の claim だけ
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("notifyInquiry: 再試行", () => {
  it(
    "1回目でBだけ失敗→ちょうど30秒後にBだけへ再送→成功でsent(1ms早くては再送しない)",
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

      // Important 3: 待ち時間は NOTIFY_RETRY_DELAYS_MS[0] ちょうど。1ms 早い段階ではまだ再送しない。
      await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[0] - 1);
      expect(send).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;

      expect(result).toBe("sent");
      expect(send).toHaveBeenCalledTimes(3);
      // 2回目はBにだけ送っている(Aは1回のみ)。
      const aCalls = send.mock.calls.filter((c) => c[1].to === "u-a@example.com");
      expect(aCalls).toHaveLength(1);

      // Minor 1: ラウンド間の再送前に notifyClaimedAt を保有チェック付きで更新している。
      const refreshCall = findRefreshCall();
      expect(refreshCall).toBeTruthy();
      expect(refreshCall![0]).toEqual({
        where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
        data: { notifyClaimedAt: NOW },
      });

      expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
        where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
      expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
        where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
      expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
        where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
        data: { notifyStatus: "failed", notifyLastError: "send_failed", notifyAttempts: { increment: 4 } },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "inquiry_notify_failed", detail: { attempt: 4, code: "send_failed" } }),
      );
    },
  );
});

describe("notifyInquiry: 取り合いキーの保有(controller ruling 送信中の奪い合い)", () => {
  // Important 1: 宛先ループの途中で保有キーが期限切れ・他ワーカーに奪われた場合、その場で
  // 送信を止め、未送信の宛先には送らず、終端状態も書かない(二重送信防止の核心)。
  it("宛先ループの途中で保有キーが奪われたら即座に止め、以降の宛先には送らず終端状態も書かない", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b"), user("u-c")]);
    const t0 = NOW;
    const t1 = new Date(NOW.getTime() + NOTIFY_STALE_CLAIM_MS / 3 + 1_000); // 更新間隔の閾値超え
    let calls = 0;
    // now() の呼び出し順: 1=初回claim, 2=宛先A直前(閾値未満), 3=宛先B直前(閾値超え=更新トリガ)
    const seqNow = () => {
      calls += 1;
      return calls <= 2 ? t0 : t1;
    };
    pm.dmInquiry.updateMany
      .mockResolvedValueOnce({ count: 1 }) // 初回claim
      .mockResolvedValueOnce({ count: 0 }); // 宛先ループ途中の更新=奪われた

    const result = await notifyInquiry(INQUIRY_ID, { now: seqNow });

    expect(result).toBe("skipped");
    // Aにだけ送っていて、更新が奪われたと分かった時点でB/Cには送っていない。
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].to).toBe("u-a@example.com");
    // updateMany は claim + 奪われた更新の2回だけ(終端の finish は一切呼ばれていない)。
    expect(pm.dmInquiry.updateMany).toHaveBeenCalledTimes(2);
    expect(pm.dmInquiry.updateMany.mock.calls[1][0]).toEqual({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: t0 },
      data: { notifyClaimedAt: t1 },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  // Important 2: 終端の finish() も同じ保有チェックを通す。書き込み時点で既に保有が他ワーカーへ
  // 移っていたら(stale worker)、監査を書かず・notifyAttempts も増やさずに諦める。
  it("送信完了時に既に保有キーが他ワーカーへ移っていたら(stale worker)監査を書かずskippedで終わる", async () => {
    pm.user.findMany.mockResolvedValue([user("u-a")]);
    pm.dmInquiry.updateMany
      .mockResolvedValueOnce({ count: 1 }) // 初回claim
      .mockResolvedValueOnce({ count: 0 }); // finish(sent) は既に保有を失っている
    const result = await notifyInquiry(INQUIRY_ID, { now: nowFn });
    expect(result).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1); // 送信自体は(保有を失う前に)行われている
    expect(audit).not.toHaveBeenCalled(); // 古いワーカーによる上書き監査は書かない
    expect(pm.dmInquiry.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("notifyInquiry: 想定外の例外で sending のまま残さない(controller ruling 2)", () => {
  it("findUnique が reject しても終端状態(failed/send_failed)を記録してから投げ直す", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyInquiry(INQUIRY_ID, { now: nowFn })).rejects.toThrow("db down");
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
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
    pm.dmInquiry.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      // 最初の claim(data.notifyStatus === "sending")は通す。終端の finish 呼び出し
      // (data.notifyStatus が "sent"/"failed")だけ失敗させる。
      if (args.data.notifyStatus && args.data.notifyStatus !== "sending") {
        throw new Error("update also down");
      }
      return { count: 1 };
    });
    await expect(notifyInquiry(INQUIRY_ID, { now: nowFn })).rejects.toThrow("db down");
  });

  // Minor 2: catch は attempts/succeeded を固定値(1件)に丸めず、実際の進捗を使う。
  it("再試行の途中(attempt 4)で想定外の例外が起きたら、attempt:1に丸めず実際のattempts/partialを記録する", { timeout: 20_000 }, async () => {
    pm.user.findMany.mockResolvedValue([user("u-a"), user("u-b")]);
    let bFail = 0;
    send.mockImplementation(async (_config, mail: { to: string }) => {
      if (mail.to === "u-a@example.com") return { ok: true };
      bFail += 1;
      if (bFail <= 3) return { ok: false, code: "ECONNECTION" };
      throw new Error("unexpected send crash"); // 4回目の試行で想定外の例外
    });

    const promise = notifyInquiry(INQUIRY_ID, { now: nowFn });
    // fake timers を進める間に reject が先に確定し得る。expect().rejects が付ける前に
    // Node の unhandledRejection 検知が走らないよう、早い段階で無害な catch を1つ張っておく。
    const guard = promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[1]);
    await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_DELAYS_MS[2]);
    await guard;

    await expect(promise).rejects.toThrow("unexpected send crash");
    // Aは1回目で成功済み・attempts は実際の4・Aが成功しているので partial(send_failed ではない)。
    expect(pm.dmInquiry.updateMany).toHaveBeenLastCalledWith({
      where: { id: INQUIRY_ID, notifyStatus: "sending", notifyClaimedAt: NOW },
      data: { notifyStatus: "failed", notifyLastError: "partial", notifyAttempts: { increment: 4 } },
    });
  });
});

describe("startInquiryNotify: 例外で落ちない", () => {
  it("内部で何が throw しても外に投げず、console.error は name/code(許可リスト一致)だけ", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(Object.assign(new Error("db down"), { code: "ECONNECTION" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => startInquiryNotify(INQUIRY_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    const call = spy.mock.calls.find((c) => c[0] === "[sale_dm_inquiry_notify] failed");
    expect(call?.[1]).toEqual({ name: "Error", code: "ECONNECTION" });
    spy.mockRestore();
  });

  // Minor 3: 任意の文字列ではなく safeErrorCode() の許可リストを通す。許可リスト外は null にする。
  it("許可リスト外の code は safeErrorCode 経由で null にする(生の文字列をログに出さない)", async () => {
    pm.dmInquiry.findUnique.mockRejectedValue(Object.assign(new Error("db down"), { code: "bad code a@b" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    startInquiryNotify(INQUIRY_ID);
    await vi.advanceTimersByTimeAsync(0);
    const call = spy.mock.calls.find((c) => c[0] === "[sale_dm_inquiry_notify] failed");
    expect(call?.[1]).toEqual({ name: "Error", code: null });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("bad code a@b");
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
