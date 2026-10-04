import { describe, it, expect } from "vitest";
import { PERSONAL_TTL_MS, SHARED_TTL_MS, decideBinding, type ExistingSubscription } from "../binding";

const NOW = new Date("2026-10-03T03:00:00Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW = "99999999-9999-4999-8999-999999999999";
const OLD = "11111111-1111-4111-8111-111111111111";
const existing = (over: Partial<ExistingSubscription> = {}): ExistingSubscription => ({
  userId: A,
  deviceScope: "shared",
  bindingId: OLD,
  boundAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
  revokedAt: null,
  revokedReason: null,
  ...over,
});

describe("端末の結び付け(設計書 §7.5 の 2)", () => {
  it("初めての登録は shared・65分(本人が選べば personal・30日)", () => {
    expect(decideBinding({ existing: null, userId: A, now: NOW, newBindingId: NEW })).toEqual({
      kind: "create", bindingId: NEW, boundAt: NOW, deviceScope: "shared", expiresAt: new Date(NOW.getTime() + SHARED_TTL_MS), cancelPrevious: false,
    });
    expect(decideBinding({ existing: null, userId: A, requestedScope: "personal", now: NOW, newBindingId: NEW })).toMatchObject({
      deviceScope: "personal", expiresAt: new Date(NOW.getTime() + PERSONAL_TTL_MS),
    });
  });
  it("同じ利用者で有効なら結び付けは変えず、期限だけ延ばす", () => {
    const d = decideBinding({ existing: existing(), userId: A, now: NOW, newBindingId: NEW });
    expect(d).toMatchObject({ kind: "keep", bindingId: OLD, boundAt: new Date("2026-10-01T00:00:00Z"), cancelPrevious: false });
    const p = decideBinding({ existing: existing({ deviceScope: "personal" }), userId: A, now: NOW, newBindingId: NEW });
    expect(p).toMatchObject({ kind: "keep", deviceScope: "personal", expiresAt: new Date(NOW.getTime() + PERSONAL_TTL_MS) });
  });
  it("別の利用者への付け替えは新しい結び付け・shared に戻す(前の人の personal を引き継がない)・前の送り待ちを取り消す", () => {
    const d = decideBinding({ existing: existing({ deviceScope: "personal" }), userId: B, now: NOW, newBindingId: NEW });
    expect(d).toEqual({ kind: "rebind", bindingId: NEW, boundAt: NOW, deviceScope: "shared", expiresAt: new Date(NOW.getTime() + SHARED_TTL_MS), cancelPrevious: true });
  });
  it("別の利用者でも、本人がこの操作で personal を選べば personal", () => {
    expect(decideBinding({ existing: existing(), userId: B, requestedScope: "personal", now: NOW, newBindingId: NEW })).toMatchObject({ kind: "rebind", deviceScope: "personal" });
  });
  it("同じ利用者でも期限切れ・無効化(ログアウト)からは新しい結び付け", () => {
    for (const e of [existing({ expiresAt: NOW }), existing({ revokedAt: new Date("2026-10-02T00:00:00Z"), revokedReason: "logout" })]) {
      expect(decideBinding({ existing: e, userId: A, now: NOW, newBindingId: NEW })).toMatchObject({ kind: "rebind", bindingId: NEW, boundAt: NOW, cancelPrevious: true });
    }
  });
  it("中継サービスが無効と返した登録(gone)は有効に戻さない", () => {
    expect(decideBinding({ existing: existing({ revokedAt: NOW, revokedReason: "gone" }), userId: A, now: NOW, newBindingId: NEW })).toEqual({ kind: "gone" });
  });
});
