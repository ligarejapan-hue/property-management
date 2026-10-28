/**
 * 実機確認(2026-10-28)で見つかった見た目の直し。
 * - 241: 基本情報の未入力は「—」(管理IDなどと同じ)。半角の「-」は使わない
 * - 240: 物件の備考は保存された改行どおりに出す
 * - 247: スマホ幅で添付の「種類:」欄が行からはみ出さない(右のアイコンと重ならない)
 * - 231: スマホ幅で「更新日」の日付欄が画面からはみ出さず、「更新日:」が折れない
 * - 233: 取引を作るボタンの文言は「この物件で取引を作成」にそろえる(発注者指示 2026-10-28)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const detail = read("src/app/(dashboard)/properties/[id]/page.tsx");
const list = read("src/app/(dashboard)/properties/page.tsx");
const attachment = read("src/components/properties/attachment-tab.tsx");

function fieldComponent(): string {
  const start = detail.indexOf("function Field(");
  expect(start).toBeGreaterThan(-1);
  return detail.slice(start, detail.indexOf("\n}\n", start));
}

describe("実機確認 2026-10-28 の直し", () => {
  it("241: 基本情報の未入力は全角のダッシュ「—」", () => {
    const field = fieldComponent();
    expect(field).toContain('value || "—"');
    expect(field).not.toContain('value || "-"');
  });

  it("240: 備考は改行を残して出す", () => {
    expect(detail).toMatch(/<Field label="備考" value=\{property\.note\} multiline \/>/);
    expect(fieldComponent()).toContain("whitespace-pre-wrap");
  });

  it("247: 種類の選択欄は行の幅を超えない", () => {
    const at = attachment.indexOf('aria-label="書類の種類"');
    expect(at).toBeGreaterThan(-1);
    const select = attachment.slice(at, attachment.indexOf(">", attachment.indexOf("className", at)));
    expect(select).toContain("max-w-full");
  });

  it("231: 更新日の欄は折り返し、見出しは1行のまま", () => {
    const at = list.indexOf("更新日:");
    const label = list.slice(list.lastIndexOf("<label", at), at + 40);
    expect(label).toContain("flex-wrap");
    expect(label).toMatch(/<span className="[^"]*whitespace-nowrap[^"]*">更新日:<\/span>/);
  });

  it("233: 取引を作るボタンは「この物件で取引を作成」にそろえる", () => {
    expect(detail).not.toContain("この物件で取引を作る");
    expect(detail).toContain('label: "この物件で取引を作成"');
    for (const doc of ["public/docs/guide.html", "public/docs/manual.html"]) {
      const html = read(doc);
      expect(html).not.toContain("この物件で取引を作る");
      expect(html).toContain("この物件で取引を作成");
    }
  });
});
