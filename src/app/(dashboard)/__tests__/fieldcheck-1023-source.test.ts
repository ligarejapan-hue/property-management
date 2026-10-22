/**
 * 実機確認 2026-10-23(別の Claude のブラウザ確認 7回目+ローカル確認)で分かった小さな直し。
 * 画面は hooks 込みのクライアント部品で SSR できないため、ソース文字列で守る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("権限テンプレート: 作成・削除の失敗はエラーの文を出す(「[object Object]」にしない)", () => {
  const src = read("src/app/(dashboard)/admin/templates/page.tsx");
  it("alert に json.error をそのまま渡していない", () => {
    expect(src).not.toMatch(/alert\(\s*json\.error\b/);
  });
  it("apiErrorMessage で message を取り出して、作成・削除の両方で使う", () => {
    expect(src).toMatch(/import \{ apiErrorMessage \} from "@\/lib\/api-error-message"/);
    expect(src).toMatch(/apiErrorMessage\(json, "作成に失敗しました"\)/);
    expect(src).toMatch(/apiErrorMessage\(json, "削除に失敗しました"\)/);
  });
});

describe("DM送付履歴の画面に「← 物件へ戻る」がある", () => {
  const src = read("src/app/(dashboard)/properties/[id]/dm-logs/page.tsx");
  it("BackLink でその物件の画面へ戻れる", () => {
    expect(src).toMatch(/import \{ BackLink \} from "@\/components\/ui\/back-link"/);
    expect(src).toMatch(/<BackLink href=\{`\/properties\/\$\{id\}`\} to="物件"/);
  });
});
