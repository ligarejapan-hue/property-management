import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/use-draft.ts"), "utf8").replace(/\r\n/g, "\n");

describe("use-draft の配線", () => {
  it("離れるとき(unmount)と pagehide で flush する", () => {
    expect(src).toMatch(/addEventListener\("pagehide"/);
    expect(src).toMatch(/return \(\) => \{[\s\S]*?removeEventListener\("pagehide"[\s\S]*?writer\.flush\(\)/);
  });
  it("useDraftExists はサーバー描画では false(useSyncExternalStore の第3引数)", () => {
    expect(src).toMatch(/useSyncExternalStore\(\s*subscribeDrafts,[\s\S]*?,\s*\(\) => false,?\s*\)/);
  });
  it("localStorage・indexedDB を使わない", () => {
    expect(src).not.toMatch(/localStorage|indexedDB/);
  });
});
