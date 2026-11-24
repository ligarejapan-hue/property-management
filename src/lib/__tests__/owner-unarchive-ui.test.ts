/**
 * 所有者補正候補「アーカイブ済み」タブ(2026-11-24)。vitest は node 環境なので、
 * 画面はソースの文字列で決まりを固定する(registry-address-apply-confirm-ui.test.ts と同じ形)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/admin/owners/correction/page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

const panel = (() => {
  const start = src.indexOf("function ArchivedOwnersPanel()");
  const end = src.indexOf("\nfunction ", start + 10);
  return src.slice(start, end);
})();

describe("アーカイブ済みタブ", () => {
  it("タブに出る・URL の ?tab=archived で開ける・自前で読む", () => {
    expect(src).toMatch(/\{ key: "archived", label: "アーカイブ済み" \}/);
    expect(src).toMatch(/case "archived":/);
    expect(src).toMatch(/SELF_FETCH_TABS: FilterType\[\] = \[[^\]]*"archived"/);
    expect(src).toContain('{filterType === "archived" && <ArchivedOwnersPanel />}');
  });

  it("「戻す」は確認を開くだけで、API は呼ばない", () => {
    expect(panel).toMatch(/onClick=\{\(\) => setConfirmId\(r\.ownerId\)\}[\s\S]{0,300}>\s*戻す\s*</);
  });

  it("確認の「戻す（実行）」のときだけ unarchiveOwner を呼ぶ", () => {
    expect(panel).toMatch(
      /setConfirmId\(null\);\s*void onUnarchive\(r\);[\s\S]{0,200}戻す（実行）/,
    );
    expect(panel.match(/unarchiveOwner\(/g)).toHaveLength(1);
    expect(panel).toContain("やめる");
  });

  it("統合で隠れた人は、物件が統合先に残ることを伝える", () => {
    expect(panel).toContain("物件・メモは統合先に残ります");
    expect(panel).toContain("物件とのつながりは戻りません");
    expect(panel).toContain("戻した人はもう一度アーカイブできません");
  });

  it("失敗したら一覧を読み直す(古い版の行を残さない)", () => {
    expect(panel).toMatch(/ok: false \}\);\s*\/\/[^\n]*\n\s*setReloadKey\(\(k\) => k \+ 1\);/);
  });
});
