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
        permissionDenied: false,
        onPhotoCaptured: noop,
      }),
    );
    expect(html).toContain('data-testid="camera-first-input"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('capture="environment"');
  });

  it("権限なし確定時は無効 + 権限がない旨の title", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstButton, {
        disabled: true,
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
  // ⚠2026-07-29: これは「現在地が取れなかった時の代替」ではなく**通常の手順**に
  // なった。失敗理由 (notice) を出す口は無くし、次にやることだけを書く。
  it("家の上をタップするよう案内する（固定文）", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, { onCancel: noop }),
    );
    expect(html).toContain("写真を撮りました");
    expect(html).toContain("家の上をタップ");
    expect(html).toContain('data-testid="camera-first-banner"');
  });

  it("失敗理由や技術用語を出さない", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, { onCancel: noop }),
    );
    expect(html).not.toContain("現在地");
    expect(html).not.toMatch(/GPS|geolocation/i);
  });

  it("「撮り直す」ボタンを持つ（写真を捨てる操作だと分かる言葉）", () => {
    const html = renderToStaticMarkup(
      createElement(CameraFirstBanner, { onCancel: noop }),
    );
    expect(html).toContain('data-testid="camera-first-cancel"');
    expect(html).toContain("撮り直す");
  });
});
