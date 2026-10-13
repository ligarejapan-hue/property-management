import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

// 鍵は読み込んだモジュールの中に残るので、試すたびに読み込み直す。
let s: MemoryStorage;
beforeEach(() => {
  vi.resetModules();
  s = installMemoryStorage();
});
afterEach(() => uninstallStorage());

describe("ログアウト時の全消しの後は書かない", () => {
  it("lockUntilReload で全消しした後の writeDraft は書かずに failed", async () => {
    const m = await import("../draft-store");
    const k = m.draftKey("new-property:properties");
    m.writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    m.clearAllDrafts({ lockUntilReload: true });
    // ログアウトの移動で小窓が閉じる瞬間の書き込み(unmount・pagehide)を想定。
    expect(m.writeDraft(k, { v: 1, savedAt: 2, data: { name: "A" } })).toBe("failed");
    expect(s.getItem(k)).toBeNull();
  });
  it("ふつうの全消し(ログイン成功時)の後はまた書ける", async () => {
    const m = await import("../draft-store");
    const k = m.draftKey("new-property:properties");
    m.clearAllDrafts();
    expect(m.writeDraft(k, { v: 1, savedAt: 2, data: { name: "A" } })).toBe("ok");
  });
});
