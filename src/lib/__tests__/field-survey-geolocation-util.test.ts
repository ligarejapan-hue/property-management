/**
 * Phase 1-F-2 位置記録 helper の単体テスト。
 *
 * - normalizePosition の範囲外 / NaN / accuracy 上限処理
 * - shouldAcceptCandidate の 5m / 10s ルール
 * - shouldFlushNow の件数 / 時間 / 二重送信抑止
 * - nextSequence / isLowAccuracy / describeGeolocationError
 */
import { describe, it, expect } from "vitest";
import {
  FIELD_SURVEY_ACCURACY_WARN_M,
  FIELD_SURVEY_FLUSH_BATCH_SIZE,
  FIELD_SURVEY_FLUSH_INTERVAL_MS,
  FIELD_SURVEY_MAX_ACCURACY_M,
  FIELD_SURVEY_MIN_INTERVAL_MS,
  FIELD_SURVEY_MIN_MOVE_METERS,
  describeGeolocationError,
  haversineMeters,
  isLowAccuracy,
  maxSequenceFromBuffer,
  nextSequence,
  normalizePosition,
  shouldAcceptCandidate,
  shouldFlushNow,
} from "@/lib/field-survey-geolocation-util";

const NOW = 1_700_000_000_000;

function pos(
  lat: unknown,
  lng: unknown,
  accuracy: unknown = 10,
  timestamp: unknown = NOW,
) {
  return { coords: { latitude: lat, longitude: lng, accuracy }, timestamp };
}

