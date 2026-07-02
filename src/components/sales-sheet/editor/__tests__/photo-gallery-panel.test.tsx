/**
 * PhotoGalleryPanel — unit tests（写真管理・計画④）
 * env=node: renderToStaticMarkup は useEffect を実行しないため初期(loading)状態を検証。
 * 対話的な fetch/選択は jsdom 非導入のため対象外（純ヘルパー photoAlt は直接検証）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoGalleryPanel, photoAlt } from "../PhotoGalleryPanel";

describe("photoAlt", () => {
  it("caption 優先、無ければ fileName、両方無ければ undefined", () => {
    expect(photoAlt({ caption: "外観", fileName: "a.jpg" })).toBe("外観");
    expect(photoAlt({ caption: null, fileName: "a.jpg" })).toBe("a.jpg");
    expect(photoAlt({ caption: null, fileName: null })).toBeUndefined();
  });
});

describe("PhotoGalleryPanel — SSR構造", () => {
  it("data-photo-gallery / 見出し / 閉じるボタン / 読み込み中 を描画する", () => {
    const html = renderToStaticMarkup(
      <PhotoGalleryPanel propertyId="p1" onClose={() => {}} onAddPhoto={() => {}} />,
    );
    expect(html).toContain("data-photo-gallery");
    expect(html).toContain("写真を追加");
    expect(html).toContain('aria-label="閉じる"');
    expect(html).toContain("読み込み中"); // useEffect 未実行 = 初期 loading 状態
  });
});
