/**
 * parseZoningFC ユニットテスト
 *
 * 実 API に依存せず GeoJSON fixture だけで用途地域判定ロジックを検証する。
 * 目的: 「第二種中高層住居専用地域なのに近隣商業地域になる」等の誤判定を
 *       ロジックレベルで防ぐことを確認する。
 */

import { describe, it, expect } from "vitest";
import { parseZoningFC, type GeoJsonFC, type GeoJsonFeature } from "../reinfolib-provider";

// ── fixture helpers ──────────────────────────────────────────────────────────

type Ring = [number, number][];

/** 矩形ポリゴン（閉じたリング）を生成する。 */
function box(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): { type: "Polygon"; coordinates: Ring[] } {
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat], // 閉じる
      ],
    ],
  };
}

type Props = {
  use_area_ja?: string | null;
  u_building_coverage_ratio_ja?: string | null;
  u_floor_area_ratio_ja?: string | null;
  [k: string]: unknown;
};

function feature(props: Props, geometry: object): GeoJsonFeature {
  return { type: "Feature", properties: props as Record<string, unknown>, geometry: geometry as GeoJsonFeature["geometry"] };
}

function fc(features: GeoJsonFeature[]): GeoJsonFC {
  return { type: "FeatureCollection", features };
}

// テスト用の基準座標
const LNG = 139.5;
const LAT = 35.5;

// 点を含む大きい矩形ボックス（座標: 139-140, 35-36）
const BIG_BOX = box(139.0, 35.0, 140.0, 36.0);
// 点を含む小さい矩形ボックス（座標: 139.3-139.7, 35.3-35.7）
const SMALL_BOX = box(139.3, 35.3, 139.7, 35.7);
// 点を含まない別ボックス（座標: 141-142, 37-38）
const FAR_BOX = box(141.0, 37.0, 142.0, 38.0);

// ── ケース 1: features が空 ─────────────────────────────────────────────────

describe("features が空の場合", () => {
  it("保存しない / selectionReason: no features returned", () => {
    const { data, meta } = parseZoningFC(fc([]), LNG, LAT);

    expect(data.zoningDistrict).toBeUndefined();
    expect(data.buildingCoverageRatio).toBeUndefined();
    expect(data.floorAreaRatio).toBeUndefined();
    expect(meta.returnedFeatureCount).toBe(0);
    expect(meta.spatialMatchCount).toBe(0);
    expect(meta.selectionReason).toBe("no features returned");
    expect(meta.selectedUseAreaJa).toBeNull();
    expect(meta.selectedBuildingCoverageRatio).toBeNull();
    expect(meta.selectedFloorAreaRatio).toBeNull();
    expect(meta.candidateSummaries).toHaveLength(0);
    expect(meta.matchedFeatureIndexes).toHaveLength(0);
  });
});

// ── ケース 2: features はあるが点が polygon の外 ─────────────────────────────

describe("空間一致 0 件（点が外）の場合", () => {
  it("保存しない / selectionReason: no spatial match", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "近隣商業地域", u_building_coverage_ratio_ja: "80%", u_floor_area_ratio_ja: "300%" },
          FAR_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBeUndefined();
    expect(meta.spatialMatchCount).toBe(0);
    expect(meta.returnedFeatureCount).toBe(1);
    expect(meta.selectionReason).toBe("no spatial match");
    expect(meta.selectedUseAreaJa).toBeNull();
    expect(meta.candidateSummaries).toHaveLength(0);
  });
});

// ── ケース 3: 空間一致 1 件 ──────────────────────────────────────────────────

describe("空間一致 1 件の場合", () => {
  it("zoningDistrict / BCR / FAR をすべて保存する", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          {
            use_area_ja: "第二種中高層住居専用地域",
            u_building_coverage_ratio_ja: "60%",
            u_floor_area_ratio_ja: "200%",
          },
          BIG_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBe("第二種中高層住居専用地域");
    expect(data.buildingCoverageRatio).toBe(60);
    expect(data.floorAreaRatio).toBe(200);
    expect(meta.spatialMatchCount).toBe(1);
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.selectedUseAreaJa).toBe("第二種中高層住居専用地域");
    expect(meta.selectedBuildingCoverageRatio).toBe(60);
    expect(meta.selectedFloorAreaRatio).toBe(200);
    expect(meta.matchedFeatureIndexes).toEqual([0]);
    expect(meta.candidateSummaries).toHaveLength(1);
    expect(meta.candidateSummaries[0].useAreaJa).toBe("第二種中高層住居専用地域");
  });

  it("点が含まれない別 feature は無視される", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "近隣商業地域", u_building_coverage_ratio_ja: "80%", u_floor_area_ratio_ja: "300%" },
          FAR_BOX, // 点を含まない
        ),
        feature(
          { use_area_ja: "第一種住居地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          BIG_BOX, // 点を含む
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBe("第一種住居地域");
    expect(meta.spatialMatchCount).toBe(1);
    expect(meta.returnedFeatureCount).toBe(2);
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.matchedFeatureIndexes).toEqual([1]); // features[1] が一致
  });
});

// ── ケース 4: 空間一致複数・用途地域/建蔽率/容積率がすべて同一 ─────────────────

