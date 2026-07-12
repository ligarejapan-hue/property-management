/**
 * PhotoGalleryPanel — unit tests（写真管理・計画④、ローカルアップロード導線・plan-2026-07-12）
 * env=node: renderToStaticMarkup は useEffect を実行しないため初期(loading)状態を検証。
 * 対話的な fetch/選択は jsdom 非導入のため対象外（純ヘルパー photoAlt / uploadPhotoFiles は直接検証）。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoGalleryPanel, photoAlt, PhotoGrid, uploadPhotoFiles } from "../PhotoGalleryPanel";

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

  it("ローカルアップロード用の FilePickerButton(複数選択可・image/*)を描画する", () => {
    const html = renderToStaticMarkup(
      <PhotoGalleryPanel propertyId="p1" onClose={() => {}} onAddPhoto={() => {}} />,
    );
    expect(html).toContain("data-file-picker");
    expect(html).toContain("写真をアップロード");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("multiple");
    expect(html).toContain("JPEG/PNG/WebP・1枚8MBまで・複数可");
    // 初期状態(uploading=false・uploadError=null)ではアップロード中表示やエラーは出ない
    expect(html).not.toContain("アップロード中");
  });
});

describe("PhotoGrid — 追加可否（@codex対応）", () => {
  it("data-photo-grid を描画し、画像は認可済み fileUrl を lazy 読み込みする", () => {
    const html = renderToStaticMarkup(
      <PhotoGrid photos={[galleryPhoto({ fileUrl: "/uploads/a/1.jpg", thumbnailUrl: "/property-management/x/t.jpg" })]} onPick={() => {}} />,
    );
    expect(html).toContain("data-photo-grid");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("/uploads/a/1.jpg"); // fileUrl を表示（thumbnailUrl は使わない）
    expect(html).not.toContain("/property-management/x/t.jpg"); // 未認可 thumbnail を出さない
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

describe("uploadPhotoFiles — 既存 POST /api/properties/[id]/photos への multipart アップロード（純関数・fetch注入）", () => {
  const makeFile = (name = "a.jpg") =>
    new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });

  it("全件成功で succeededCount が枚数分になり、FormData(file)をボディに・Content-Type は手動指定しない", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { id: "ph1" } }), { status: 201 }),
    );

    const result = await uploadPhotoFiles(
      "prop-1",
      [makeFile("a.jpg"), makeFile("b.jpg")],
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ succeededCount: 2, failedCount: 0, firstErrorMessage: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/properties/prop-1/photos");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    // boundary はブラウザに付与させるため、Content-Type を手動指定しない(headers 未指定)。
    expect(init?.headers).toBeUndefined();
  });

  it("一部失敗（非2xx）時に failedCount と最初の失敗の firstErrorMessage を返す", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { message: "ファイルサイズが上限 (8MB) を超えています" } }),
          { status: 422 },
        );
      }
      return new Response(JSON.stringify({ data: { id: "ph2" } }), { status: 201 });
    });

    const result = await uploadPhotoFiles(
      "prop-1",
      [makeFile("big.jpg"), makeFile("ok.jpg")],
      fetchMock as unknown as typeof fetch,
    );

    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.firstErrorMessage).toBe("ファイルサイズが上限 (8MB) を超えています");
  });

  it("fetch が例外を投げても failedCount へ計上し、残りファイルの送信を継続する", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("network down");
      return new Response(JSON.stringify({ data: { id: "ph3" } }), { status: 201 });
    });

    const result = await uploadPhotoFiles(
      "prop-1",
      [makeFile("a.jpg"), makeFile("b.jpg")],
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ succeededCount: 1, failedCount: 1, firstErrorMessage: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("エラーレスポンスの JSON が壊れていても firstErrorMessage は null(例外を投げない)", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 500 }));

    const result = await uploadPhotoFiles("prop-1", [makeFile()], fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ succeededCount: 0, failedCount: 1, firstErrorMessage: null });
  });
});
