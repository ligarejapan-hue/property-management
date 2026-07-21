/**
 * B-11 (UI総点検): 取込のファイル名依存の解消 — 配線のソース静的検証。
 *
 * - 4 route (受付帳×所有者 preview/本取込・受付帳→物件 preview/本取込) が
 *   内容ベースの resolveImportFileType を使い、ファイル名だけの拒否をしない
 * - preview と本取込が同じ判定を使う (齟齬防止)
 * - 取込画面がファイル選択時にファイル名で拒否しない
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

const ROUTES = [
  "src/app/api/import/reception-owner/preview/route.ts",
  "src/app/api/import/reception-owner/route.ts",
  "src/app/api/import/reception-property/preview/route.ts",
  "src/app/api/import/reception-property/route.ts",
];

describe("B-11: 取込 route のファイル種別ゲートが内容ベース", () => {
  for (const routePath of ROUTES) {
    describe(routePath, () => {
      const src = read(routePath);

      it("resolveImportFileType (内容判定) を使う", () => {
        expect(src).toContain('from "@/lib/import-content-detect"');
        expect(src).toMatch(/resolveImportFileType\(\s*"(reception|owner)"/);
      });

      it("ファイル名だけの判定 (detectImportFileType) を直接使わない", () => {
        expect(src).not.toMatch(/\bdetectImportFileType\(/);
      });

      it("『ファイル名に◯◯を含めてください』の拒否文言が残っていない", () => {
        expect(src).not.toContain("ファイル名に『受付帳』を含めてください");
        expect(src).not.toContain("ファイル名に『所有者』を含めてください");
      });

      it("判定はパース後 (中身を見てから) に行う", () => {
        const parseIdx = src.indexOf("parseSheet({");
        const resolveIdx = src.indexOf("resolveImportFileType(");
        expect(parseIdx).toBeGreaterThan(-1);
        expect(resolveIdx).toBeGreaterThan(parseIdx);
      });

      it("ヘッダ行なし受付帳では 1 行目をデータへ戻す (@codex #309: 1件目の欠落防止)", () => {
        expect(src).toMatch(/headerRowIsData/);
        expect(src).toMatch(
          /\[receptionParsed\.headers\.map\(\(h\) => h \?\? ""\), \.\.\.receptionPositional\]/,
        );
      });
    });
  }
});

describe("B-11: 取込画面はファイル選択時にファイル名で拒否しない", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");

  it("受付帳×所有者 / 受付帳→物件 のファイル選択ハンドラに即時拒否がない", () => {
    expect(src).not.toContain("受付帳として認識できません: ");
    expect(src).not.toContain("所有者として認識できません: ");
  });

  it("案内文言が「ファイル名に含める」でなく自動判定の説明になっている", () => {
    expect(src).not.toContain("ファイル名に「受付帳」を含める");
    expect(src).not.toContain("ファイル名に「所有者」を含める");
    expect(src).toContain("中身の列構成から自動判定します");
  });

  it("プレビューにサーバー判定のラベルと注意 (warning) を表示する", () => {
    expect(src).toMatch(/roPreview\.receptionFileType\.warning/);
    expect(src).toMatch(/roPreview\.ownerFileType\.warning/);
    expect(src).toMatch(/rpPreview\.receptionFileType\.warning/);
  });
});

describe("B-11(@codex R1): 登記DM取込ウィザードにも判定注意を表示する", () => {
  const src = read("src/app/(dashboard)/import/registry-dm/page.tsx");

  it("プレビューの warning を両フロー (rp/ro) で表示する", () => {
    expect(src).toMatch(/rpPreview\?\.receptionFileType\.warning/);
    expect(src).toMatch(/roPreview\?\.receptionFileType\.warning/);
    expect(src).toMatch(/roPreview\?\.ownerFileType\.warning/);
  });
});
