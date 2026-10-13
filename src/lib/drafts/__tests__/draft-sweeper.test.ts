import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

// 掃除の繰り返しは読み込んだモジュールの中に1つだけ持つので、試すたびに読み込み直す。
let s: MemoryStorage;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  s = installMemoryStorage();
});
afterEach(() => {
  vi.useRealTimers();
  uninstallStorage();
});

describe("12時間を過ぎた控えを、何も操作しなくても消す(@codex P2)", () => {
  it("startDraftExpirySweeper は1分ごとに期限切れを消す・何度呼んでも1つだけ", async () => {
    const m = await import("../draft-store");
    const k = m.draftKey("new-property:properties");
    m.writeDraft(k, { v: 1, savedAt: 0, data: { name: "A" } });
    m.startDraftExpirySweeper();
    m.startDraftExpirySweeper();
    vi.setSystemTime(m.DRAFT_MAX_AGE_MS + 1);
    expect(s.getItem(k)).not.toBeNull();
    vi.advanceTimersByTime(m.DRAFT_SWEEP_INTERVAL_MS);
    expect(s.getItem(k)).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });
  it("画面(ブラウザ)で読み込まれたら自動で始める", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/lib/drafts/draft-store.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toMatch(/if \(typeof window !== "undefined"\) startDraftExpirySweeper\(\);/);
  });
});
