/**
 * B-8 案A (2026-08-23 発注者判断で採用): 文字・表の重なりを**ボタンで**自動解消する。
 *
 * 経緯: 案B(警告のみ)は反映済み。案A(自動で動かす)は「手動配置の尊重」と相反する
 * ため見送られていたが、**利用者がボタンを押したときだけ**動かす形で両立させる
 * (勝手には一切動かさない・履歴に乗る=Ctrl+Zで戻せる)。
 *
 * 方針(発注者選択):
 *   1. まず**文字サイズの縮小**で解消を試みる(下限=元の6割か7ptの大きい方。
 *      読めなくなる縮小はしない)
 *   2. 縮小で駄目なら**最小距離の移動**(ページ内・新たな重なりを作らない位置のみ)
 *   3. どうにもならない箇所は**触らずに**警告へ残す
 *   - 調整するのは**文字(text)だけ**。表は動かさない。表×表の重なりは自動対象外。
 */
import { describe, it, expect } from "vitest";
import {
  findTextTableOverlaps,
  resolveTextTableOverlapsInDocument,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  A4_LANDSCAPE,
  type SalesSheetDocument,
} from "../document-schema";

function makeDoc(elements: unknown[]): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
}

const text = (
  id: string,
  x: number,
  y: number,
  w = 40,
  h = 10,
  style: Record<string, unknown> = {},
) => ({ id, type: "text", x, y, w, h, z: 5, content: "テキスト", style });
const table = (id: string, x: number, y: number, w = 80, h = 60) => ({
  id, type: "table", x, y, w, h, z: 1,
  rows: [{ label: "物件種別", value: "売地" }], style: {},
});