describe("normalizePosition", () => {
  it("有効な座標を sequence/accuracy 込みで返す", () => {
    const r = normalizePosition(pos(35.6812, 139.7671, 12.5), 7, NOW);
    expect(r).not.toBeNull();
    expect(r!.sequence).toBe(7);
    expect(r!.lat).toBe(35.6812);
    expect(r!.lng).toBe(139.7671);
    expect(r!.accuracy).toBe(12.5);
    expect(r!.recordedAt).toBe(new Date(NOW).toISOString());
  });

  it("NaN / Infinity / 範囲外 lat/lng は null", () => {
    expect(normalizePosition(pos(NaN, 0), 0, NOW)).toBeNull();
    expect(normalizePosition(pos(0, Infinity), 0, NOW)).toBeNull();
    expect(normalizePosition(pos(91, 0), 0, NOW)).toBeNull();
    expect(normalizePosition(pos(0, 181), 0, NOW)).toBeNull();
    expect(normalizePosition(pos(-90.1, 0), 0, NOW)).toBeNull();
    expect(normalizePosition(pos(0, -180.1), 0, NOW)).toBeNull();
  });

  it("numeric string lat/lng も受理する (Decimal シリアライズ防御)", () => {
    const r = normalizePosition(pos("35.6", "139.7", "8.0"), 0, NOW);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(35.6);
    expect(r!.lng).toBeCloseTo(139.7);
    expect(r!.accuracy).toBeCloseTo(8.0);
  });

  it("accuracy が MAX 超なら undefined にする (棄却しない)", () => {
    const r = normalizePosition(
      pos(35.0, 139.0, FIELD_SURVEY_MAX_ACCURACY_M + 1),
      1,
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r!.accuracy).toBeUndefined();
  });

  it("accuracy 負値 / NaN は undefined", () => {
    expect(normalizePosition(pos(0, 0, -1), 0, NOW)!.accuracy).toBeUndefined();
    expect(normalizePosition(pos(0, 0, NaN), 0, NOW)!.accuracy).toBeUndefined();
  });

  it("timestamp が無効なら now() を使う", () => {
    const r = normalizePosition(pos(0, 0, 10, "abc"), 0, NOW);
    expect(r!.recordedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("shouldAcceptCandidate", () => {
  const base = { lat: 35.0, lng: 139.0, recordedAtMs: NOW };

  it("prev が null なら受理 (初点)", () => {
    expect(shouldAcceptCandidate(null, base)).toBe(true);
  });

  it("5m 以上移動なら受理", () => {
    // 0.0001 度 ≒ 11m (緯度方向)
    const next = { ...base, lat: 35.0001, recordedAtMs: NOW + 1000 };
    expect(shouldAcceptCandidate(base, next)).toBe(true);
  });

  it("5m 未満かつ 10s 未満は棄却", () => {
    const next = { ...base, lat: 35.00001, recordedAtMs: NOW + 1000 };
    expect(shouldAcceptCandidate(base, next)).toBe(false);
  });

  it("5m 未満でも 10s 経過なら受理", () => {
    const next = {
      ...base,
      lat: 35.00001,
      recordedAtMs: NOW + FIELD_SURVEY_MIN_INTERVAL_MS,
    };
    expect(shouldAcceptCandidate(base, next)).toBe(true);
  });

  it("accuracy が MAX_ACCURACY_M 超は問答無用で棄却", () => {
    const next = {
      ...base,
      lat: 36.0,
      recordedAtMs: NOW + 100000,
      accuracy: FIELD_SURVEY_MAX_ACCURACY_M + 1,
    };
    expect(shouldAcceptCandidate(base, next)).toBe(false);
  });

  it("デフォルト閾値が定数と一致", () => {
    expect(FIELD_SURVEY_MIN_MOVE_METERS).toBe(5);
    expect(FIELD_SURVEY_MIN_INTERVAL_MS).toBe(10_000);
  });
});

describe("shouldFlushNow", () => {
  it("buffer が空なら flush しない", () => {
    expect(shouldFlushNow({ length: 0 }, null, NOW)).toBe(false);
  });

  it("buffer 件数が batch size 以上なら flush", () => {
    expect(
      shouldFlushNow({ length: FIELD_SURVEY_FLUSH_BATCH_SIZE }, NOW, NOW),
    ).toBe(true);
  });

  it("lastFlushAt が null かつ 1 件以上で flush (初送)", () => {
    expect(shouldFlushNow({ length: 1 }, null, NOW)).toBe(true);
  });

  it("INTERVAL_MS 経過で flush", () => {
    expect(
      shouldFlushNow(
        { length: 1 },
        NOW - FIELD_SURVEY_FLUSH_INTERVAL_MS,
        NOW,
      ),
    ).toBe(true);
  });

  it("INTERVAL_MS 未満かつ件数小なら flush しない", () => {
    expect(shouldFlushNow({ length: 1 }, NOW - 1000, NOW)).toBe(false);
  });

  it("isFlushing=true なら二重送信を抑止", () => {
    expect(shouldFlushNow({ length: 50 }, null, NOW, undefined, true)).toBe(
      false,
    );
  });
});

describe("maxSequenceFromBuffer (Codex P2 fix 1)", () => {
  it("空配列は null", () => {
    expect(maxSequenceFromBuffer([])).toBeNull();
  });

  it("単一 entry はその sequence", () => {
    expect(maxSequenceFromBuffer([{ sequence: 7 }])).toBe(7);
  });

  it("複数 entry は最大値", () => {
    expect(
      maxSequenceFromBuffer([
        { sequence: 3 },
        { sequence: 10 },
        { sequence: 5 },
      ]),
    ).toBe(10);
  });

  it("非有限 / 負 / 非 number は無視", () => {
    const buf: { sequence: number }[] = [
      { sequence: NaN },
      { sequence: Infinity },
      { sequence: -1 },
      { sequence: 0 },
      { sequence: 4 },
    ];
    expect(maxSequenceFromBuffer(buf)).toBe(4);
  });

  it("全て無効値なら null", () => {
    expect(
      maxSequenceFromBuffer([{ sequence: NaN }, { sequence: -1 }]),
    ).toBeNull();
  });

  it("nextSequence と組み合わせて max(serverNext, bufferNext) を組める", () => {
    const buf = [{ sequence: 12 }];
    const serverLast = 10;
    const serverNext = nextSequence(serverLast); // 11
    const bufferNext = nextSequence(maxSequenceFromBuffer(buf)); // 13
    expect(Math.max(serverNext, bufferNext)).toBe(13);
  });

  it("buffer 空 + server lastSequence のみでも 0 から壊れない", () => {
    const bufferMax = maxSequenceFromBuffer([]);
    const bufferNext = nextSequence(bufferMax); // 0
    const serverNext = nextSequence(null); // 0
    expect(Math.max(serverNext, bufferNext)).toBe(0);
  });
});

describe("nextSequence", () => {
  it("null / undefined / 非有限 / 負は 0 から開始", () => {
    expect(nextSequence(null)).toBe(0);
    expect(nextSequence(undefined)).toBe(0);
    expect(nextSequence(NaN)).toBe(0);
    expect(nextSequence(-1)).toBe(0);
  });

  it("整数 n は n+1", () => {
    expect(nextSequence(0)).toBe(1);
    expect(nextSequence(99)).toBe(100);
  });

  it("小数は floor + 1 (API は int)", () => {
    expect(nextSequence(3.9)).toBe(4);
  });
});

describe("isLowAccuracy", () => {
  it("undefined / NaN は警告しない", () => {
    expect(isLowAccuracy(undefined)).toBe(false);
    expect(isLowAccuracy(NaN)).toBe(false);
  });

  it("デフォルト閾値 (100m) 超で警告", () => {
    expect(isLowAccuracy(FIELD_SURVEY_ACCURACY_WARN_M)).toBe(false);
    expect(isLowAccuracy(FIELD_SURVEY_ACCURACY_WARN_M + 0.1)).toBe(true);
  });
});

describe("haversineMeters", () => {
  it("同一点は 0", () => {
    expect(haversineMeters({ lat: 35, lng: 139 }, { lat: 35, lng: 139 })).toBe(
      0,
    );
  });

  it("1 度差 ≒ 約 111km (緯度方向)", () => {
    const d = haversineMeters({ lat: 35, lng: 139 }, { lat: 36, lng: 139 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("非有限入力は 0", () => {
    expect(haversineMeters({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });
});

describe("describeGeolocationError", () => {
  it("code 1 は permission denied 文言", () => {
    expect(describeGeolocationError({ code: 1 })).toMatch(/拒否|許可/);
  });
  it("code 2 は unavailable 文言", () => {
    expect(describeGeolocationError({ code: 2 })).toMatch(/取得できません|GPS/);
  });
  it("code 3 は timeout 文言", () => {
    expect(describeGeolocationError({ code: 3 })).toMatch(/タイムアウト/);
  });
  it("不明 code は汎用文言で lat/lng/AIza を含めない", () => {
    const msg = describeGeolocationError({ code: 99 });
    expect(msg).not.toMatch(/lat|lng|AIza/i);
  });
  it("null / 不正値は汎用文言", () => {
    expect(describeGeolocationError(null)).toMatch(/失敗/);
    expect(describeGeolocationError(undefined)).toMatch(/失敗/);
  });
});
