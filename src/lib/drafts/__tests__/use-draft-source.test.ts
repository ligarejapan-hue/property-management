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
  it("鍵が変わったら控えを読み直し、書き手も作り直す(前の鍵へ書き続けない)", () => {
    expect(src).not.toMatch(/const \[writer\] = useState/);
    expect(src).toMatch(/const writer = useMemo\([\s\S]*?\[key, isEmpty, restored, compactForPending\],?\s*\)/);
    expect(src).toMatch(/if \(state\.key !== key\)/);
  });
  it("useClientReady はサーバー描画・hydration 中は false(useSyncExternalStore の第3引数)", () => {
    expect(src).toMatch(
      /export function useClientReady\(\): boolean \{\s*return useSyncExternalStore\(\s*subscribeNothing,\s*\(\) => true,\s*\(\) => false,?\s*\);/,
    );
  });
  it("localStorage・indexedDB を使わない", () => {
    expect(src).not.toMatch(/localStorage|indexedDB/);
  });
});
