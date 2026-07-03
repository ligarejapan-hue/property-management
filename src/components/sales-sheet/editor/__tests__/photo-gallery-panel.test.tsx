/**
 * PhotoGalleryPanel — unit tests（写真管理・計画④）
 * env=node: renderToStaticMarkup は useEffect を実行しないため初期(loading)状態を検証。
 * 対話的な fetch/選択は jsdom 非導入のため対象外（純ヘルパー photoAlt は直接検証）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoGalleryPanel, photoAlt, PhotoGrid } from "../PhotoGalleryPanel";

const galleryPhoto = (over: Record<string, unknown>) => ({
  id: "g1",
  fileUrl: "/uploads/a/1.jpg",
  thumbnailUrl: null,
  fileName: "1.jpg",
  caption: null,
  ...over,
});

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

describe("PhotoGrid — 追加可否（@codex対応）", () => {
  it("data-photo-grid を描画する", () => {
    const html = renderToStaticMarkup(
      <PhotoGrid photos={[galleryPhoto({})]} onPick={() => {}} />,
    );
    expect(html).toContain("data-photo-grid");
  });

  it("/uploads/ の写真は追加可能（disabled でない）", () => {
    const html = renderToStaticMarkup(
      <PhotoGrid photos={[galleryPhoto({ fileUrl: "/uploads/a/1.jpg" })]} onPick={() => {}} />,
    );
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("追加できません");
  });

  it("追加不可（外部URL等）の写真はボタンを無効化する（silent no-op を防ぐ）", () => {
    const html = renderToStaticMarkup(
      <PhotoGrid
        photos={[galleryPhoto({ fileUrl: "https://cdn.example.com/x.jpg" })]}
        onPick={() => {}}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("追加できません");
  });
});