describe("空間一致複数・全値同一の場合", () => {
  it("最小面積の候補を採用して保存する / selectionReason: multiple matches but same zoning values", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "第一種低層住居専用地域", u_building_coverage_ratio_ja: "40%", u_floor_area_ratio_ja: "80%" },
          BIG_BOX,   // 大きい（面積大）
        ),
        feature(
          { use_area_ja: "第一種低層住居専用地域", u_building_coverage_ratio_ja: "40%", u_floor_area_ratio_ja: "80%" },
          SMALL_BOX, // 小さい（面積小）→ こちらが採用される
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBe("第一種低層住居専用地域");
    expect(data.buildingCoverageRatio).toBe(40);
    expect(data.floorAreaRatio).toBe(80);
    expect(meta.spatialMatchCount).toBe(2);
    expect(meta.selectionReason).toBe("multiple matches but same zoning values");
    expect(meta.selectedUseAreaJa).toBe("第一種低層住居専用地域");
    expect(meta.candidateSummaries).toHaveLength(2);
    // 採用されたのは小さい方 (index=1) のはず
    expect(meta.matchedFeatureIndexes).toContain(1);
  });
});

// ── ケース 5: 空間一致複数・用途地域が不一致 ──────────────────────────────────

describe("空間一致複数・用途地域が不一致の場合", () => {
  it("保存しない / selectionReason: conflicting zoning candidates", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "第二種中高層住居専用地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          BIG_BOX,
        ),
        feature(
          { use_area_ja: "近隣商業地域", u_building_coverage_ratio_ja: "80%", u_floor_area_ratio_ja: "300%" },
          SMALL_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    // 誤判定の具体例: この 2 feature が両方マッチしても誤値を保存しない
    expect(data.zoningDistrict).toBeUndefined();
    expect(data.buildingCoverageRatio).toBeUndefined();
    expect(data.floorAreaRatio).toBeUndefined();
    expect(meta.spatialMatchCount).toBe(2);
    expect(meta.selectionReason).toBe("conflicting zoning candidates");
    expect(meta.selectedUseAreaJa).toBeNull();
    expect(meta.selectedBuildingCoverageRatio).toBeNull();
    expect(meta.selectedFloorAreaRatio).toBeNull();
    // 両候補が candidateSummaries に残っている（監査用）
    expect(meta.candidateSummaries).toHaveLength(2);
    const zones = meta.candidateSummaries.map((c) => c.useAreaJa);
    expect(zones).toContain("第二種中高層住居専用地域");
    expect(zones).toContain("近隣商業地域");
  });
});

// ── ケース 6: 空間一致複数・用途地域は同一だが建蔽率が不一致 ──────────────────

describe("空間一致複数・用途地域同一・建蔽率不一致の場合", () => {
  it("保存しない / selectionReason: conflicting ratio candidates", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "第一種住居地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          BIG_BOX,
        ),
        feature(
          { use_area_ja: "第一種住居地域", u_building_coverage_ratio_ja: "50%", u_floor_area_ratio_ja: "200%" },
          SMALL_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting ratio candidates");
    expect(meta.selectedUseAreaJa).toBeNull();
  });
});

// ── ケース 7: 空間一致複数・用途地域・建蔽率は同一だが容積率が不一致 ──────────

describe("空間一致複数・用途地域/建蔽率同一・容積率不一致の場合", () => {
  it("保存しない / selectionReason: conflicting ratio candidates", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { use_area_ja: "準工業地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          BIG_BOX,
        ),
        feature(
          { use_area_ja: "準工業地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "400%" },
          SMALL_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting ratio candidates");
    expect(meta.selectedFloorAreaRatio).toBeNull();
  });
});

// ── ケース 8: 空間一致複数・属性が欠損（use_area_ja が null）──────────────────

describe("空間一致複数・use_area_ja が欠損している場合", () => {
  it("保存しない / selectionReason: insufficient candidate attributes", () => {
    const { data, meta } = parseZoningFC(
      fc([
        feature(
          { u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" }, // use_area_ja なし
          BIG_BOX,
        ),
        feature(
          { use_area_ja: "第一種住居地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          SMALL_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBeUndefined();
    expect(meta.selectionReason).toBe("insufficient candidate attributes");
    expect(meta.selectedUseAreaJa).toBeNull();
  });
});

// ── ケース 9: geometry なし feature は空間一致しない ────────────────────────

describe("geometry が null / undefined の feature の場合", () => {
  it("geometry なしの feature は候補に含めない", () => {
    const { data, meta } = parseZoningFC(
      fc([
        { type: "Feature", properties: { use_area_ja: "商業地域" }, geometry: null } as GeoJsonFeature,
        feature(
          { use_area_ja: "第二種住居地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" },
          BIG_BOX,
        ),
      ]),
      LNG,
      LAT,
    );

    expect(data.zoningDistrict).toBe("第二種住居地域");
    expect(meta.spatialMatchCount).toBe(1);
    expect(meta.selectionReason).toBe("unique spatial match");
  });
});

// ── ケース 10: candidateSummaries の approxArea ───────────────────────────

describe("candidateSummaries の approxArea", () => {
  it("小さい方の polygon が大きい方より小さい approxArea を持つ", () => {
    const { meta } = parseZoningFC(
      fc([
        feature({ use_area_ja: "工業地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" }, BIG_BOX),
        feature({ use_area_ja: "工業地域", u_building_coverage_ratio_ja: "60%", u_floor_area_ratio_ja: "200%" }, SMALL_BOX),
      ]),
      LNG,
      LAT,
    );

    const [big, small] = meta.candidateSummaries.sort((a, b) => b.approxArea - a.approxArea);
    expect(big.approxArea).toBeGreaterThan(small.approxArea);
  });
});
