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
    // 第3弾: 取得の有無は「レイヤーが ON か」から「今回この層を取る計画か」へ
    // (plan.fetch.tracks)。待ち行列を分ける不変条件はそのまま。
    expect(MAP_SRC).toMatch(/const tracksPromise = plan\.fetch\.tracks/);
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

  it("線は全員に見せる（権限で出し分けない）", () => {
    // 発注者判断: 歩いたルートは制限する必要のない情報。二度歩きを避けるのが
    // 目的なので、街を歩く当人が見られないと意味がない。
    expect(MAP_SRC).not.toMatch(/canSeeOtherTracks/);
    // 取得の条件は表示レイヤーの計画だけ(権限による分岐を挟まない)。
    expect(MAP_SRC).toMatch(/const tracksPromise = plan\.fetch\.tracks$/m);
  });
});

describe("3-b. 期間は面と線の共通設定として出す（@codex #334 P2）", () => {
  it("どちらか一方でも ON なら期間セレクタを出す", () => {
    // 面だけ OFF にすると選択肢が消えるのに、線は既定（直近1年）で絞られ
    // 続ける。古い道が出ていないことに気づけない。
    expect(MAP_SRC).toMatch(
      /\{\(layers\.coverage \|\| layers\.tracks\) && \([\s\S]{0,400}?coverage-period-select/,
    );
  });

  it("共通の設定だと分かるように書く", () => {
    expect(MAP_SRC).toMatch(/（色と線の両方）/);
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

  it("点が足りず描けない巡回は「量」と別の文で断る (@codex #334 P2)", () => {
    // 量の断り（寄せるか期間を絞ると出ます）に混ぜると、寄せても出ない
    // 巡回に嘘の案内をすることになる（しかも古い巡回とは限らない）。
    expect(MAP_SRC).toMatch(/data-testid="tracks-unrenderable-notice"/);
    expect(MAP_SRC).toMatch(/tracksUnrenderableTrips > 0/);
    const notice =
      MAP_SRC.match(
        /data-testid="tracks-unrenderable-notice"[\s\S]{0,600}?<\/p>/,
      )?.[0] ?? "";
    expect(notice).toContain("線にできない巡回");
    // 「量が多い」「古い」「全部出ます」を主張しない
    expect(notice).not.toContain("線が多いため");
    expect(notice).not.toContain("古い巡回");
    expect(notice).not.toContain("全部出ます");
    expect(notice).toContain("寄せても出ません");
  });

  it("線の色の意味を説明する（青＝いま巡回中）", () => {
    expect(MAP_SRC).toMatch(/灰色の線＝過去に歩いた道。青い線＝いま巡回中の道。/);
  });
});
