/**
 * 地図の「現在地へ移動」FAB — SSR 描画とソース制約の検証。
 *
 * vitest は node 環境のため renderToStaticMarkup で静的描画を見る。
 * クリック後の挙動 (単発取得 / 記録中は取り直さない) は純関数側
 * (field-survey-map-recenter.test.ts) とソース静的検証で担保する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import fs from "node:fs";
import path from "node:path";
import MapRecenterButton from "@/components/field-survey/map-recenter-button";

const noop = () => {};

const BUTTON_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    "src/components/field-survey/map-recenter-button.tsx",
  ),
  "utf-8",
);
const MAP_SRC = fs.readFileSync(
  path.join(process.cwd(), "src/components/field-survey/field-survey-map.tsx"),
  "utf-8",
);

describe("MapRecenterButton — 描画", () => {
  it("アイコンだけのボタンだが、用途は aria-label と title で伝える", () => {
    const html = renderToStaticMarkup(
      createElement(MapRecenterButton, {
        livePosition: null,
        onRecenter: noop,
      }),
    );
    expect(html).toContain('data-testid="map-recenter-button"');
    expect(html).toContain('aria-label="現在地へ移動"');
    expect(html).toContain('title="現在地へ移動"');
    // ボタン面には文字を置かない
    const inner = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "";
    expect(inner.replace(/<[^>]*>/g, "").trim()).toBe("");
  });

  it("既定は押せる (取得中だけ disabled になる)", () => {
    const html = renderToStaticMarkup(
      createElement(MapRecenterButton, {
        livePosition: null,
        onRecenter: noop,
      }),
    );
    expect(html).not.toContain('disabled=""');
  });

  it("⚠受け取った座標を画面に出さない", () => {
    const html = renderToStaticMarkup(
      createElement(MapRecenterButton, {
        livePosition: { lat: 35.68123, lng: 139.76712 },
        onRecenter: noop,
      }),
    );
    expect(html).not.toContain("35.68");
    expect(html).not.toContain("139.76");
  });

  it("右下ではなく左下に置く (右下は Google 既定 UI が使う)", () => {
    const html = renderToStaticMarkup(
      createElement(MapRecenterButton, {
        livePosition: null,
        onRecenter: noop,
      }),
    );
    expect(html).toMatch(/class="[^"]*left-3[^"]*"/);
    expect(html).not.toMatch(/class="[^"]*right-3[^"]*"/);
  });
});

describe("MapRecenterButton — 位置情報の扱い (ソース制約)", () => {
  // ⚠コメントでの言及は許容し、**実行コードの形**だけを見る
  // (既存の field-survey-pin-ui-source.test.ts と同じ方針)。
  it("単発取得だけ。watchPosition は張らない", () => {
    expect(BUTTON_SRC).toMatch(/geo\.getCurrentPosition\(/);
    expect(BUTTON_SRC).not.toMatch(/\.watchPosition\(/);
  });

  it("⚠座標を保存しない (storage を使わない)", () => {
    expect(BUTTON_SRC).not.toMatch(
      /localStorage\.|sessionStorage\.|indexedDB\./i,
    );
  });

  it("⚠座標を送信しない (fetch しない)", () => {
    expect(BUTTON_SRC).not.toMatch(/\bfetch\s*\(/);
  });

  it("⚠座標を console に出さない", () => {
    expect(BUTTON_SRC).not.toMatch(/console\.\w+\(/);
  });

  it("ブラウザ由来のエラー文言を素通ししない (code から自前の文言に写す)", () => {
    expect(BUTTON_SRC).not.toMatch(/err\??\.message/);
    expect(BUTTON_SRC).toMatch(/describeGeolocationError\(err\?\.code/);
  });

  it("unmount 後に setState しない", () => {
    expect(BUTTON_SRC).toMatch(/mountedRef\.current = false/);
    expect(BUTTON_SRC).toMatch(/if \(!mountedRef\.current\) return/);
  });
});

describe("field-survey-map.tsx との結線", () => {
  it("地図側は位置を取りに行かない (取得はボタンに閉じる)", () => {
    // 既存の表明 (field-survey-pin-ui-source.test.ts) と同じ不変条件を、
    // この機能を足した側でも見張る。
    expect(MAP_SRC).not.toMatch(/getCurrentPosition/);
  });

  it("FAB を常設し、記録中の位置だけを渡す", () => {
    expect(MAP_SRC).toMatch(/<MapRecenterButton/);
    expect(MAP_SRC).toMatch(/livePosition=\{recenterLivePosition\}/);
    // 記録中以外は null にして古い座標へ寄せない
    expect(MAP_SRC).toMatch(
      /recenterLivePosition[\s\S]{0,200}recorder\.status === "recording"/,
    );
  });

  it("⚠表示切替パネルを開いていても消さない (常に押せる)", () => {
    // 他の FAB は panelOpen で描画を止めるが、この FAB は左端でパネル(右)と
    // 重ならないため条件を付けない。付けると「パネルを開くと消える」に戻る。
    const m = MAP_SRC.match(/<MapRecenterButton[\s\S]{0,200}?\/>/)?.[0] ?? "";
    expect(m).not.toBe("");
    const before = MAP_SRC.slice(
      Math.max(0, MAP_SRC.indexOf(m) - 120),
      MAP_SRC.indexOf(m),
    );
    expect(before).not.toMatch(/!panelOpen\s*&&\s*$/);
  });
});
