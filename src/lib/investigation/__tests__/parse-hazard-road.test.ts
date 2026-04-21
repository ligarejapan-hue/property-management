/**
 * XKT014/025~030 各 endpoint の空間フィルタ判定ユニットテスト
 *
 * 実 API 依存なし・GeoJSON fixture のみで動作する。
 * 「誤値を保存しない」を最優先した実装の正当性を検証する。
 */

import { describe, it, expect } from "vitest";
import {
  parseFireZoneFC,
  parseLiquefactionFC,
  parseFloodFC,
  parseStormSurgeFC,
  parseTsunamiFC,
  parseSedimentFC,
  parseRoadFC,
  type GeoJsonFC,
  type GeoJsonFeature,
} from "../reinfolib-provider";

// ── fixture helpers ──────────────────────────────────────────────────────────

type Ring = [number, number][];

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
        [minLng, minLat],
      ],
    ],
  };
}

function feat(props: Record<string, unknown>, geometry: object): GeoJsonFeature {
  return {
    type: "Feature",
    properties: props,
    geometry: geometry as GeoJsonFeature["geometry"],
  };
}

function fc(...features: GeoJsonFeature[]): GeoJsonFC {
  return { type: "FeatureCollection", features };
}

const LNG = 139.5;
const LAT = 35.5;
const IN_BOX  = box(139.0, 35.0, 140.0, 36.0); // 点を含む大
const IN_SMALL = box(139.3, 35.3, 139.7, 35.7); // 点を含む小
const OUT_BOX  = box(141.0, 37.0, 142.0, 38.0); // 点を含まない

// ════════════════════════════════════════════════════════════════════════════
// XKT014 parseFireZoneFC
// ════════════════════════════════════════════════════════════════════════════

