/**
 * B-8 (UI総点検): 文字・表どうしの重なり検知 (findTextTableOverlaps)。
 *
 * 自動整列/自動調整は自由配置の文字・表を動かさない仕様(手動配置の尊重・
 * editor-document-autobalance.test.ts で固定)のため、重なりが出力(PDF/PNG)に
 * そのまま残り得る。read-only の検知ヘルパで編集画面に注意を出す。
 *
 * 対象は text×text / text×table / table×table のみ:
 * - 写真の上の文字 (キャプション等) や帯 (shape) の上の見出しは意図的な重なりの
 *   定番なので対象外
 */
import { describe, it, expect } from "vitest";
import { findTextTableOverlaps } from "../editor-document";
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

const text = (id: string, x: number, y: number, w = 40, h = 10) => ({
  id, type: "text", x, y, w, h, z: 5, content: "テキスト", style: {},
});
const table = (id: string, x: number, y: number, w = 80, h = 60) => ({
  id, type: "table", x, y, w, h, z: 1,
  rows: [{ label: "物件種別", value: "売地" }], style: {},
});
const image = (id: string, x: number, y: number, w = 90, h = 60) => ({
  id, type: "image", x, y, w, h, z: 2, src: "/uploads/properties/a/1.jpg", fit: "cover",
});

describe("findTextTableOverlaps", () => {
  it("重なる text×table を 1 組として検出する (B-8 の価格 vs 概要表)", () => {
    const doc = makeDoc([text("price", 100, 40), table("overview", 120, 30)]);
    const pairs = findTextTableOverlaps(doc);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aId, pairs[0].bId].sort()).toEqual(["overview", "price"]);
  });

  it("重なる text×text も検出する", () => {
    const doc = makeDoc([text("t1", 10, 10), text("t2", 30, 12)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
  });

  it("離れていれば検出しない", () => {
    const doc = makeDoc([text("t1", 10, 10), table("overview", 120, 100)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("辺が接しているだけ (隣接) は重なり扱いしない", () => {
    const doc = makeDoc([text("t1", 10, 10, 40, 10), text("t2", 50, 10, 40, 10)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("ごくわずかな食い込み (0.5mm 以下) は許容して検出しない", () => {
    const doc = makeDoc([text("t1", 10, 10, 40, 10), text("t2", 49.7, 10, 40, 10)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("写真の上の文字 (意図的な重なりの定番) は対象外", () => {
    const doc = makeDoc([image("img-1", 10, 10), text("caption", 12, 12)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("3 要素が相互に重なると組数で数える (t1×t2, t1×表, t2×表 = 3)", () => {
    const doc = makeDoc([
      text("t1", 100, 40, 60, 30),
      text("t2", 110, 50, 60, 30),
      table("overview", 90, 30, 100, 60),
    ]);
    expect(findTextTableOverlaps(doc)).toHaveLength(3);
  });

  it("行数が多く保存 h からはみ出して描画される表との重なりも検知する (@codex #310)", () => {
    // レンダラは <table> を直接描くため、行が増えると CSS height(最小値扱い)を
    // 超えて描画される。保存 h=10mm でも 8 行なら実描画は約44mm に達し、
    // その範囲の文字と重なる。
    const bigTable = {
      id: "overview", type: "table", x: 100, y: 10, w: 80, h: 10, z: 1,
      rows: Array.from({ length: 8 }, (_, i) => ({ label: `項目${i}`, value: "値" })),
      style: {},
    };
    // 保存 h(10mm) の外・見積り高さ(約44mm)の内に置いた文字
    const doc = makeDoc([bigTable, text("below", 110, 30)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    // 行数が少なく保存 h に収まる表では、保存 h の外の文字は検知しない
    const smallTable = { ...bigTable, id: "overview", rows: [{ label: "a", value: "b" }] };
    const doc2 = makeDoc([smallTable, text("below", 110, 30)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(0);
  });

  it("要素を動かさない read-only ヘルパ (document は不変)", () => {
    const doc = makeDoc([text("price", 100, 40), table("overview", 120, 30)]);
    const before = JSON.stringify(doc);
    findTextTableOverlaps(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
