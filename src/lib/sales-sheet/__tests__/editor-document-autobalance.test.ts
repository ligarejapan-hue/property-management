/**
 * TDD: editor-document 自動レイアウト再バランス（Task3）
 *   autoBalanceLayout: document 全体を computeSpecSheetLayout（最適化エンジン）で
 *   再バランスする。動かすのは「既知idのテンプレ枠」（catch-band/catch-copy/heading/
 *   price/overview/sales-points/company/company-details/floor-plan）と「type==="image"
 *   の写真要素（配列順）」のみ。未知idの非image要素（ユーザーが手で足した独自要素）は
 *   参照ごと不動。autoArrangePhotos と同じ no-op（変更ゼロ→同一 state 参照）規約。
 */
import { describe, it, expect } from "vitest";
import { type EditorState, autoBalanceLayout, autoArrangePhotos } from "../editor-document";
import { buildSaleHouseDocument } from "../build-document";
import { buildFooterBand } from "../footer-band";
import {
  computeSpecSheetLayout,
  DEFAULT_FOOTER_H,
  MAIN_BOTTOM_MARGIN_MM,
  SALES_POINTS_H_MM,
  PHOTO_GAP_MM,
} from "../layout-engine";
import {
  salesSheetDocumentSchema,
  type SalesSheetDocument,
  type SalesSheetElement,
  type ImageElement,
  type TableElement,
} from "../document-schema";

const baseHouseInput = {
  property: {
    address: "東京都杉並区西荻北1-4-3",
    layoutType: "3LDK",
    zoningDistrict: "第一種中高層住居専用地域",
    buildingCoverageRatio: "60",
    floorAreaRatio: "200",
    roadType: "公道",
    roadWidth: "4.0",
    occupancyStatus: "vacant",
  },
  photos: [{ fileUrl: "/uploads/1.jpg" }, { fileUrl: "/uploads/2.jpg" }],
};

function makeState(document: SalesSheetDocument): EditorState {
  return { document, selectedId: null, dirty: false };
}

/** 指定 id の要素の x/y だけをずらす（ユーザーが手でドラッグした状態を模す）。他フィールドは保持。 */
function moveEl(doc: SalesSheetDocument, id: string, x: number, y: number): SalesSheetDocument {
  return {
    ...doc,
    elements: doc.elements.map((el) =>
      el.id === id ? ({ ...el, x, y } as unknown as SalesSheetElement) : el,
    ),
  };
}

/** overview（table）の style.fontSizePt だけを差し替える（行を増減しても現状の reducer は
 *  フォントを自動更新しないため、現在の行数と整合しない「古い」値が残った状態を模す）。
 *  他フィールドは保持。 */
function setOverviewFontPt(doc: SalesSheetDocument, fontSizePt: number): SalesSheetDocument {
  return {
    ...doc,
    elements: doc.elements.map((el) =>
      el.id === "overview"
        ? ({ ...el, style: { ...(el as TableElement).style, fontSizePt } } as unknown as SalesSheetElement)
        : el,
    ),
  };
}

function findEl(doc: SalesSheetDocument, id: string): SalesSheetElement | undefined {
  return doc.elements.find((e) => e.id === id);
}

const images = (doc: SalesSheetDocument): ImageElement[] =>
  doc.elements.filter((e): e is ImageElement => e.type === "image");