describe("parseFireZoneFC", () => {
  it("features 空 → 保存しない / no features returned", () => {
    const { data, meta } = parseFireZoneFC(fc(), LNG, LAT);
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("no features returned");
    expect(meta.spatialMatchCount).toBe(0);
  });

  it("点が外 → 保存しない / no spatial match", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({ fire_prevention_ja: "防火地域" }, OUT_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("no spatial match");
  });

  it("1 件一致・火防日本語ラベル直接 → 保存", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({ fire_prevention_ja: "防火地域" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBe("防火地域");
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.matchedFeatureIndex).toBe(0);
  });

  it("1 件一致・kubun_id=1 → FIRE_LABELS でマップして保存", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({ kubun_id: "1" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBe("防火地域");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("1 件一致・kubun_id=2 → 準防火地域", () => {
    const { data } = parseFireZoneFC(
      fc(feat({ kubun_id: "2" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBe("準防火地域");
  });

  it("1 件一致・kubun_id=0 → 指定なし扱いで保存しない", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({ kubun_id: "0" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
  });

  it("1 件一致・kubun_id=空文字 → 保存しない", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({ kubun_id: "" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
  });

  it("1 件一致・属性なし（fire_prevention_ja も kubun_id もない）→ 保存しない", () => {
    const { data, meta } = parseFireZoneFC(
      fc(feat({}, IN_BOX)),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
  });

  it("複数一致・同一ラベル → 保存 / multiple matches, same value", () => {
    const { data, meta } = parseFireZoneFC(
      fc(
        feat({ fire_prevention_ja: "準防火地域" }, IN_BOX),
        feat({ fire_prevention_ja: "準防火地域" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBe("準防火地域");
    expect(meta.selectionReason).toBe("multiple matches, same value");
    expect(meta.spatialMatchCount).toBe(2);
  });

  it("複数一致・ラベル不一致 → 保存しない / conflicting candidates", () => {
    const { data, meta } = parseFireZoneFC(
      fc(
        feat({ fire_prevention_ja: "防火地域" },   IN_BOX),
        feat({ fire_prevention_ja: "準防火地域" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });

  it("複数一致・一方が null → insufficient candidate attributes", () => {
    const { data, meta } = parseFireZoneFC(
      fc(
        feat({ fire_prevention_ja: "防火地域" }, IN_BOX),
        feat({}, IN_SMALL), // 属性なし → kubun_id も fire_prevention_ja も null
      ),
      LNG, LAT,
    );
    expect(data.firePreventionZone).toBeUndefined();
    expect(meta.selectionReason).toBe("insufficient candidate attributes");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XKT025 parseLiquefactionFC
// ════════════════════════════════════════════════════════════════════════════

describe("parseLiquefactionFC", () => {
  it("features 空 → 保存しない", () => {
    const { data, meta } = parseLiquefactionFC(fc(), LNG, LAT);
    expect(data.liquefactionRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("no features returned");
  });

  it("1 件一致・rank_ja あり → その値を保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ rank_ja: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("1 件一致・属性名なし → 保存しない / explicit value not resolved", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({}, IN_BOX)), // 候補属性名がどれも存在しない
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.spatialMatchCount).toBe(1);
  });

  it("複数一致・同一値 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(
        feat({ rank_ja: "やや高い" }, IN_BOX),
        feat({ rank_ja: "やや高い" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("やや高い");
    expect(meta.selectionReason).toBe("multiple matches, same value");
  });

  it("複数一致・値が競合 → 保存しない / conflicting candidates", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(
        feat({ rank_ja: "高い" },     IN_BOX),
        feat({ rank_ja: "やや高い" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });

  // ── 拡張候補キーのカバレッジ ────────────────────────────────────────────

  it("旧候補キーが存在せず新候補キーもない → explicit value not resolved", () => {
    // 実 API でありうる「未知のキー名」を使ったケース
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ unknown_liq_field: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.spatialMatchCount).toBe(1);
  });

  it("拡張候補キー liq_rank_ja で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ liq_rank_ja: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("拡張候補キー level_ja で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ level_ja: "やや高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("やや高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  // ── unresolvedKeys 記録 ─────────────────────────────────────────────────

  it("属性未解決のとき meta.unresolvedKeys に実キー一覧が入る", () => {
    const { meta } = parseLiquefactionFC(
      fc(feat({ unknown_field_1: "値A", unknown_field_2: "値B" }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.unresolvedKeys).toEqual(["unknown_field_1", "unknown_field_2"]);
  });

  it("属性解決済みのとき meta.unresolvedKeys は undefined", () => {
    const { meta } = parseLiquefactionFC(
      fc(feat({ rank_ja: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.unresolvedKeys).toBeUndefined();
  });

  it("features 空のとき meta.unresolvedKeys は undefined", () => {
    const { meta } = parseLiquefactionFC(fc(), LNG, LAT);
    expect(meta.selectionReason).toBe("no features returned");
    expect(meta.unresolvedKeys).toBeUndefined();
  });

  // ── 拡張候補 B/C/D キー ────────────────────────────────────────────────

  it("国土数値情報キー A30a_001 で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ A30a_001: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("日本語属性キー 危険度区分 で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ 危険度区分: "やや高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("やや高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("liq_kubun で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ liq_kubun: "低い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("低い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XKT026 parseFloodFC
// ════════════════════════════════════════════════════════════════════════════

describe("parseFloodFC", () => {
  it("点が外 → 保存しない", () => {
    const { data } = parseFloodFC(
      fc(feat({ scale: "0.5m未満" }, OUT_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBeUndefined();
  });

  it("1 件一致・scale あり → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ scale: "0.5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("0.5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("1 件一致・属性なし → 保存しない / explicit value not resolved", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({}, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
  });

  it("複数一致・異なる scale → 保存しない", () => {
    const { data, meta } = parseFloodFC(
      fc(
        feat({ scale: "0.5m未満" }, IN_BOX),
        feat({ scale: "3m以上5m未満" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });

  // ── 拡張候補キーのカバレッジ ────────────────────────────────────────────

  it("旧候補キーが存在せず新候補キーもない → explicit value not resolved", () => {
    // 実 API でありうる「未知のキー名」を使ったケース
    const { data, meta } = parseFloodFC(
      fc(feat({ flood_depth_unknown: "3m以上5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.spatialMatchCount).toBe(1);
  });

  it("拡張候補キー depth_ja で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ depth_ja: "3m以上5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("3m以上5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("拡張候補キー shinsui_class で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ shinsui_class: "0.5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("0.5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("拡張候補キー kubun_ja で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ kubun_ja: "浸水想定区域" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("浸水想定区域");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  // ── unresolvedKeys 記録 ─────────────────────────────────────────────────

  it("属性未解決のとき meta.unresolvedKeys に実キー一覧が入る", () => {
    const { meta } = parseFloodFC(
      fc(feat({ unknown_flood_key: "3m", another_key: "x" }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.unresolvedKeys).toEqual(["unknown_flood_key", "another_key"]);
  });

  it("属性解決済みのとき meta.unresolvedKeys は undefined", () => {
    const { meta } = parseFloodFC(
      fc(feat({ scale: "0.5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.unresolvedKeys).toBeUndefined();
  });

  // ── 拡張候補 B/C/D キー ────────────────────────────────────────────────

  it("国土数値情報キー A31_001 で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ A31_001: "0.5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("0.5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("日本語属性キー 浸水深区分 で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ 浸水深区分: "3m以上5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("3m以上5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("depth_rank で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ depth_rank: "1m以上3m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("1m以上3m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("複数一致・同一属性 depth_ja → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(
        feat({ depth_ja: "3m以上5m未満" }, IN_BOX),
        feat({ depth_ja: "3m以上5m未満" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("3m以上5m未満");
    expect(meta.selectionReason).toBe("multiple matches, same value");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XKT027 parseStormSurgeFC / XKT028 parseTsunamiFC (代表ケースのみ)
// ════════════════════════════════════════════════════════════════════════════

describe("parseStormSurgeFC", () => {
  it("1 件一致・depth_scale あり → 保存", () => {
    const { data, meta } = parseStormSurgeFC(
      fc(feat({ depth_scale: "1m以上3m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.stormSurgeRiskLevel).toBe("1m以上3m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("複数一致・同一値 → 保存", () => {
    const { data, meta } = parseStormSurgeFC(
      fc(
        feat({ depth_scale: "1m以上3m未満" }, IN_BOX),
        feat({ depth_scale: "1m以上3m未満" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.stormSurgeRiskLevel).toBe("1m以上3m未満");
    expect(meta.selectionReason).toBe("multiple matches, same value");
  });
});

describe("parseTsunamiFC", () => {
  it("features 空 → 保存しない", () => {
    const { data } = parseTsunamiFC(fc(), LNG, LAT);
    expect(data.tsunamiRiskLevel).toBeUndefined();
  });

  it("1 件一致・tsunami_scale あり → 保存", () => {
    const { data } = parseTsunamiFC(
      fc(feat({ tsunami_scale: "5m以上10m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.tsunamiRiskLevel).toBe("5m以上10m未満");
  });

  it("複数一致・競合 → 保存しない", () => {
    const { data, meta } = parseTsunamiFC(
      fc(
        feat({ tsunami_scale: "1m以上3m未満" }, IN_BOX),
        feat({ tsunami_scale: "5m以上10m未満" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.tsunamiRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XKT029 parseSedimentFC
// ════════════════════════════════════════════════════════════════════════════

describe("parseSedimentFC", () => {
  it("1 件一致・kubun_id=1 → '土砂災害警戒区域'", () => {
    const { data, meta } = parseSedimentFC(
      fc(feat({ kubun_id: "1" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.sedimentRiskCategory).toBe("土砂災害警戒区域");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("1 件一致・kubun_id=2 → '土砂災害特別警戒区域'", () => {
    const { data } = parseSedimentFC(
      fc(feat({ kubun_id: "2" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.sedimentRiskCategory).toBe("土砂災害特別警戒区域");
  });

  it("1 件一致・属性名なし → 保存しない / explicit value not resolved", () => {
    const { data, meta } = parseSedimentFC(
      fc(feat({}, IN_BOX)),
      LNG, LAT,
    );
    expect(data.sedimentRiskCategory).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.spatialMatchCount).toBe(1);
  });

  it("複数一致・kubun_id が 1 と 2 で競合 → 保存しない", () => {
    const { data, meta } = parseSedimentFC(
      fc(
        feat({ kubun_id: "1" }, IN_BOX),
        feat({ kubun_id: "2" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.sedimentRiskCategory).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });

  it("複数一致・同一 kubun_id → 保存", () => {
    const { data, meta } = parseSedimentFC(
      fc(
        feat({ kubun_id: "2" }, IN_BOX),
        feat({ kubun_id: "2" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.sedimentRiskCategory).toBe("土砂災害特別警戒区域");
    expect(meta.selectionReason).toBe("multiple matches, same value");
  });

  it("features 空 → 保存しない", () => {
    const { data, meta } = parseSedimentFC(fc(), LNG, LAT);
    expect(data.sedimentRiskCategory).toBeUndefined();
    expect(meta.selectionReason).toBe("no features returned");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XKT030 parseRoadFC
// ════════════════════════════════════════════════════════════════════════════

describe("parseRoadFC", () => {
  it("features 空 → 保存しない", () => {
    const { data, meta } = parseRoadFC(fc(), LNG, LAT);
    expect(data.roadType).toBeUndefined();
    expect(data.roadWidth).toBeUndefined();
    expect(meta.selectionReason).toBe("no features returned");
  });

  it("点が外 → 保存しない", () => {
    const { data } = parseRoadFC(
      fc(feat({ road_type_ja: "国道", width_m: "10" }, OUT_BOX)),
      LNG, LAT,
    );
    expect(data.roadType).toBeUndefined();
    expect(data.roadWidth).toBeUndefined();
  });

  it("1 件一致・type と width あり → 両方保存", () => {
    const { data, meta } = parseRoadFC(
      fc(feat({ road_type_ja: "市道", width_m: "8" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.roadType).toBe("市道");
    expect(data.roadWidth).toBe(8);
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.matchedFeatureIndex).toBe(0);
  });

  it("1 件一致・width なし → type のみ保存", () => {
    const { data } = parseRoadFC(
      fc(feat({ road_type_ja: "市道" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.roadType).toBe("市道");
    expect(data.roadWidth).toBeUndefined();
  });

  it("複数一致・type と width が同一 → 両方保存", () => {
    const { data, meta } = parseRoadFC(
      fc(
        feat({ road_type_ja: "国道", width_m: "12" }, IN_BOX),
        feat({ road_type_ja: "国道", width_m: "12" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.roadType).toBe("国道");
    expect(data.roadWidth).toBe(12);
    expect(meta.selectionReason).toBe("multiple matches, same value");
  });

  it("複数一致・type 一致・width 不一致 → type だけ保存", () => {
    const { data, meta } = parseRoadFC(
      fc(
        feat({ road_type_ja: "市道", width_m: "8" },  IN_BOX),
        feat({ road_type_ja: "市道", width_m: "12" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.roadType).toBe("市道");       // type は一致 → 保存
    expect(data.roadWidth).toBeUndefined();  // width は競合 → 保存しない
    expect(meta.selectionReason).toBe(
      "multiple matches, road width conflicted (type saved)",
    );
  });

  it("複数一致・type 不一致・width 一致 → width だけ保存", () => {
    const { data, meta } = parseRoadFC(
      fc(
        feat({ road_type_ja: "国道", width_m: "10" }, IN_BOX),
        feat({ road_type_ja: "市道", width_m: "10" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.roadType).toBeUndefined();   // type は競合 → 保存しない
    expect(data.roadWidth).toBe(10);         // width は一致 → 保存
    expect(meta.selectionReason).toBe(
      "multiple matches, road type conflicted (width saved)",
    );
  });

  it("複数一致・type も width も不一致 → 両方保存しない", () => {
    const { data, meta } = parseRoadFC(
      fc(
        feat({ road_type_ja: "国道", width_m: "8"  }, IN_BOX),
        feat({ road_type_ja: "市道", width_m: "12" }, IN_SMALL),
      ),
      LNG, LAT,
    );
    expect(data.roadType).toBeUndefined();
    expect(data.roadWidth).toBeUndefined();
    expect(meta.selectionReason).toBe("conflicting candidates");
  });

  it("meta に returnedFeatureCount / spatialMatchCount が記録される", () => {
    const { meta } = parseRoadFC(
      fc(
        feat({ road_type_ja: "市道", width_m: "8" }, OUT_BOX), // 外
        feat({ road_type_ja: "国道", width_m: "12" }, IN_BOX), // 内
      ),
      LNG, LAT,
    );
    expect(meta.returnedFeatureCount).toBe(2);
    expect(meta.spatialMatchCount).toBe(1);
    expect(meta.matchedFeatureIndex).toBe(1);
  });
});
