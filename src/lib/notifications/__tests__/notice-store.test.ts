/**
 * ベル(お知らせ)の保存と判断(通知 段階1・設計書 §4.4)。
 */
import { describe, expect, it } from "vitest";
import {
  NOTICE_MAX,
  NOTICE_TTL_MS,
  addNotice,
  markAllNoticesRead,
  parseNotices,
  unreadNoticeCount,
  type Notice,
} from "../notice-store";

const base = (over: Partial<Notice> = {}): Notice => ({
  id: "n1",
  kind: "edit_lock_warn",
  tag: "edit-lock:warn:property:00000000-0000-0000-0000-000000000001",
  message: "編集中の画面が5分後に閉じられます。続ける場合は画面に戻ってください",
  context: "物件の編集",
  url: "/properties/00000000-0000-0000-0000-000000000001",
  at: 1_000_000,
  read: false,
  ...over,
});

describe("parseNotices", () => {
  it("壊れた保存値は空にする", () => {
    expect(parseNotices(null, 0)).toEqual([]);
    expect(parseNotices("{", 0)).toEqual([]);
    expect(parseNotices('{"a":1}', 0)).toEqual([]);
  });

  it("形の違う行・未知の種類・外部 URL の行は捨てる", () => {
    const rows = [
      base(),
      { ...base({ id: "x" }), kind: "unknown" },
      base({ id: "y", url: "https://evil.example/" }),
      base({ id: "z", url: "//evil.example/" }),
      { id: "w" },
    ];
    expect(parseNotices(JSON.stringify(rows), 1_000_000).map((n) => n.id)).toEqual(["n1"]);
  });

  it("7日を過ぎたものは捨て、新しい順に並べる", () => {
    const now = 10 * NOTICE_TTL_MS;
    const rows = [
      base({ id: "old", at: now - NOTICE_TTL_MS }),
      base({ id: "a", at: now - 2000 }),
      base({ id: "b", at: now - 1000 }),
    ];
    expect(parseNotices(JSON.stringify(rows), now).map((n) => n.id)).toEqual(["b", "a"]);
  });
});

describe("addNotice", () => {
  it("同じ tag の古いものを置き換えて先頭に足す", () => {
    const list = [base({ id: "old" }), base({ id: "other", tag: "idle-logout", kind: "idle_logout_warn" })];
    const next = addNotice(list, base({ id: "new", at: 2_000_000 }), 2_000_000);
    expect(next.map((n) => n.id)).toEqual(["new", "other"]);
  });

  it(`最大 ${NOTICE_MAX} 件まで`, () => {
    const list = Array.from({ length: NOTICE_MAX }, (_, i) => base({ id: `n${i}`, tag: `t${i}` }));
    const next = addNotice(list, base({ id: "new", tag: "new" }), 1_000_000);
    expect(next).toHaveLength(NOTICE_MAX);
    expect(next[0].id).toBe("new");
  });
});

describe("既読", () => {
  it("未確認の件数と、すべて確認済みにする", () => {
    const list = [base({ id: "a" }), base({ id: "b", tag: "b", read: true })];
    expect(unreadNoticeCount(list)).toBe(1);
    expect(unreadNoticeCount(markAllNoticesRead(list))).toBe(0);
  });
});

describe("PII を入れない", () => {
  it("保存する形に所有者名・住所などの欄が無い(種類・定型文・時刻・パスのみ)", () => {
    expect(Object.keys(base()).sort()).toEqual(["at", "context", "id", "kind", "message", "read", "tag", "url"]);
  });
});
