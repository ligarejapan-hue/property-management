/**
 * カメラファースト UI (ボタン / 位置指定待ち banner) の SSR 検証。
 *
 * vitest は node 環境のため renderToStaticMarkup で静的描画を検証する。
 * クリック等のインタラクションはソース静的検証 + レビューで担保。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import CameraFirstButton from "@/components/field-survey/camera-first-button";
import CameraFirstBanner from "@/components/field-survey/camera-first-banner";

const noop = () => {};

describe("CameraFirstButton", () => {
  it("既定状態: 「撮って登録」ラベルで有効", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstButton, {
        disabled: false,
        locating: false,
        permissionDenied: false,
        onPhotoCaptured: noop,
      }),
    );
    expect(html).toContain("撮って登録");
    expect(html).toContain('data-testid="camera-first-button"');
    // disabled 属性そのもの (className の disabled: variant とは別) が無いこと
    expect(html).not.toContain('disabled=""');
  });

  it("カメラ直起動の hidden input (accept=image/* + capture=environment) を持つ", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstButton, {
        disabled: false,
        locating: false,
        permissionDenied: false,
        onPhotoCaptured: noop,
      }),
    );
    expect(html).toContain('data-testid="camera-first-input"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('capture="environment"');
  });

  it("locating 中は「現在地を取得中…」表示で無効", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstButton, {
        disabled: true,
        locating: true,
        permissionDenied: false,
        onPhotoCaptured: noop,
      }),
    );
    expect(html).toContain("現在地を取得中");
    expect(html).toContain('disabled=""');
  });

  it("権限なし確定時は無効 + 権限がない旨の title", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstButton, {
        disabled: true,
        locating: false,
        permissionDenied: true,
        onPhotoCaptured: noop,
      }),
    );
    expect(html).toContain('disabled=""');
    // title だけでなく可視テキストでも理由を出す (スマホは tooltip が出ない)
    expect(html).toContain('data-testid="camera-first-permission-note"');
    expect(html).toContain("ピン追加の権限がありません。");
  });
});

describe("CameraFirstBanner", () => {
  it("notice なし: 既定の地図タップ誘導文を表示", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, { notice: null, onCancel: noop }),
    );
    expect(html).toContain("写真を撮りました");
    expect(html).toContain("地図をタップ");
    expect(html).toContain('data-testid="camera-first-banner"');
  });

  it("notice あり: フォールバック理由の文言をそのまま表示", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, {
        notice:
          "現在地の取得がタイムアウトしました。地図をタップして、撮った場所を指定してください。",
        onCancel: noop,
      }),
    );
    expect(html).toContain("タイムアウト");
  });

  it("「やり直す」ボタンを持つ", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, { notice: null, onCancel: noop }),
    );
    expect(html).toContain('data-testid="camera-first-cancel"');
    expect(html).toContain("やり直す");
  });
});
