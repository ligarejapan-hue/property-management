/**
 * DisplayNameAuditPage の PII 画面保護 source-assertion テスト（Codex P1）。
 *
 * vitest は environment: "node" のため RTL/jsdom は使用しない。
 * fs.readFileSync でソースを読み込み、意図する実装の存在を静的に確認する。
 *
 * 背景（Codex P1）:
 *  - owner タブは full/read/edit 表示レベルで生の所有者名(PII)と正規化キーを表示する。
 *  - 既存 ScreenProtectionGuard は [data-pii-protected] 領域内でのみ copy/cut/contextmenu/print を
 *    抑止し client 監査する。owner の表示領域が無印だとこの抑止・監査を素通りする。
 *  - 是正: owner タブが active のときだけ結果領域を data-pii-protected /
 *    data-pii-surface="owner" で包む。building は非PIIゆえ無印のまま。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/display-name-audit/page.tsx",
  ),
  "utf8",
);

describe("display-name-audit/page.tsx — owner PII 画面保護 (Codex P1)", () => {
  it("data-pii-protected と data-pii-surface=owner を使う", () => {
    expect(pageSrc).toMatch(/data-pii-protected/);
    expect(pageSrc).toMatch(/data-pii-surface/);
  });

  it("owner surface は building に拡げず owner タブのときだけ付与する（条件式）", () => {
    // 非PII の building タブでは owner surface を付けない。
    // tab === "owner" を条件にした surface 付与であることを確認する。
    expect(pageSrc).toMatch(/tab\s*===\s*["']owner["']/);
    // data-pii-surface は静的な "owner" 固定ではなく、tab に応じた式で与える。
    expect(pageSrc).not.toMatch(/data-pii-surface="owner"/);
  });

  it("building 専用の owner surface 文字列をハードコードしていない", () => {
    // building 領域だけを owner として保護する誤りを防ぐ（ガード）。
    expect(pageSrc).not.toMatch(/data-pii-surface=\{["']building["']/);
  });
});
