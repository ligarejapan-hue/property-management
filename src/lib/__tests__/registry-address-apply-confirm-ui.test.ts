// 所有者補正候補「住所の登記文字列」の「適用」に確認を挟む(2026-11-24 発注者「次へ」)。
// 経緯: この画面の「適用」だけ、押した瞬間に住所が変わっていた(ほかの直しの画面はどれも確認がある)。
// vitest は node 環境でクリックを試せないので、ソースの並びで「適用 → 確認 → 実行する」を守る。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/admin/owners/correction/page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

const panel = (() => {
  const start = SRC.indexOf("function RegistryAddressCandidatesPanel()");
  const next = SRC.indexOf("\nfunction ", start + 10);
  return SRC.slice(start, next === -1 ? undefined : next);
})();

describe("住所の登記文字列の「適用」は確認してから", () => {
  it("パネルを切り出せている(空振りしない)", () => {
    expect(panel).toContain("onApply");
    expect(panel.length).toBeGreaterThan(1000);
  });

  it("「適用」は確認を開くだけで、直接 onApply を呼ばない", () => {
    expect(panel).not.toMatch(/onClick=\{\(\) => onApply\(c\)\}/);
    expect(panel).toMatch(/onClick=\{\(\) => setConfirmId\(c\.ownerId\)\}/);
  });

  it("確認の文言と「実行する」「やめる」がある", () => {
    expect(panel).toContain("住所から登記の文字を消します。よろしいですか？");
    expect(panel).toMatch(/onClick=\{\(\) => \{\s*setConfirmId\(null\);\s*void onApply\(c\);\s*\}\}/);
    expect(panel).toContain("実行する");
    expect(panel).toContain("やめる");
  });

  it("確認は1行ずつ(押した行だけに出る)", () => {
    expect(panel).toMatch(/confirmId === c\.ownerId/);
  });
});
