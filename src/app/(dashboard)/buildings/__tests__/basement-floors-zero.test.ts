import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// [@codex P2] 地下階は 0 が正しい値（API の zod は min(0)、図面からの書き戻しも 0 を通す）。
// 表示を真偽値で分岐すると「地下なし(0)」が「未入力」と同じ空欄になり、両者を区別できない。
//
// 棟の詳細画面は "use client" + useEffect の取得で組み立てるため、renderToStaticMarkup では
// 取得前の状態しか描けず、この行まで到達できない（env=node・jsdom 非導入）。そこで表示式
// そのものを走査して固定する。0 を受け付ける側（API）は
// src/app/api/buildings/[id]/__tests__/route-sales-fields.test.ts が担保する。
const dir = dirname(fileURLToPath(import.meta.url));
// 走査型テストは改行を LF に正規化する（手元 CRLF と CI で判定が変わらないように）。
const detailSrc = readFileSync(join(dir, "..", "[id]", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("棟の詳細 — 地下階の 0 を消さない(@codex P2)", () => {
  it("地下階の表示は null/undefined だけを未入力として扱う", () => {
    expect(detailSrc).toContain("building.basementFloors == null ? null : `${building.basementFloors}階`");
  });

  it("地下階の表示に真偽値判定（0 が空欄になる書き方）を残さない", () => {
    expect(detailSrc).not.toMatch(/building\.basementFloors\s*\?\s*`/);
  });

  it("編集フォームへ渡す初期値も 0 を落とさない", () => {
    // "0" は文字列として truthy のため Number("0")=0 が通るが、?? での分岐であることを固定する。
    expect(detailSrc).toContain('basementFloors: building.basementFloors?.toString() ?? ""');
  });
});

// [@codex P2] 築月だけ保存されている棟でも表示する(築年の有無で判定すると消える)。
describe("棟の詳細 — 築月だけの値を消さない(@codex P2)", () => {
  it("築年の有無で分岐せず、共通の表示関数に任せている", () => {
    expect(detailSrc).toContain(
      "formatBuiltYearMonth(building.builtYear, building.builtMonth) || null",
    );
  });

  it("築年が無いと月ごと消える書き方を残さない", () => {
    expect(detailSrc).not.toMatch(/building\.builtYear\s*\?\s*`/);
  });
});
