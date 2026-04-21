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

  // ── 実観測キー (2026-04-21) ───────────────────────────────────────────────

  it("実観測キー liquefaction_tendency_level で値解決 → 保存", () => {
    const { data, meta } = parseLiquefactionFC(
      fc(feat({ liquefaction_tendency_level: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBe("高い");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("実観測の非候補キー（topographic_classification_name_ja 等）のみ → 未解決のまま", () => {
    // _id/_index/topographic_*/mesh_code/note は値候補に含めない
    const { data, meta } = parseLiquefactionFC(
      fc(feat({
        _id: "abc",
        _index: "0",
        topographic_classification_name_ja: "低地",
        mesh_code: "12345",
        note: "",
        topographic_classification_code: "1",
      }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.liquefactionRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
  });

  // ── unresolvedKeyValues 記録（observability 強化） ────────────────────────

  it("未解決時 meta.unresolvedKeyValues に primitive key→value が入る", () => {
    const { meta } = parseLiquefactionFC(
      fc(feat({
        _id: "abc",
        topographic_classification_name_ja: "低地",
        mesh_code: "12345",
      }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.unresolvedKeyValues).toEqual({
      _id: "abc",
      topographic_classification_name_ja: "低地",
      mesh_code: "12345",
    });
  });

  it("未解決時 非 primitive 値（object/array）は unresolvedKeyValues に含まれない", () => {
    const { meta } = parseLiquefactionFC(
      fc(feat({
        some_str: "値",
        nested_obj: { foo: "bar" },
        arr: [1, 2, 3],
      }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.unresolvedKeyValues).toEqual({ some_str: "値" });
    expect(meta.unresolvedKeyValues).not.toHaveProperty("nested_obj");
    expect(meta.unresolvedKeyValues).not.toHaveProperty("arr");
  });

  it("未解決時 長い文字列は 200 文字で打ち切り", () => {
    const longValue = "あ".repeat(250);
    const { meta } = parseLiquefactionFC(
      fc(feat({ long_field: longValue }, IN_BOX)),
      LNG, LAT,
    );
    const stored = meta.unresolvedKeyValues?.long_field as string;
    expect(stored.length).toBeLessThan(longValue.length);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("解決済みのとき meta.unresolvedKeyValues は undefined", () => {
    const { meta } = parseLiquefactionFC(
      fc(feat({ rank_ja: "高い" }, IN_BOX)),
      LNG, LAT,
    );
    expect(meta.selectionReason).toBe("unique spatial match");
    expect(meta.unresolvedKeyValues).toBeUndefined();
  });

  // ── production 経路回帰: JSON 往復後も unresolvedKeyValues が残る ────────────
  it("JSON.stringify → JSON.parse 後も unresolvedKeyValues が保持される（DB 保存経路の再現）", () => {
    // 候補キーに一致しない実観測のメタ項目のみ使用（解決されないことを確認）
    const { meta } = parseLiquefactionFC(
      fc(feat({
        topographic_classification_name_ja: "低地",
        topographic_classification_code: "1",
        mesh_code: "12345",
      }, IN_BOX)),
      LNG, LAT,
    );
    // まず meta に値があること
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.unresolvedKeyValues).toBeDefined();

    // JSON 往復（fetch-investigation.ts の JSON.parse(JSON.stringify(result)) 相当）
    const roundTripped = JSON.parse(JSON.stringify({ meta })) as { meta: typeof meta };
    expect(roundTripped.meta.unresolvedKeyValues).toBeDefined();
    expect(roundTripped.meta.unresolvedKeyValues).toEqual(meta.unresolvedKeyValues);
    // meta オブジェクトの own property として存在すること（スプレッド経由でも direct 代入でも同じ）
    expect(Object.prototype.hasOwnProperty.call(roundTripped.meta, "unresolvedKeyValues")).toBe(true);
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

  // ── 実観測キー (2026-04-21) ───────────────────────────────────────────────

  it("実観測キー A31a_201 で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ A31a_201: "0.5m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("0.5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("実観測キー A31a_202 で値解決 → 保存", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ A31a_202: "1m以上3m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("1m以上3m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("A31a_201 と A31a_202 が同時存在 → A31a_201 を採用（先頭優先）", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ A31a_201: "0.5m未満", A31a_202: "1m以上3m未満" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBe("0.5m未満");
    expect(meta.selectionReason).toBe("unique spatial match");
  });

  it("実観測の非候補キー（_id/_index のみ）→ 未解決のまま", () => {
    const { data, meta } = parseFloodFC(
      fc(feat({ _id: "abc", _index: "0" }, IN_BOX)),
      LNG, LAT,
    );
    expect(data.floodRiskLevel).toBeUndefined();
    expect(meta.selectionReason).toBe("explicit value not resolved");
    expect(meta.unresolvedKeys).toEqual(["_id", "_index"]);
  });

  // ── unresolvedKeyValues 記録（observability 強化） ────────────────────────

  it("未解決時 meta.unresolvedKeyValues に実値が入る（XKT026 洪水）", () => {
    const { meta } = parseFloodFC(
      fc(feat({ A31a_201: "0.5m未満", _id: "xyz", _index: "1" }, IN_BOX)),
      LNG, LAT,
    );
    // A31a_201 は候補キーなので解決されるはずだが、もし未知キーのみなら観測できる
    // このテストは「未知キーのみの場合」を確認する
    const { meta: metaUnresolved } = parseFloodFC(
      fc(feat({ _id: "xyz", _index: "1", unknown_flood: "some_value" }, IN_BOX)),
      LNG, LAT,
    );
    expect(metaUnresolved.selectionReason).toBe("explicit value not resolved");
    expect(metaUnresolved.unresolvedKeyValues).toEqual({
      _id: "xyz",
      _index: "1",
      unknown_flood: "some_value",
    });
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

// ════════════════════════════════════════════════════════════════════════════
// provider meta pipeline 回帰テスト
// parse 関数 → ProviderResponse.meta → index.ts providerDetails →
// fetch-investigation.ts JSON.parse(JSON.stringify(result)) の全経路で
// unresolvedKeyValues が保持されることを保証する。
// ════════════════════════════════════════════════════════════════════════════

describe("provider meta pipeline 回帰テスト (unresolvedKeyValues DB保存経路)", () => {
  it("XKT025 未解決 → providerMeta.liquefaction → JSON 往復後も unresolvedKeyValues が消えない", () => {
    // 候補キーに一致しない fixture。liquefaction_tendency_level は null → pickStr がスキップ。
    const { meta: liqMeta } = parseLiquefactionFC(
      fc(feat({
        topographic_classification_name_ja: "沖積低地",
        topographic_classification_code: "1",
        mesh_code: "53395611",
        note: null,
        liquefaction_tendency_level: null,
      }, IN_BOX)),
      LNG, LAT,
    );

    expect(liqMeta.selectionReason).toBe("explicit value not resolved");
    expect(liqMeta.unresolvedKeyValues).toBeDefined();

    // ReinfilibProvider.fetch() が組み立てる ProviderResponse.meta を再現
    const providerMeta: Record<string, unknown> = {
      normalizedAddress: "東京都テスト市",
      geocodedLat: LAT,
      geocodedLng: LNG,
      geocodeSource: "gsi",
      zoom: 15,
      tileX: 58176,
      tileY: 25792,
      liquefaction: liqMeta,
    };

    // index.ts が組み立てる MergedInvestigationResult.providers[] を再現
    const providerDetail = {
      name: "reinfolib",
      status: "success" as const,
      source: "国土交通省 不動産情報ライブラリ",
      fields: [] as string[],
      meta: providerMeta,
    };

    // fetch-investigation.ts の JSON.parse(JSON.stringify(result)) を再現
    const result = {
      status: "success" as const,
      data: {},
      providers: [providerDetail],
      fetchedAt: new Date().toISOString(),
    };
    const rawPayloadJson = JSON.parse(JSON.stringify(result)) as typeof result;

    const savedMeta = rawPayloadJson.providers[0].meta as Record<string, unknown>;
    const savedLiq = savedMeta.liquefaction as typeof liqMeta;

    expect(savedLiq.selectionReason).toBe("explicit value not resolved");
    expect(Object.prototype.hasOwnProperty.call(savedLiq, "unresolvedKeyValues")).toBe(true);
    expect(savedLiq.unresolvedKeyValues).toBeDefined();
    expect(Object.keys(savedLiq.unresolvedKeyValues!).length).toBeGreaterThan(0);
    expect(savedLiq.unresolvedKeyValues).toHaveProperty("note", null);
    expect(savedLiq.unresolvedKeyValues).toHaveProperty(
      "topographic_classification_name_ja",
      "沖積低地",
    );
  });

  it("XKT026 未解決 → providerMeta.flood → JSON 往復後も unresolvedKeyValues が消えない", () => {
    const { meta: floodMeta } = parseFloodFC(
      fc(feat({
        _id: "abc123",
        _index: "0",
        unknown_flood_attr: "some_value",
      }, IN_BOX)),
      LNG, LAT,
    );

    expect(floodMeta.selectionReason).toBe("explicit value not resolved");
    expect(floodMeta.unresolvedKeyValues).toBeDefined();

    const providerMeta: Record<string, unknown> = { flood: floodMeta };
    const result = {
      status: "success" as const,
      data: {},
      providers: [{ name: "reinfolib", status: "success" as const, source: "", fields: [] as string[], meta: providerMeta }],
      fetchedAt: "",
    };
    const rawPayloadJson = JSON.parse(JSON.stringify(result)) as typeof result;

    const savedMeta = rawPayloadJson.providers[0].meta as Record<string, unknown>;
    const savedFlood = savedMeta.flood as typeof floodMeta;

    expect(Object.prototype.hasOwnProperty.call(savedFlood, "unresolvedKeyValues")).toBe(true);
    expect(savedFlood.unresolvedKeyValues).toHaveProperty("_id", "abc123");
    expect(savedFlood.unresolvedKeyValues).toHaveProperty("unknown_flood_attr", "some_value");
  });
});