describe("resolveTextTableOverlapsInDocument", () => {
  it("重なりが無ければ何もしない(同一参照=no-op)", () => {
    const doc = makeDoc([text("t1", 10, 10), table("tb", 120, 100)]);
    const r = resolveTextTableOverlapsInDocument(doc);
    expect(r.document).toBe(doc);
    expect(r.shrunk).toEqual([]);
    expect(r.moved).toEqual([]);
    expect(r.unresolved).toBe(0);
  });

  it("わずかな食い込みは縮小で解消する(位置は変えない)", () => {
    // 文字域は約 17×5mm(4文字・12pt)。表を文字域の右端に少しだけ重ねる。
    const doc = makeDoc([text("price", 100, 40), table("tb", 114, 30)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    const r = resolveTextTableOverlapsInDocument(doc);
    expect(findTextTableOverlaps(r.document)).toHaveLength(0);
    expect(r.shrunk).toEqual(["price"]);
    expect(r.moved).toEqual([]);
    expect(r.unresolved).toBe(0);
    const fixed = r.document.elements.find((e) => e.id === "price");
    expect(fixed?.type).toBe("text");
    if (fixed?.type === "text") {
      // 位置は不変・サイズだけ下がる(既定12ptから)。
      expect(fixed.x).toBe(100);
      expect(fixed.y).toBe(40);
      expect(fixed.style.fontSizePt).toBeLessThan(12);
      // ⚠下限=元の6割(7.2pt)を割らない。
      expect(fixed.style.fontSizePt).toBeGreaterThanOrEqual(7.2);
    }
  });

  it("縮小で駄目なら移動で解消する(最小距離・ページ内)", () => {
    // 文字を表のど真ん中に置く=どれだけ縮めても重なりが残る。
    const doc = makeDoc([text("t1", 120, 60), table("tb", 100, 30, 80, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    const r = resolveTextTableOverlapsInDocument(doc);
    expect(findTextTableOverlaps(r.document)).toHaveLength(0);
    expect(r.moved).toEqual(["t1"]);
    expect(r.unresolved).toBe(0);
    const fixed = r.document.elements.find((e) => e.id === "t1");
    if (fixed?.type === "text") {
      // 表(y=30..90)の外へ出ている。x は変えない(縦の最小移動)。
      expect(fixed.x).toBe(120);
      expect(fixed.y).not.toBe(60);
      // ページ内に収まっている。
      expect(fixed.y).toBeGreaterThanOrEqual(0);
      expect(fixed.y + fixed.h).toBeLessThanOrEqual(A4_LANDSCAPE.height);
    }
  });

  it("移動は新たな重なりを作らない(既存の総組数を増やさない)", () => {
    // 表の直下にもう1つ表がある=下へ最小移動すると新たな重なりができる配置。
    const doc = makeDoc([
      text("t1", 120, 60),
      table("tb1", 100, 30, 80, 60),
      table("tb2", 100, 90.6, 80, 60),
    ]);
    const before = findTextTableOverlaps(doc).length;
    const r = resolveTextTableOverlapsInDocument(doc);
    const after = findTextTableOverlaps(r.document).length;
    expect(after).toBeLessThanOrEqual(before);
    // t1 が関与する重なりは残っていない(上へ逃げた)か、解消不能として残る。
    const t1Pairs = findTextTableOverlaps(r.document).filter(
      (p) => p.aId === "t1" || p.bId === "t1",
    );
    if (r.unresolved === 0) {
      expect(t1Pairs).toHaveLength(0);
    }
  });

  it("表×表の重なりは自動では直せない=触らず unresolved に数える", () => {
    const doc = makeDoc([table("a", 10, 10, 40, 60), table("b", 30, 10, 40, 60)]);
    const before = findTextTableOverlaps(doc);
    expect(before).toHaveLength(1);
    const r = resolveTextTableOverlapsInDocument(doc);
    expect(r.document).toBe(doc); // 何も変えない=同一参照
    expect(r.unresolved).toBe(1);
    expect(r.shrunk).toEqual([]);
    expect(r.moved).toEqual([]);
  });

  it("文字×文字も対象(後の要素を調整する)", () => {
    const doc = makeDoc([text("t1", 10, 10), text("t2", 20, 12)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    const r = resolveTextTableOverlapsInDocument(doc);
    expect(findTextTableOverlaps(r.document)).toHaveLength(0);
    expect(r.unresolved).toBe(0);
    // t1(先の要素)は不変。
    const t1 = r.document.elements.find((e) => e.id === "t1");
    if (t1?.type === "text") {
      expect(t1.x).toBe(10);
      expect(t1.y).toBe(10);
      expect(t1.style.fontSizePt).toBeUndefined();
    }
  });

  it("決定的である(同じ入力からは常に同じ結果)", () => {
    const doc = makeDoc([text("t1", 120, 60), table("tb", 100, 30, 80, 60)]);
    const r1 = resolveTextTableOverlapsInDocument(doc);
    const r2 = resolveTextTableOverlapsInDocument(doc);
    expect(JSON.stringify(r1.document)).toBe(JSON.stringify(r2.document));
    expect(r1.shrunk).toEqual(r2.shrunk);
    expect(r1.moved).toEqual(r2.moved);
    expect(r1.unresolved).toBe(r2.unresolved);
  });

  it("入力の document を書き換えない(不変)", () => {
    const doc = makeDoc([text("price", 100, 40), table("tb", 114, 30)]);
    const snapshot = JSON.stringify(doc);
    resolveTextTableOverlapsInDocument(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it("明示済みの fontSizePt からも下限=6割で止まる", () => {
    // 20pt の大きな文字がど真ん中: 縮小だけでは 12pt(6割) までしか下げない。
    const doc = makeDoc([
      text("big", 120, 60, 40, 10, { fontSizePt: 20 }),
      table("tb", 100, 30, 80, 60),
    ]);
    const r = resolveTextTableOverlapsInDocument(doc);
    const big = r.document.elements.find((e) => e.id === "big");
    if (big?.type === "text" && big.style.fontSizePt !== undefined) {
      expect(big.style.fontSizePt).toBeGreaterThanOrEqual(12);
    }
  });
});
