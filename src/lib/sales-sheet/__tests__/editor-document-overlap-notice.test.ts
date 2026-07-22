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
    // text("price") の文字域は左上から約 17×5mm (4文字・既定12pt)
    const doc = makeDoc([text("price", 100, 40), table("overview", 110, 30)]);
    const pairs = findTextTableOverlaps(doc);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aId, pairs[0].bId].sort()).toEqual(["overview", "price"]);
  });

  it("重なる text×text も検出する", () => {
    const doc = makeDoc([text("t1", 10, 10), text("t2", 20, 12)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
  });

  it("離れていれば検出しない", () => {
    const doc = makeDoc([text("t1", 10, 10), table("overview", 120, 100)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("辺が接しているだけ (隣接) は重なり扱いしない", () => {
    const doc = makeDoc([table("a", 10, 10, 40, 60), table("b", 50, 10, 40, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("ごくわずかな食い込み (0.5mm 以下) は許容して検出しない", () => {
    const doc = makeDoc([table("a", 10, 10, 40, 60), table("b", 49.7, 10, 40, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("写真の上の文字 (意図的な重なりの定番) は対象外", () => {
    const doc = makeDoc([image("img-1", 10, 10), text("caption", 12, 12)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
  });

  it("3 要素が相互に重なると組数で数える (t1×t2, t1×表, t2×表 = 3)", () => {
    const doc = makeDoc([
      text("t1", 100, 40, 60, 30),
      text("t2", 105, 42, 60, 30),
      table("overview", 90, 30, 100, 60),
    ]);
    expect(findTextTableOverlaps(doc)).toHaveLength(3);
  });

  it("箱だけ大きい text の透明余白では警告しない (@codex #310 R5)", () => {
    // 幅 120mm の箱に「価格」2文字 (左寄せ・文字域は左端の約8.5mm) — 箱の右側の
    // 余白にだけ重なる表は出力上何も重ならないため検出しない
    const wideBox = { id: "price", type: "text", x: 100, y: 40, w: 120, h: 40, z: 5, content: "価格", style: {} };
    const doc = makeDoc([wideBox, table("overview", 150, 30, 80, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
    // 右寄せなら文字域は箱の右端 → 同じ表と重なる
    const rightAligned = { ...wideBox, style: { align: "right" } };
    const doc2 = makeDoc([rightAligned, table("overview", 150, 30, 80, 60)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(1);
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

  it("空文字の text (テンプレが保持する未入力枠) は対象外 (@codex #310 R2)", () => {
    const emptyText = { id: "price", type: "text", x: 100, y: 40, w: 40, h: 10, z: 5, content: "", style: {} };
    const doc = makeDoc([emptyText, table("overview", 100, 30)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
    // 空白のみも対象外
    const blankText = { ...emptyText, id: "sales-points", content: "  " };
    const doc2 = makeDoc([blankText, table("overview", 100, 30)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(0);
  });

  it("セル内の折返しで伸びた表との重なりも検知する (@codex #310 R2)", () => {
    // 幅 40mm の表に長い値 (全角40文字) → value セル(約25mm)で複数行に折返し、
    // 1 行の保存 h=8mm を大きく超えて描画される
    const wrapTable = {
      id: "overview", type: "table", x: 100, y: 10, w: 40, h: 8, z: 1,
      rows: [{ label: "備考", value: "あ".repeat(40) }],
      style: {},
    };
    const doc = makeDoc([wrapTable, text("below", 105, 22)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    // 同じ表でも値が短ければ保存 h 相当のまま = 検知しない
    const shortTable = { ...wrapTable, rows: [{ label: "備考", value: "短い" }] };
    const doc2 = makeDoc([shortTable, text("below", 105, 22)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(0);
  });

  it("monospace テーマでは ASCII を全角幅で見積る (@codex #310 R6)", () => {
    // ASCII 32文字・箱 w=120。プロポーショナル(0.6em)なら文字域は約81mmで
    // x=200 の表に届かないが、monospace(1em)なら約135mm→箱幅いっぱいまで届く。
    const asciiText = {
      id: "code", type: "text", x: 100, y: 40, w: 120, h: 10, z: 5,
      content: "A".repeat(32), style: {},
    };
    const tbl = table("overview", 200, 30, 60, 60);
    const propDoc = parseSalesSheetDocument({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
      elements: [asciiText, tbl],
    });
    expect(findTextTableOverlaps(propDoc)).toHaveLength(0);
    const monoDoc = parseSalesSheetDocument({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "monospace", accentColor: "#1f4e79" },
      elements: [asciiText, tbl],
    });
    expect(findTextTableOverlaps(monoDoc)).toHaveLength(1);
  });

  it("折返し不可のASCII塊は縦に伸びない扱い (横clip・@codex #310 R7)", () => {
    // 幅 40mm の箱に空白なしの長い識別子 → pre-wrap では折り返されず横に clip
    // されるため、下に置いた表とは重ならない (機械的に割ると 4 行分に伸びて誤検知)
    const token = {
      id: "code", type: "text", x: 100, y: 10, w: 40, h: 20, z: 5,
      content: "A".repeat(60), style: {},
    };
    const doc = makeDoc([token, table("overview", 100, 18, 80, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
    // 空白区切りなら折り返して縦に伸びる → 同じ表と重なる
    const wrapped = { ...token, content: "ABCDEFG ".repeat(8) };
    const doc2 = makeDoc([wrapped, table("overview", 100, 18, 80, 60)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(1);
  });

  it("表セルの折返し不可ASCII塊も縦に伸びない扱い (@codex #310 R8)", () => {
    // 空白なしの長い URL は value セル内で折り返されず横にはみ出す → 表は
    // 1 行分のまま。下に置いた文字とは重ならない
    const urlTable = {
      id: "overview", type: "table", x: 100, y: 10, w: 80, h: 10, z: 1,
      rows: [{ label: "URL", value: "https://example.com/" + "a".repeat(40) }],
      style: {},
    };
    const doc = makeDoc([urlTable, text("below", 110, 24)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(0);
    // 空白区切りの長い値なら折り返して縦に伸びる → 同じ文字と重なる
    const wrappedTable = {
      ...urlTable,
      rows: [{ label: "備考", value: "word ".repeat(24).trim() }],
    };
    const doc2 = makeDoc([wrappedTable, text("below", 110, 24)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(1);
  });

  it("ハイフン区切りのASCIIは折返し可能点で縦に伸びる (@codex #310 R9)", () => {
    // ハイフン直後は CSS の折返し可能点 → 複数行に伸びて下の表と重なる
    const hyphenated = {
      id: "code", type: "text", x: 100, y: 10, w: 40, h: 20, z: 5,
      content: "ABCD-".repeat(12), style: {},
    };
    const doc = makeDoc([hyphenated, table("overview", 100, 18, 80, 60)]);
    expect(findTextTableOverlaps(doc)).toHaveLength(1);
    // 同じ長さでもハイフン無しの塊なら 1 行で clip → 重ならない
    const unbroken = { ...hyphenated, content: "ABCDE".repeat(12) };
    const doc2 = makeDoc([unbroken, table("overview", 100, 18, 80, 60)]);
    expect(findTextTableOverlaps(doc2)).toHaveLength(0);
  });

  it("要素を動かさない read-only ヘルパ (document は不変)", () => {
    const doc = makeDoc([text("price", 100, 40), table("overview", 120, 30)]);
    const before = JSON.stringify(doc);
    findTextTableOverlaps(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
