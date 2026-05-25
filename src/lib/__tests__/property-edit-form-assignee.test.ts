/**
 * source-assertion: PropertyEditForm が担当者 select を実装している。
 *
 * 既存 project のテスト規約に従い、UI コンポーネントを実行せず
 * ソースの構造を検査する (storage-delete / import-rollback と同方式)。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const formSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/properties/property-edit-form.tsx",
  ),
  "utf8",
);

describe("PropertyEditForm — assignee dropdown", () => {
  it("fetchUsers を @/lib/api-client から import している", () => {
    expect(formSrc).toMatch(
      /import\s*\{[^}]*\bfetchUsers\b[^}]*\}\s*from\s*"@\/lib\/api-client"/,
    );
  });

  it("FORM_FIELDS に assignedTo (担当者, select, 基本) を含む", () => {
    expect(formSrc).toMatch(
      /key:\s*"assignedTo"[^}]*type:\s*"select"[^}]*section:\s*"基本"/,
    );
    expect(formSrc).toMatch(/label:\s*"担当者"/);
  });

  it("users と usersLoading の state を保持する", () => {
    expect(formSrc).toMatch(/useState<AssigneeOption\[\]>/);
    expect(formSrc).toMatch(/usersLoading/);
  });

  it("useEffect 内で fetchUsers() を呼び、catch / finally を持つ", () => {
    expect(formSrc).toMatch(/fetchUsers\(\)/);
    expect(formSrc).toMatch(/\.catch\(/);
    expect(formSrc).toMatch(/\.finally\(/);
  });

  it("「(未設定)」option をレンダリングする (value='')", () => {
    expect(formSrc).toMatch(/<option\s+value=""\s*>\s*\(未設定\)\s*<\/option>/);
  });

  it("usersLoading 中は assignedTo select を disabled にする", () => {
    expect(formSrc).toMatch(
      /disabled=\{[\s\S]{0,80}field\.key\s*===\s*"assignedTo"\s*&&\s*usersLoading[\s\S]{0,40}\}/,
    );
  });

  it("空文字 → null 変換は既存の汎用ロジック (raw || null) を維持する", () => {
    expect(formSrc).toMatch(/payload\[f\.key\]\s*=\s*raw\s*\|\|\s*null/);
  });

  it("assignedTo の option は users state から動的に組む (特例ブランチ)", () => {
    expect(formSrc).toMatch(
      /field\.key\s*===\s*"assignedTo"\s*\?\s*\([\s\S]*?users\.map\(/,
    );
  });

  it("PropertyData の assignedTo 型は string | null を維持する", () => {
    expect(formSrc).toMatch(/assignedTo:\s*string\s*\|\s*null/);
  });
});
