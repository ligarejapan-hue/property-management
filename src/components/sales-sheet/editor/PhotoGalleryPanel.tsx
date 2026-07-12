"use client";

/**
 * PhotoGalleryPanel.tsx — 写真ギャラリー（写真管理・計画④）
 *
 * 物件の登録写真を一覧表示し、選ぶと図面に image 要素として追加する。
 * 写真は GET /api/properties/[id]/photos（property:read + canAccessPropertyRecord）から取得。
 * fileUrl は API 側で /uploads/{key} に正規化済み＝isSafeImageSrc 準拠。
 * 実データの認可（この物件に属するか）は保存時 assertDocumentImagesAuthorized が担保する。
 */

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { isSafeImageSrc } from "@/lib/sales-sheet/css-safety";
import FilePickerButton from "@/components/import/file-picker-button";

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
            {/* thumbnailUrl は /uploads 認可(PropertyPhoto は fileUrl のみ逆引き)対象外ゆえ
                proxy せず、認可済みの fileUrl で表示。多数写真での一括取得を避け lazy 読み込み。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.fileUrl}
              alt={photoAlt(p) ?? ""}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </button>
        );
      })}
    </div>
  );
}

/** POST 失敗レスポンスから { error: { message } } を best-effort で拾う（拾えなければ null）。 */
async function extractErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message ?? null;
  } catch {
    return null;
  }
}

export interface UploadPhotosResult {
  succeededCount: number;
  failedCount: number;
  /** 失敗時、最初の失敗のエラーメッセージ（拾えれば）。UI の定型文に添える用途。 */
  firstErrorMessage: string | null;
}

/**
 * 選択ファイルを1枚ずつ既存 POST /api/properties/{id}/photos（multipart）へ送る（純関数）。
 * 呼び出し側は完了後に loadPhotos() で再取得すること（本関数自体は state を持たない）。
 * fetchImpl を注入可能にし、jsdom 無しの env=node でもユニットテストできるようにする。
 */
export async function uploadPhotoFiles(
  propertyId: string,
  files: File[],
  fetchImpl: typeof fetch = fetch,
): Promise<UploadPhotosResult> {
  let succeededCount = 0;
  let failedCount = 0;
  let firstErrorMessage: string | null = null;

  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append("file", file);
      // Content-Type はブラウザに multipart boundary を付与させるため手動指定しない。
      const res = await fetchImpl(`/api/properties/${propertyId}/photos`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        failedCount += 1;
        if (!firstErrorMessage) firstErrorMessage = await extractErrorMessage(res);
        continue;
      }
      succeededCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  return { succeededCount, failedCount, firstErrorMessage };
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 初回描画時と、アップロード完了後の再取得の両方から呼ぶ。cancelled ガードは初回 useEffect の
  // アンマウント/propertyId 切替時にのみ効かせる（アップロード後の呼び出しはガード不要=常時反映）。
  // useCallback で propertyId のみを依存にした安定した参照にし、下の useEffect の deps に含める
  // （photo-tab.tsx の fetchPhotosData と同じパターン）。
  const loadPhotos = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const res = await fetch(`/api/properties/${propertyId}/photos`);
        if (!res.ok) throw new Error("failed");
        const body = (await res.json()) as { data: GalleryPhoto[] };
        if (!signal?.cancelled) {
          setPhotos(body.data);
          setError(null);
        }
      } catch {
        if (!signal?.cancelled) setError("写真の読み込みに失敗しました");
      }
    },
    [propertyId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    loadPhotos(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadPhotos]);

  async function handleUploadChange(e: ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    const inputEl = e.target;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    setUploading(true);
    setUploadError(null);
    try {
      const result = await uploadPhotoFiles(propertyId, files);
      if (result.failedCount > 0) {
        setUploadError(
          `${files.length}枚中${result.failedCount}枚アップロードできませんでした` +
            (result.firstErrorMessage ? `（${result.firstErrorMessage}）` : ""),
        );
      }
      // 1枚でも成功していればギャラリーへ反映する。
      if (result.succeededCount > 0) await loadPhotos();
    } finally {
      setUploading(false);
      inputEl.value = ""; // 同じファイルを選び直しても onChange が発火するようにする
    }
  }

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

        <div className="mb-4 space-y-2 border-b border-gray-200 pb-4 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">
            ローカルからアップロード
          </h3>
          <FilePickerButton
            accept="image/*"
            multiple
            label="写真をアップロード"
            hint="JPEG/PNG/WebP・1枚8MBまで・複数可"
            disabled={uploading}
            onChange={handleUploadChange}
          />
          {uploading && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">アップロード中…</p>
          )}
          {uploadError && <p className="text-sm text-red-600 dark:text-red-400">{uploadError}</p>}
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