describe("autoBalanceLayout", () => {
  it("写真枠・overviewを手でズラした後に掛けると、computeSpecSheetLayoutの期待値へ揃う", () => {
    const built = buildSaleHouseDocument({
      ...baseHouseInput,
      overrides: { price: "5280", landCategory: ["宅地"] },
    });
    const [firstPhoto] = images(built);
    let doc = moveEl(built, firstPhoto.id, 3, 3);
    doc = moveEl(doc, "overview", 5, 5);

    const state = autoBalanceLayout(makeState(doc));

    const rows = (findEl(built, "overview") as TableElement).rows;
    const L = computeSpecSheetLayout({
      photoCount: images(built).length,
      specRowCount: rows.length,
      hasFloorPlan: !!findEl(built, "floor-plan"),
      footerHeight: DEFAULT_FOOTER_H,
    });

    const overview = findEl(state.document, "overview") as TableElement;
    expect(overview.x).toBeCloseTo(L.overview.x, 6);
    expect(overview.y).toBeCloseTo(L.overview.y, 6);
    expect(overview.w).toBeCloseTo(L.overview.w, 6);
    expect(overview.h).toBeCloseTo(L.overview.h, 6);
    expect(overview.style.fontSizePt).toBeCloseTo(L.overview.fontSizePt, 6);

    const photosAfter = images(state.document);
    expect(photosAfter).toHaveLength(2);
    photosAfter.forEach((img, k) => {
      expect(img.x).toBeCloseTo(L.photoSlots[k].x, 6);
      expect(img.y).toBeCloseTo(L.photoSlots[k].y, 6);
      expect(img.w).toBeCloseTo(L.photoSlots[k].w, 6);
      expect(img.h).toBeCloseTo(L.photoSlots[k].h, 6);
    });
    expect(state.dirty).toBe(true);
  });

  it("overviewの古い(現在の行数に整合しない)フォントを、行数から再計算した値で上書きする（overviewFontPtを渡さない・@review Fix B）", () => {
    const built = buildSaleHouseDocument({ ...baseHouseInput, overrides: { price: "5280" } });
    const rows = (findEl(built, "overview") as TableElement).rows;
    const freshFontPt = computeSpecSheetLayout({
      photoCount: images(built).length,
      specRowCount: rows.length,
      hasFloorPlan: !!findEl(built, "floor-plan"),
      footerHeight: DEFAULT_FOOTER_H,
    }).overview.fontSizePt;

    // 行数はそのまま、フォントだけ現在の行数に整合しない「古い」値へ差し替える
    // （必ず freshFontPt と異なる値になる）。
    const staleFontPt = freshFontPt === 5 ? 9 : 5;
    const doc = setOverviewFontPt(built, staleFontPt);

    const state = autoBalanceLayout(makeState(doc));
    const overview = findEl(state.document, "overview") as TableElement;

    // 古い値をそのまま素通しするのではなく、行数から再計算した値になる。
    expect(overview.style.fontSizePt).toBeCloseTo(freshFontPt, 6);
    expect(overview.style.fontSizePt).not.toBe(staleFontPt);
  });

  it("未知idのtext要素（ユーザーが手で足した独自要素）は参照ごと不動", () => {
    const built = buildSaleHouseDocument({ ...baseHouseInput, overrides: { price: "5280" } });
    const customEl: SalesSheetElement = {
      id: "custom-note",
      type: "text",
      x: 50,
      y: 150,
      w: 40,
      h: 10,
      z: 99,
      content: "手書きメモ",
      style: {},
    };
    const doc: SalesSheetDocument = { ...built, elements: [...built.elements, customEl] };
    // ついでに overview もズラして「変化が起きる」ことを保証する（no-opにしない）。
    const shifted = moveEl(doc, "overview", 1, 1);

    const state = autoBalanceLayout(makeState(shifted));

    const before = findEl(shifted, "custom-note");
    const after = findEl(state.document, "custom-note");
    expect(after).toBe(before);
  });

  it("すでにバランス済みのdocumentに掛けると同一state参照（no-op）", () => {
    const built = buildSaleHouseDocument({ ...baseHouseInput, overrides: { price: "5280" } });
    const state = makeState(built);
    expect(autoBalanceLayout(state)).toBe(state);
  });

  it("画像0枚でもoverview等は再配置され、写真は増えない", () => {
    const built = buildSaleHouseDocument({
      ...baseHouseInput,
      photos: [],
      overrides: { price: "5280" },
    });
    const shifted = moveEl(built, "overview", 9, 9);
    const state = autoBalanceLayout(makeState(shifted));

    const rows = (findEl(built, "overview") as TableElement).rows;
    const L = computeSpecSheetLayout({
      photoCount: 0,
      specRowCount: rows.length,
      hasFloorPlan: false,
      footerHeight: DEFAULT_FOOTER_H,
    });
    const overview = findEl(state.document, "overview") as TableElement;
    expect(overview.x).toBeCloseTo(L.overview.x, 6);
    expect(overview.y).toBeCloseTo(L.overview.y, 6);
    expect(images(state.document)).toHaveLength(0);
  });

  it("結果documentはschema検証を通る（保存可能）", () => {
    const built = buildSaleHouseDocument({
      ...baseHouseInput,
      overrides: { price: "5280" },
    });
    const shifted = moveEl(built, "overview", 1, 1);
    const state = autoBalanceLayout(makeState(shifted));
    expect(salesSheetDocumentSchema.safeParse(state.document).success).toBe(true);
  });

  it("selectedIdは変更しない", () => {
    const built = buildSaleHouseDocument({ ...baseHouseInput, overrides: { price: "5280" } });
    const shifted = moveEl(built, "overview", 1, 1);
    const before: EditorState = { document: shifted, selectedId: "overview", dirty: false };
    const after = autoBalanceLayout(before);
    expect(after.selectedId).toBe("overview");
  });

  it("手で動かした会社帯要素(footer-*)を再バランスで正規位置へ戻す（@codex）", () => {
    const built = buildSaleHouseDocument({
      ...baseHouseInput,
      overrides: { price: "5280", transactionType: "専任媒介", staff: "村山廉太郎" },
    });
    // 帯要素(社名)を手でドラッグしてずらした状態を作る
    const shifted = moveEl(built, "footer-name-ja", 200, 60);
    expect(findEl(shifted, "footer-name-ja")).toMatchObject({ x: 200, y: 60 });
    const out = autoBalanceLayout(makeState(shifted));
    // computeSpecSheetLayout の footer から buildFooterBand が置く正規座標へ戻る
    const L = computeSpecSheetLayout({
      photoCount: images(built).length,
      specRowCount: (findEl(built, "overview") as TableElement).rows.length,
      hasFloorPlan: built.elements.some((e) => e.id === "floor-plan"),
      footerHeight: DEFAULT_FOOTER_H,
    });
    const expected = buildFooterBand(L.footer, {
      transactionType: "-",
      adType: "-",
      compensation: "-",
      staff: "-",
      agent: "-",
      specialNotes: "-",
    }).find((e) => e.id === "footer-name-ja")!;
    const after = findEl(out.document, "footer-name-ja")!;
    expect(after.x).toBeCloseTo(expected.x, 6);
    expect(after.y).toBeCloseTo(expected.y, 6);
  });
});

describe("autoArrangePhotos × 会社帯 / salesPoints", () => {
  it("写真自動整列後、写真は salesPoints帯・会社帯を侵さない（@codex R1/R2）", () => {
    const built = buildSaleHouseDocument({ ...baseHouseInput, overrides: { price: "5280" } });
    const out = autoArrangePhotos(makeState(built));
    // エンジンが写真敷詰めを止める下端＝mainBottom − salesPoints − gap（写真はこの上まで）。
    const photoPackBottom =
      210 - DEFAULT_FOOTER_H - MAIN_BOTTOM_MARGIN_MM - SALES_POINTS_H_MM - PHOTO_GAP_MM;
    const imgs = images(out.document);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img.y + img.h).toBeLessThanOrEqual(photoPackBottom + 0.001);
    }
  });
});
