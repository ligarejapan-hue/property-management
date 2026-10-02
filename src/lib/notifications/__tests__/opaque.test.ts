import { describe, it, expect } from "vitest";
import {
  BOUNDARY_UUID,
  decodeEventCursor,
  deriveNotificationKeys,
  encodeEventCursor,
  seenKey,
} from "../opaque";

const KEYS = deriveNotificationKeys("test-secret-for-notifications");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

describe("鍵の導出(NEXTAUTH_SECRET から HKDF で用途別)", () => {
  it("同じ secret なら同じ・違えば違う・見た記録用とカーソル用は別の鍵", () => {
    const a = deriveNotificationKeys("s1");
    const b = deriveNotificationKeys("s1");
    const c = deriveNotificationKeys("s2");
    expect(a.seen.equals(b.seen)).toBe(true);
    expect(a.seen.equals(c.seen)).toBe(false);
    expect(a.seen.equals(a.cursor)).toBe(false);
    expect(a.seen.length).toBe(32);
    expect(a.cursor.length).toBe(32);
  });
  it("secret が無ければ throw(env を退避して確かめる)", () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      expect(() => deriveNotificationKeys()).toThrow();
      expect(() => deriveNotificationKeys("  ")).toThrow();
    } finally {
      if (saved !== undefined) process.env.NEXTAUTH_SECRET = saved;
    }
  });
});

describe("見た記録用の不透明な値", () => {
  it("同じ入力なら同じ値・22文字の base64url", () => {
    const a = seenKey(KEYS, U1, "inquiry", [ID]);
    expect(a).toBe(seenKey(KEYS, U1, "inquiry", [ID]));
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it("利用者・種類・中身のどれかが違えば別の値(人が違えば同じ件でも別)", () => {
    const base = seenKey(KEYS, U1, "inquiry", [ID]);
    expect(seenKey(KEYS, U2, "inquiry", [ID])).not.toBe(base);
    expect(seenKey(KEYS, U1, "registry_job", [ID])).not.toBe(base);
    expect(seenKey(KEYS, U1, "next_action", [ID, "1", "r", "0"])).not.toBe(seenKey(KEYS, U1, "next_action", [ID, "1", "r", "1"]));
  });
  it("値に生の ID が含まれない", () => {
    expect(seenKey(KEYS, U1, "inquiry", [ID])).not.toContain("3333");
  });
});

describe("カーソル(暗号化・改ざん防止)", () => {
  const c = { t: new Date("2026-10-02T01:02:03.456Z"), i: ID };
  it("往復できる(ミリ秒まで)", () => {
    const raw = encodeEventCursor(KEYS, U1, "inquiry", c);
    const back = decodeEventCursor(KEYS, U1, "inquiry", raw);
    expect(back?.t.toISOString()).toBe("2026-10-02T01:02:03.456Z");
    expect(back?.i).toBe(ID);
  });
  it("中身(時刻・ID)が画面から読めない", () => {
    const raw = encodeEventCursor(KEYS, U1, "inquiry", c);
    const plain = Buffer.from(raw, "base64url").toString("latin1");
    expect(plain).not.toContain("2026");
    expect(plain).not.toContain("3333");
  });
  it("別の利用者・別の種類のカーソルは読めない", () => {
    const raw = encodeEventCursor(KEYS, U1, "inquiry", c);
    expect(decodeEventCursor(KEYS, U2, "inquiry", raw)).toBeNull();
    expect(decodeEventCursor(KEYS, U1, "registry_job", raw)).toBeNull();
  });
  it("1文字でも変えると読めない・壊れた値・長すぎる値も読めない", () => {
    const raw = encodeEventCursor(KEYS, U1, "inquiry", c);
    const flipped = raw.slice(0, 10) + (raw[10] === "A" ? "B" : "A") + raw.slice(11);
    expect(decodeEventCursor(KEYS, U1, "inquiry", flipped)).toBeNull();
    expect(decodeEventCursor(KEYS, U1, "inquiry", "not-a-cursor")).toBeNull();
    expect(decodeEventCursor(KEYS, U1, "inquiry", "")).toBeNull();
    expect(decodeEventCursor(KEYS, U1, "inquiry", "A".repeat(600))).toBeNull();
  });
  it("同じ中身でも毎回違う暗号文(乱数の初期値)", () => {
    expect(encodeEventCursor(KEYS, U1, "inquiry", c)).not.toBe(encodeEventCursor(KEYS, U1, "inquiry", c));
  });
  it("境界値 UUID の初期カーソルも往復できる", () => {
    const raw = encodeEventCursor(KEYS, U1, "registry_job", { t: c.t, i: BOUNDARY_UUID });
    expect(decodeEventCursor(KEYS, U1, "registry_job", raw)?.i).toBe(BOUNDARY_UUID);
  });
});
