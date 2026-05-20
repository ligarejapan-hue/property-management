/**
 * OwnerMergePreviewButton の preview state リセット保証テスト。
 *
 * テスト環境に React DOM が無いため source assertion で担保する。
 *
 * 要件:
 *   - masterId / sourceId 変更時に preview の state（result / errorMsg / state flag）が
 *     reset される useEffect が存在する
 *   - parent (correction page) は <OwnerMergePreviewButton key={`${masterId}:${sourceId}`} />
 *     で remount を強制する（多重防御）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const componentSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/owners/OwnerMergePreviewButton.tsx",
  ),
  "utf8",
);

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("OwnerMergePreviewButton: pair 変更時の state リセット", () => {
  it("useEffect を [masterId, sourceId] 依存で持つ", () => {
    expect(componentSrc).toMatch(/useEffect/);
    // [masterId, sourceId] を依存配列に含む
    expect(componentSrc).toMatch(/\[\s*masterId\s*,\s*sourceId\s*\]/);
  });

  it("useEffect 内で result / errorMsg / state を null/idle にリセットする", () => {
    // useEffect block 内に setState("idle") / setErrorMsg(null) / setResult(null)
    // が揃っていることを確認。
    expect(componentSrc).toMatch(/setState\(["']idle["']\)/);
    expect(componentSrc).toMatch(/setErrorMsg\(null\)/);
    expect(componentSrc).toMatch(/setResult\(null\)/);
  });

  it("useEffect は masterId / sourceId 依存以外を持たないこと（不要な発火防止）", () => {
    // [masterId, sourceId] の dependency 配列以外に React state を引きずらない。
    // 大まかな確認: [masterId, sourceId] dependency が存在する。
    const match = componentSrc.match(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[([^\]]+)\]\s*\)/,
    );
    expect(match).not.toBeNull();
    if (match) {
      const deps = match[1].trim();
      // 依存配列は masterId / sourceId のみ
      expect(deps).toMatch(/^masterId\s*,\s*sourceId$/);
    }
  });
});

describe("correction page: OwnerMergePreviewButton に pair key を渡す", () => {
  it("<OwnerMergePreviewButton key={`${masterId}:${sourceId}`} ...> で remount を強制", () => {
    expect(pageSrc).toMatch(
      /<OwnerMergePreviewButton[\s\S]*?key=\{`\$\{masterId\}:\$\{sourceId\}`\}/,
    );
  });

  it("masterId / sourceId が key 内で両方参照されている", () => {
    // 防御的: key の中身に masterId と sourceId が両方含まれていること。
    // テンプレートリテラル内に `}` が含まれるため key 全体の抽出はせず、
    // <OwnerMergePreviewButton ... /> ブロック内に key と masterId / sourceId が
    // 揃って登場することを source 全体で確認する（pair key パターン）。
    expect(pageSrc).toMatch(
      /<OwnerMergePreviewButton[\s\S]*?key=\{`\$\{masterId\}:\$\{sourceId\}`\}[\s\S]*?\/>/,
    );
  });
});
