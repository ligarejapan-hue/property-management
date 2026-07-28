/**
 * 完成待ち一覧の「現地の様子」導線 (ストリートビュー / Google マップ) の検証。
 *
 * 事務所で候補を物件化するか判断するとき、現地の様子を見たい (ユーザー要望 2026-07-28)。
 * ⚠アプリ内に地図やストリートビューを埋め込むと Maps Platform の課金対象になるため、
 *   一般向け Google マップを別タブで開くリンクにしている (リンクは課金されない)。
 *   → 有料 API のホスト (maps.googleapis.com) や API キーがマークアップに
 *     現れないことを回帰テストで固定する。
 *
 * vitest は node 環境のため、表示部分は renderToStaticMarkup で静的描画を検証し、
 * クリック時の取得 (座標の on-demand fetch) はソース静的検証で担保する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CandidatePlaceLinks } from "@/components/field-survey/candidate-queue";

const QUEUE_SRC = readFileSync(
  path.resolve(process.cwd(), "src/components/field-survey/candidate-queue.tsx"),
  "utf-8",
);

function render(lat: number | null, lng: number | null): string {
  return renderToStaticMarkup(createElement(CandidatePlaceLinks, { lat, lng }));
}

describe("CandidatePlaceLinks: 座標があるとき", () => {
  const html = render(35.681236, 139.767125);

  it("ストリートビューと Google マップの 2 本を出す", () => {
    expect(html).toContain('data-testid="candidate-streetview-link"');
    expect(html).toContain('data-testid="candidate-google-map-link"');
    expect(html).toContain("ストリートビュー");
    expect(html).toContain("Googleマップ");
  });

  it("リンク先は一般向け Google マップ (www.google.com) を指す", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      // &amp; にエスケープされるので host 部分で判定する
      expect(href.startsWith("https://www.google.com/maps/")).toBe(true);
    }
    // ストリートビュー = パノラマ / もう一方 = 地図検索
    expect(html).toContain("map_action=pano");
    expect(html).toContain("/maps/search/");
    // 座標は 2 本とも同じ地点
    expect(html.match(/35\.681236(%2C|,)139\.767125/g)?.length).toBe(2);
  });

  it("外部サイトなので新しいタブ + noopener noreferrer で開く", () => {
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(2);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it("有料 API のホストや API キーはマークアップに現れない", () => {
    expect(html).not.toContain("maps.googleapis.com");
    expect(html).not.toContain("googleapis");
    expect(html.toLowerCase()).not.toContain("key=");
    expect(html.toLowerCase()).not.toContain("apikey");
  });

  it("費用の話は画面に出さない (業務画面に費用の話は載せない)", () => {
    expect(html).not.toMatch(/無料|有料|課金|費用/);
  });

  it("座標そのものは文字として見せない (リンクの中でだけ使う)", () => {
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).not.toContain("35.681236");
    expect(text).not.toContain("139.767125");
  });
});

describe("CandidatePlaceLinks: 座標が無い / 使えないとき", () => {
  it("座標が無ければリンクを出さない", () => {
    expect(render(null, null)).toBe("");
    expect(render(35.681236, null)).toBe("");
    expect(render(null, 139.767125)).toBe("");
  });

  it("範囲外の座標でもリンクを出さない (壊れたリンクを見せない)", () => {
    expect(render(91, 139.767125)).toBe("");
    expect(render(35.681236, 181)).toBe("");
    expect(render(Number.NaN, 139.767125)).toBe("");
  });
});

describe("candidate-queue: 座標は押した行だけ取りに行く", () => {
  it("URL 組み立ては共通の純関数を使う (自前で URL を書かない)", () => {
    expect(QUEUE_SRC).toMatch(
      /import \{\s*buildExternalMapUrl,\s*buildStreetViewUrl,\s*\} from "@\/lib\/external-maps-url"/,
    );
    expect(QUEUE_SRC).toMatch(/buildStreetViewUrl\(lat, lng\)/);
    expect(QUEUE_SRC).toMatch(/buildExternalMapUrl\(lat, lng\)/);
    // 有料 API を直に叩く形が紛れ込んでいないこと
    expect(QUEUE_SRC).not.toContain("maps.googleapis.com");
  });

  it("行のボタンを押した時だけ座標のみ射影 API から取得する", () => {
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-place-toggle"/);
    expect(QUEUE_SRC).toMatch(/onClick=\{\(\) => \{\s*void showPlace\(r\.id\);/);
    expect(QUEUE_SRC).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(pinId\)\}\/location/,
    );
    // 一覧の読み直しをまたいだ遅延応答は捨てる (並び順切替と同じ世代ガード)
    const showPlace = QUEUE_SRC.match(
      /const showPlace = useCallback\([\s\S]*?\}, \[\]\);/,
    );
    expect(showPlace).not.toBeNull();
    expect(showPlace?.[0] ?? "").toMatch(
      /generation !== loadGenerationRef\.current/,
    );
    // 取得できた行だけリンクを出す (取れない行はボタンのまま)
    expect(QUEUE_SRC).toMatch(
      /place \? \(\s*<CandidatePlaceLinks lat=\{place\.lat\} lng=\{place\.lng\} \/>/,
    );
  });

  it("座標や失敗理由を console / 画面文言に出さない", () => {
    expect(QUEUE_SRC).not.toMatch(/console\./);
    const failure = QUEUE_SRC.match(
      /data-testid="candidate-place-error"[\s\S]{0,300}/,
    );
    expect(failure?.[0] ?? "").toContain("場所を取得できませんでした");
    expect(failure?.[0] ?? "").not.toMatch(/lat|lng/);
  });

  it("一覧を開いただけでは座標を取りに行かない (他人 pin の監査ログを空撃ちしない)", () => {
    const loadFn = QUEUE_SRC.match(
      /const load = useCallback\([\s\S]*?\}, \[order\]\);/,
    );
    expect(loadFn?.[0] ?? "").not.toMatch(/fetchPinLocation/);
    // 呼び出しはボタン押下 (showPlace) の 1 箇所だけ
    expect((QUEUE_SRC.match(/await fetchPinLocation\(/g) ?? []).length).toBe(1);
  });

  it("一覧を読み直したら取得済み座標も捨てる (前の並びの位置を持ち越さない)", () => {
    const loadFn = QUEUE_SRC.match(
      /const load = useCallback\([\s\S]*?\}, \[order\]\);/,
    );
    expect(loadFn?.[0] ?? "").toMatch(/setPlaceCoords\(new Map\(\)\)/);
    expect(loadFn?.[0] ?? "").toMatch(/setPlaceErrorIds\(new Set\(\)\)/);
  });
});
