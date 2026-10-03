/**
 * 通知 段階4b の決まりごと(rules.ts)。純関数と時間の関係を固定する。
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: {} }));
import {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  SEND_TIMEOUT_MS,
  SEND_TX_TIMEOUT_MS,
  classifySendError,
  editLockLossRefKey,
  editLockLostPayload,
  parseEditLockLossRefKey,
  eventRefKey,
  inquiryPayload,
  nextActionPayload,
  nextActionRefKey,
  parseEventRefKey,
  parseNextActionRefKey,
  registryJobPayload,
} from "../deliveries/rules";
import { UPSERT_TX_TIMEOUT_MS } from "../subscriptions";
import { nextActionKeysFor } from "../deliveries/plan";

const ID = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("時間の関係(設計書 §7.5)", () => {
  it("送信のトランザクションの時間制限は送信の時間制限より長い(送れたのに sent が巻き戻らない)", () => {
    expect(SEND_TX_TIMEOUT_MS).toBeGreaterThan(SEND_TIMEOUT_MS);
  });
  it("付け替えは送信のトランザクションが終わるのを待てる", () => {
    expect(UPSERT_TX_TIMEOUT_MS).toBeGreaterThan(SEND_TX_TIMEOUT_MS);
  });
  it("取り直しは15分・送り直しは最大3回", () => {
    expect(CLAIM_STALE_MS).toBe(15 * 60 * 1000);
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe("ref_key", () => {
  it("次回対応は ID・期限(秒)・版(ミリ秒)・回だけで、読み戻せる", () => {
    const t = Date.parse("2026-10-03T00:00:00.123Z");
    const k = nextActionRefKey(ID, t, t + 5, 4);
    expect(k).toBe(`next_action:${ID}:${Math.floor(t / 1000)}:${t + 5}:4`);
    expect(parseNextActionRefKey(k)).toEqual({ id: ID, deadlineSec: Math.floor(t / 1000), revMs: t + 5, slot: 4 });
    expect(parseNextActionRefKey("next_action:x:1:2:3")).toBeNull();
  });
  it("申込・ジョブは種類と ID だけ", () => {
    expect(eventRefKey("inquiry", ID)).toBe(`inquiry:${ID}`);
    expect(parseEventRefKey("inquiry", `inquiry:${ID}`)).toBe(ID);
    expect(parseEventRefKey("inquiry", `registry_job:${ID}`)).toBeNull();
  });
  it("端末が結び付く前の回は含めない(§7.3)", () => {
    const bound = new Date("2026-10-03T01:00:00Z");
    const due = [
      { id: ID, deadline: 0, revMs: 1, slot: 0, slotTime: bound.getTime() - 1 },
      { id: B, deadline: 0, revMs: 1, slot: 1, slotTime: bound.getTime() },
    ];
    expect(nextActionKeysFor(due, bound)).toEqual([nextActionRefKey(B, 0, 1, 1)]);
  });
});

describe("本文(種類と件数・時刻だけ)", () => {
  it("次回対応は時刻の回と件数・結び付けを載せる", () => {
    const p = nextActionPayload(B, [{ dueTime: "15:00" }, {}], 3, 1);
    expect(p).toEqual({
      b: B,
      title: "次回対応",
      body: "15:00 の次回対応が1件あります。今日の次回対応が3件、期限切れが1件あります",
      url: "/home",
      tag: "next-action:reminder",
    });
  });
  it("申込は件数だけ・謄本は要確認を必ず出す", () => {
    expect(inquiryPayload(B, 2).body).toBe("新しい査定の申込が2件あります");
    const r = registryJobPayload(B, ID, "opaque-key", { done: 12, failed: 0, skipped: 2, chargedButFailed: 1 });
    expect(r.tag).toBe("registry-job:opaque-key");
    expect(r.body).toBe("謄本の一括取得が完了しました（成功12件・要手動2件・要確認1件）");
    expect(r.url).toBe(`/properties/registry-fetch/${ID}`);
  });
});

describe("編集権限が外れた(N2・段階4c)", () => {
  it("物件は物件の画面へ・tag は画面からの知らせと同じ・理由ごとの文言", () => {
    const p = editLockLostPayload(B, { resourceType: "property", resourceId: ID, cause: "heartbeat" });
    expect(p).toEqual({
      b: B,
      title: "編集権限が外れました",
      body: "しばらく操作がなかった、または画面が止まっていたため、編集権限が外れました",
      url: `/properties/${ID}`,
      tag: `edit-lock:lost:property:${ID}`,
    });
    expect(editLockLostPayload(B, { resourceType: "property", resourceId: ID, cause: "force_released" }).body).toBe(
      "管理者が編集を終了したため、編集権限が外れました",
    );
  });
  it("所有者はどの物件の画面かサーバーで決めないのでホームへ", () => {
    expect(editLockLostPayload(B, { resourceType: "owner", resourceId: ID, cause: "idle" }).url).toBe("/home");
  });
  it("ref_key は記録の ID だけ", () => {
    expect(editLockLossRefKey(ID)).toBe(`edit_lock_loss:${ID}`);
    expect(parseEditLockLossRefKey(`edit_lock_loss:${ID}`)).toBe(ID);
    expect(parseEditLockLossRefKey(`inquiry:${ID}`)).toBeNull();
  });
});

describe("送信結果の分け方(定型コードだけ)", () => {
  it("404/410 は宛先が無効(gone)", () => {
    expect(classifySendError({ statusCode: 410, body: "secret", endpoint: "https://x" })).toEqual({ gone: true, code: "http_410" });
    expect(classifySendError({ statusCode: 404 })).toEqual({ gone: true, code: "http_404" });
  });
  it("それ以外の HTTP・時間切れ・通信の失敗は送り直し(本文・URL は残さない)", () => {
    expect(classifySendError({ statusCode: 429 })).toEqual({ gone: false, code: "http_429" });
    expect(classifySendError(new Error("Socket timeout"))).toEqual({ gone: false, code: "timeout" });
    expect(classifySendError(new Error("push_timeout"))).toEqual({ gone: false, code: "timeout" });
    expect(classifySendError(new Error("getaddrinfo ENOTFOUND https://fcm.googleapis.com/x"))).toEqual({ gone: false, code: "network" });
  });
});
