import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BuildingSuggestionList, BuildingSuggestionStatus } from "@/components/buildings/building-name-combobox";

const a = { id: "b1", name: "パーク第一", area: "東京都大田区南雪谷1丁目", unitCount: 3, sameName: true, sameArea: true };
const b = { id: "b2", name: "パーク第一", area: "東京都大田区南雪谷2丁目", unitCount: 5, sameName: true, sameArea: false };

describe("BuildingSuggestionList", () => {
  const html = renderToStaticMarkup(
    <BuildingSuggestionList suggestions={[a, b]} activeIndex={-1} onPick={() => {}} listId="x-suggestions" />,
  );
  it("最後の行は常に「新しい棟として登録する」", () => {
    const lastLi = html.lastIndexOf("<li");
    expect(html.slice(lastLi)).toContain("新しい棟として登録する");
    expect(html.indexOf("新しい棟として登録する")).toBeGreaterThan(html.indexOf("南雪谷2丁目"));
  });
  it("丁目が違う候補に印が出る(同じ丁目には出ない)", () => {
    expect(html.match(/丁目が違います/g)?.length).toBe(1);
  });
  it("各行に 44px の高さ", () => {
    expect(html.match(/min-h-\[44px\]/g)?.length).toBe(3);
  });
  it("部屋数が出る", () => {
    expect(html).toContain("3部屋");
    expect(html).toContain("5部屋");
  });
  it("候補がなくても「新しい棟として登録する」だけは出る", () => {
    const empty = renderToStaticMarkup(
      <BuildingSuggestionList suggestions={[]} activeIndex={0} onPick={() => {}} listId="y" />,
    );
    expect(empty).toContain("新しい棟として登録する");
    expect(empty).toContain('aria-selected="true"');
  });
  it("各行に id がある(aria-activedescendant 用)", () => {
    expect(html).toContain('id="x-suggestions-opt-0"');
    expect(html).toContain('id="x-suggestions-opt-1"');
    expect(html).toContain('id="x-suggestions-opt-2"');
  });
});

describe("BuildingSuggestionStatus(読み込み中・失敗の行は選べない・@codex R3)", () => {
  const loading = renderToStaticMarkup(<BuildingSuggestionStatus state="loading" listId="z" />);
  const error = renderToStaticMarkup(<BuildingSuggestionStatus state="error" listId="z" />);
  it("読み込み中は「候補を探しています…」だけ", () => {
    expect(loading).toContain("候補を探しています…");
  });
  it("失敗したら保存時に自動で判断する旨だけ", () => {
    expect(error).toContain("候補を読み込めませんでした。保存するときに自動で判断します");
  });
  it("★どちらも「新しい棟として登録する」を出さず、選べる行(option)を持たない", () => {
    for (const h of [loading, error]) {
      expect(h).not.toContain("新しい棟として登録する");
      expect(h).not.toContain('role="option"');
      expect(h).not.toContain("-opt-");
    }
  });
});

describe("combobox の配線(走査)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../building-name-combobox.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  it("★選べる一覧は ready のときだけ描く", () => {
    expect(src).toMatch(/state === "ready" \? \(\s*<BuildingSuggestionList/);
  });
  it("★上下キー・Enter は ready のときだけ効く", () => {
    expect(src).toMatch(/if \(!canUseListKeys\(state\)\) return;/);
  });
  it("★失敗(応答が ok でない・形が違う・例外)は今の名前+丁目の error として残す", () => {
    expect(src.match(/status: "error"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/catch \{[\s\S]*?fail\(\)/);
  });
});
