import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_CHARS,
  clearAllDrafts,
  clearDraft,
  draftKey,
  hasDraft,
  readDraft,
  subscribeDrafts,
  writeDraft,
} from "../draft-store";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

const parseName = (d: unknown) =>
  d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string"
    ? (d as { name: string })
    : null;

let s: MemoryStorage;
beforeEach(() => {
  s = installMemoryStorage();
});
afterEach(() => uninstallStorage());

describe("draftKey", () => {
  it("画面名だけ/物件IDつき", () => {
    expect(draftKey("new-property:properties")).toBe("pm-draft:v1:new-property:properties");
    expect(draftKey("property-edit", "abc")).toBe("pm-draft:v1:property-edit:abc");
  });
});

describe("writeDraft / readDraft", () => {
  it("往復で同じ中身が返る", () => {
    const k = draftKey("property-edit", "p1");
    expect(writeDraft(k, { v: 1, savedAt: 1000, data: { name: "A" } })).toBe("ok");
    expect(readDraft(k, parseName, 2000)).toEqual({ v: 1, savedAt: 1000, data: { name: "A" } });
  });
  it("送信中の印も往復する", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 1000, data: { name: "A" }, pendingSubmit: { at: 1500 } });
    expect(readDraft(k, parseName, 2000)?.pendingSubmit).toEqual({ at: 1500 });
  });
  it("12時間を過ぎた控えは無かったことにして消す", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 0, data: { name: "A" } });
    expect(readDraft(k, parseName, DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(s.getItem(k)).toBeNull();
  });
  it("12時間ちょうどまでは読める", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 0, data: { name: "A" } });
    expect(readDraft(k, parseName, DRAFT_MAX_AGE_MS)).not.toBeNull();
  });
  it("壊れたJSON・封筒の形違い・中身の形違いは消す", () => {
    const k = draftKey("property-edit", "p1");
    for (const raw of ["{", "null", '{"v":2,"savedAt":1,"data":{"name":"A"}}', '{"v":1,"savedAt":"x","data":{}}', '{"v":1,"savedAt":1,"data":{"name":3}}']) {
      s.setItem(k, raw);
      expect(readDraft(k, parseName, 2)).toBeNull();
      expect(s.getItem(k)).toBeNull();
    }
  });
  it("上限を超える控えは書かずに too_large", () => {
    const k = draftKey("csv-import");
    const big = "x".repeat(DRAFT_MAX_CHARS);
    expect(writeDraft(k, { v: 1, savedAt: 1, data: { name: big } })).toBe("too_large");
    expect(s.getItem(k)).toBeNull();
  });
  it("storage が投げても例外にしない(failed)", () => {
    s.throwOnSet = new Error("QuotaExceededError");
    expect(writeDraft(draftKey("paste"), { v: 1, savedAt: 1, data: { name: "A" } })).toBe("failed");
  });
  it("sessionStorage が無い環境でも例外にしない", () => {
    uninstallStorage();
    const k = draftKey("paste");
    expect(writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } })).toBe("failed");
    expect(readDraft(k, parseName, 2)).toBeNull();
    expect(hasDraft(k, 2)).toBe(false);
    expect(() => clearDraft(k)).not.toThrow();
    expect(() => clearAllDrafts()).not.toThrow();
  });
});

describe("hasDraft", () => {
  it("封筒が正しく期限内なら true・期限切れや壊れは false", () => {
    const k = draftKey("new-property:properties");
    expect(hasDraft(k, 5)).toBe(false);
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    expect(hasDraft(k, 5)).toBe(true);
    expect(hasDraft(k, DRAFT_MAX_AGE_MS + 2)).toBe(false);
    s.setItem(k, "{");
    expect(hasDraft(k, 5)).toBe(false);
  });
});

describe("clearAllDrafts", () => {
  it("pm-draft: で始まる鍵だけを消す", () => {
    s.setItem("edit-screen-token", "t");
    writeDraft(draftKey("paste"), { v: 1, savedAt: 1, data: { name: "A" } });
    writeDraft(draftKey("property-edit", "p1"), { v: 1, savedAt: 1, data: { name: "B" } });
    clearAllDrafts();
    expect(s.length).toBe(1);
    expect(s.getItem("edit-screen-token")).toBe("t");
  });
});

describe("subscribeDrafts", () => {
  it("書く・消す・全消しで知らせる。解除後は知らせない", () => {
    const fn = vi.fn();
    const off = subscribeDrafts(fn);
    const k = draftKey("paste");
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    clearDraft(k);
    clearAllDrafts();
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
