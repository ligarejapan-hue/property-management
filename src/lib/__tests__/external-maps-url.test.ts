import { describe, it, expect } from "vitest";
import {
  buildExternalMapUrl,
  buildStreetViewUrl,
} from "../external-maps-url";

// 事務所で候補を物件化するか判断するとき、現地の様子をストリートビューで確認したい
// （ユーザー要望 2026-07-28）。
//
// ⚠アプリ内にストリートビューを埋め込むと Maps Platform の課金対象になる。
// 「余計にお金がかかるのは避けたい」とのことなので、**一般向け Google マップを
// 別タブで開くリンク**にする（リンクは課金されない）。

describe("ストリートビューのリンク（課金されない一般向け Google マップ）", () => {
  it("座標からパノラマを開く公式スキームを組み立てる", () => {
    const url = buildStreetViewUrl(35.681236, 139.767125);
    expect(url).toBe(
      "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=35.681236%2C139.767125",
    );
  });

  it("Maps Platform の有料APIを叩かない（www.google.com へのリンクである）", () => {
    const url = buildStreetViewUrl(35.68, 139.76)!;
    expect(url.startsWith("https://www.google.com/maps/")).toBe(true);
    // 課金対象の API ホストを指していないこと
    expect(url).not.toContain("maps.googleapis.com");
    // APIキーを URL に載せないこと
    expect(url.toLowerCase()).not.toContain("key=");
  });

  it("座標は小数6桁に丸める（0.1m 相当。それ以上は精度の意味が無い）", () => {
    const url = buildStreetViewUrl(35.6812361234, 139.7671259876)!;
    expect(url).toContain("35.681236%2C139.767126");
  });

  it("整数の座標でも桁を揃える", () => {
    expect(buildStreetViewUrl(35, 139)).toContain("35.000000%2C139.000000");
  });

  it("南半球・西経でも組み立てられる", () => {
    expect(buildStreetViewUrl(-33.868, -70.669)).toContain(
      "-33.868000%2C-70.669000",
    );
  });

  it("座標が無い / 範囲外 / 数値でないときはリンクを出さない", () => {
    expect(buildStreetViewUrl(null, 139.76)).toBeNull();
    expect(buildStreetViewUrl(35.68, null)).toBeNull();
    expect(buildStreetViewUrl(undefined, undefined)).toBeNull();
    expect(buildStreetViewUrl(91, 139.76)).toBeNull();
    expect(buildStreetViewUrl(-91, 139.76)).toBeNull();
    expect(buildStreetViewUrl(35.68, 181)).toBeNull();
    expect(buildStreetViewUrl(35.68, -181)).toBeNull();
    expect(buildStreetViewUrl(Number.NaN, 139.76)).toBeNull();
    expect(buildStreetViewUrl(Number.POSITIVE_INFINITY, 139.76)).toBeNull();
  });

  it("境界値（±90 / ±180）は有効", () => {
    expect(buildStreetViewUrl(90, 180)).not.toBeNull();
    expect(buildStreetViewUrl(-90, -180)).not.toBeNull();
  });

  it("Decimal から来た文字列座標でも扱える（Prisma の Decimal 経由）", () => {
    // API 応答では Decimal が文字列で来ることがある
    expect(
      buildStreetViewUrl("35.681236" as unknown as number, "139.767125" as unknown as number),
    ).toContain("35.681236%2C139.767125");
  });
});

describe("一般向け Google マップの地図リンク（ストリートビューが無い場所の代替）", () => {
  it("座標検索の公式スキームを組み立てる", () => {
    expect(buildExternalMapUrl(35.681236, 139.767125)).toBe(
      "https://www.google.com/maps/search/?api=1&query=35.681236%2C139.767125",
    );
  });

  it("不正な座標ではリンクを出さない", () => {
    expect(buildExternalMapUrl(null, null)).toBeNull();
    expect(buildExternalMapUrl(100, 139.76)).toBeNull();
  });
});
