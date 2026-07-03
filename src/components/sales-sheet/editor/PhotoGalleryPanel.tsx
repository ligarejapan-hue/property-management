"use client";

/**
 * PhotoGalleryPanel.tsx — 写真ギャラリー（写真管理・計画④）
 *
 * 物件の登録写真を一覧表示し、選ぶと図面に image 要素として追加する。
 * 写真は GET /api/properties/[id]/photos（property:read + canAccessPropertyRecord）から取得。
 * fileUrl は API 側で /uploads/{key} に正規化済み＝isSafeImageSrc 準拠。
 * 実データの認可（この物件に属するか）は保存時 assertDocumentImagesAuthorized が担保する。
 */

import { useEffect, useState } from "react";
import { isSafeImageSrc } from "@/lib/sales-sheet/css-safety";

export interface GalleryPhoto {
  id: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  fileName: string | null;
  caption: string | null;
}

/** 写真の alt テキスト（caption 優先、無ければファイル名）。 */
export function photoAlt(p: { caption: string | null; fileName: string | null }): string | undefined {
  return p.caption ?? p.fileName ?? undefined;
}

/**
 * 写真サムネのグリッド（プレゼンテーション・SSRテスト可）。
 * 図面に追加できるのは /uploads/ か data: の src のみ。追加不可の写真
 * （server backend で key 解決不能な外部URL等）はボタンを無効化し、
 * クリックしても無反応（silent no-op）にならないようにする。
 */
export function PhotoGrid({
  photos,
  onPick,
}: {
  photos: GalleryPhoto[];
  onPick: (photo: GalleryPhoto) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" data-photo-grid>
      {photos.map((p) => {
        const addable = isSafeImageSrc(p.fileUrl);
        return (
          <button
            key={p.id}
            type="button"
            disabled={!addable}
            title={addable ? (photoAlt(p) ?? "写真を追加") : "この写真は現在の保存形式では図面に追加できません"}
            onClick={() => {
              if (addable) onPick(p);
            }}
            className={`relative aspect-[4/3] overflow-hidden rounded border dark:border-zinc-700 ${
              addable
                ? "border-neutral-200 hover:border-blue-500"
                : "cursor-not-allowed border-neutral-200 opacity-40"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.thumbnailUrl ?? p.fileUrl}
              alt={photoAlt(p) ?? ""}
              className="h-full w-full object-cover"
            />
          </button>
        );
      })}
    </div>
  );
}

export function PhotoGalleryPanel({
  propertyId,
  onClose,
  onAddPhoto,
}: {
  propertyId: string;
  onClose: () => void;
  onAddPhoto: (src: string, alt?: string) => void;
}) {
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/properties/${propertyId}/photos`);
        if (!res.ok) throw new Error("failed");
        const body = (await res.json()) as { data: GalleryPhoto[] };
        if (!cancelled) setPhotos(body.data);
      } catch {
        if (!cancelled) setError("写真の読み込みに失敗しました");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  return (
    <div
      data-photo-gallery
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[560px] overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-zinc-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">写真を追加</h2>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-zinc-700"
          >
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {photos === null && !error && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">読み込み中…</p>
        )}
        {photos !== null && photos.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            この物件には登録写真がありません。
          </p>
        )}
        {photos !== null && photos.length > 0 && (
          <PhotoGrid
            photos={photos}
            onPick={(p) => {
              onAddPhoto(p.fileUrl, photoAlt(p));
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}
