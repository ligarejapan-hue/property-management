/**
 * 歩いた道筋（線）の地図表示まわりの配線固定。
 *
 * ユーザー指摘 2026-07-29「以前のシステムは線で表示されていた」。
 * 面（マス）の色だけでは、マスが道より広く点の間もつながないので、
 * 実際に歩いた筋が出ない。面と線は**併用**する。
 *
 * vitest は env=node（jsdom 無）のためソース文字列で形を固定する。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const LAYER_SRC = read("src/components/field-survey/coverage-tracks-layer.tsx");
const ROUTE_SRC = read("src/components/field-survey/route-polyline.tsx");
const HEAT_SRC = read("src/components/field-survey/coverage-heat-layer.tsx");

describe("1. 線の層", () => {
  it("巡回ごとに 1 本の Polyline を作る（全部を1本につなげない）", () => {
    // 1本にまとめると、ある巡回の終点と次の巡回の始点が直線で結ばれ、
    // 誰も通っていない道を横切る線が描かれる。
    expect(LAYER_SRC).toMatch(/for \(const path of paths\)/);
    expect(LAYER_SRC).toMatch(/new Polyline\(\{/);
  });

  it("点が1つの巡回は描かない", () => {
    expect(LAYER_SRC).toMatch(/line\.length >= 2/);
  });

  it("地図タップを奪わない（ピンを置く操作が止まる）", () => {
    expect(LAYER_SRC).toMatch(/clickable: false/);
  });

  it("OFF なら 1 本も描かない", () => {
    expect(LAYER_SRC).toMatch(/if \(!visible\) return;/);
  });

  it("地図から外すまで後始末する（切替のたびに線が積み上がらない）", () => {
    const cleanup =
      LAYER_SRC.match(/return \(\) => \{[\s\S]{0,300}?\};/)?.[0] ?? "";
    expect(cleanup).toContain("setMap(null)");
    expect(cleanup).toContain("polylinesRef.current = []");
  });

  it("座標を console に出さない", () => {
    expect(LAYER_SRC).not.toMatch(/console\./);
  });
});

describe("2. 重なり順（今日の線が埋もれない）", () => {
  it("面 0 → 過去の線 1 → 今日の線 2 の順に上へ来る", () => {
    const heatZ = Number(HEAT_SRC.match(/zIndex:\s*(\d+)/)?.[1] ?? -1);
    const trackZ = Number(LAYER_SRC.match(/zIndex:\s*(\d+)/)?.[1] ?? -1);
    const todayZ = Number(ROUTE_SRC.match(/zIndex:\s*(\d+)/)?.[1] ?? -1);
    expect(heatZ).toBe(0);
    expect(trackZ).toBeGreaterThan(heatZ);
    expect(todayZ).toBeGreaterThan(trackZ);
  });

  it("過去の線は今日の線より細く薄い", () => {
    const trackWeight = Number(
      LAYER_SRC.match(/strokeWeight:\s*([\d.]+)/)?.[1] ?? 0,
    );
    const trackOpacity = Number(
      LAYER_SRC.match(/strokeOpacity:\s*([\d.]+)/)?.[1] ?? 0,
    );
    const todayWeight = Number(
      ROUTE_SRC.match(/strokeWeight:\s*([\d.]+)/)?.[1] ?? 0,
    );
    const todayOpacity = Number(
      ROUTE_SRC.match(/strokeOpacity:\s*([\d.]+)/)?.[1] ?? 0,
    );
    expect(trackWeight).toBeLessThan(todayWeight);
    expect(trackOpacity).toBeLessThan(todayOpacity);
  });
});

describe("3. 地図側の配線", () => {
  it("線は既定 ON（以前の画面が線だったため）", () => {
    expect(MAP_SRC).toMatch(/tracks: true,/);
  });

  it("面とは別に切り替えられる", () => {
    expect(MAP_SRC).toMatch(/"properties" \| "pins" \| "coverage" \| "tracks"/);
    expect(MAP_SRC).toMatch(/data-testid="tracks-layer-toggle"/);
  });

  it("面と同じ範囲・同じ期間で問い合わせる（色と線が食い違わない）", () => {
    const req =
      MAP_SRC.match(
        /"\/api\/field-survey\/coverage\/tracks\?"[\s\S]{0,500}?\}\)\.toString\(\)/,
      )?.[0] ?? "";
    expect(req).toContain("days: String(coverageDays)");
    expect(req).toContain("north: String(b.north)");
  });

  it("線の取得は面・物件・ピンと待ち行列を分ける（重い方が軽い方を止めない）", () => {
    // Promise.all に混ぜない。
    expect(MAP_SRC).toMatch(/const tracksPromise = layers\.tracks/);
    const all = MAP_SRC.match(/await Promise\.all\(tasks\)/);
    expect(all).not.toBeNull();
    expect(MAP_SRC).not.toMatch(/tasks\.push\([\s\S]{0,80}coverage\/tracks/);
  });

  it("通信失敗・範囲過大では古い線を消す", () => {
    // 古い線が残ると、そこを歩いたのが今の範囲の話だと誤読される。
    const occurrences = MAP_SRC.match(/setTrackLines\(\[\]\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
    expect(MAP_SRC).toMatch(/status: "unavailable",[\s\S]{0,80}droppedTrips: 0/);
    expect(MAP_SRC).toMatch(/status: "too-wide",[\s\S]{0,80}droppedTrips: 0/);
  });

  it("他の担当者の記録を見る権限が無ければ問い合わせない (@codex #334 P1)", () => {
    // 403 を叩き続けない。行そのものも出さない（押せない項目を置かない）。
    expect(MAP_SRC).toMatch(/layers\.tracks && canSeeOtherTracks/);
    expect(MAP_SRC).toMatch(/\{canSeeOtherTracks && \(/);
    // 権限の判定は既存のピン凡例と同じ read_all / manage を使い回す
    expect(MAP_SRC).toMatch(/canSeeOtherTracks=\{canSeeOtherPins\}/);
  });
});

describe("4. 黙って減らさない", () => {
  it("落とした巡回があれば本数を出す", () => {
    expect(MAP_SRC).toMatch(/data-testid="tracks-dropped-notice"/);
    expect(MAP_SRC).toMatch(/tracksDroppedTrips > 0/);
    expect(MAP_SRC).toMatch(/古い巡回 \{tracksDroppedTrips\}/);
  });

  it("正確に数えられない時は「件以上」と言う (@codex #334 P2)", () => {
    // 候補の上限を超えた分は本数が分からない。「1件だけ足りない」と出すと、
    // 実際は何十件も欠けているのにほぼ完全に見えてしまう。
    expect(MAP_SRC).toMatch(/tracksDroppedTripsExact \? " 件" : " 件以上"/);
  });

  it("取得できなかった時は「線が無い＝歩いていない」ではないと明言する", () => {
    expect(MAP_SRC).toMatch(/data-testid="tracks-unavailable-notice"/);
    expect(MAP_SRC).toMatch(/線が無い場所も、通っている可能性があります/);
  });

  it("線の色の意味を説明する（青＝いま巡回中）", () => {
    expect(MAP_SRC).toMatch(/灰色の線＝過去に歩いた道。青い線＝いま巡回中の道。/);
  });
});
