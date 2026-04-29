"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Camera,
  Upload,
  Trash2,
  X,
  GripVertical,
  Image,
  Loader2,
  Star,
  Pencil,
  Check,
} from "lucide-react";
import {
  fetchPhotos,
  deletePhoto,
  updatePhoto,
  uploadFile,
} from "@/lib/api-client";
import { normalizeFileUrl } from "@/lib/url-normalize";

interface Photo {
  id: string;
  url?: string;
  fileUrl?: string;
  caption: string | null;
  sortOrder: number;
  isPrimary?: boolean;
  createdAt: string;
}

const PLACEHOLDER_COLORS = [
  "bg-blue-200",
  "bg-green-200",
  "bg-yellow-200",
  "bg-pink-200",
  "bg-purple-200",
  "bg-indigo-200",
  "bg-teal-200",
  "bg-orange-200",
];

function getPlaceholderColor(index: number) {
  return PLACEHOLDER_COLORS[index % PLACEHOLDER_COLORS.length];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getPhotoUrl(photo: Photo): string | null {
  const raw = photo.fileUrl ?? photo.url ?? null;
  return raw ? normalizeFileUrl(raw) : null;
}

const ACCEPTED_PHOTO_TYPES = ".jpg,.jpeg,.png,.webp,.heic,.heif";
const MAX_PHOTO_SIZE_MB = 8;

export default function PhotoTab({ propertyId }: { propertyId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<Photo | null>(null);
  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchPhotosData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchPhotos(propertyId);
      const data = (json.data as Photo[]).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      setPhotos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchPhotosData();
  }, [fetchPhotosData]);

  // ボタンクリック → 隠しファイル入力を開く
  const handleUploadClick = () => {
    setError(null);
    fileInputRef.current?.click();
  };

  // ファイル選択時の実アップロード（multipart/form-data）
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 同じファイルを連続選択できるように毎回リセット
    e.target.value = "";
    if (!file) return;

    if (file.size <= 0) {
      setError("空ファイルはアップロードできません");
      return;
    }
    if (file.size > MAX_PHOTO_SIZE_MB * 1024 * 1024) {
      setError(`ファイルサイズが上限 (${MAX_PHOTO_SIZE_MB}MB) を超えています`);
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const json = (await uploadFile(propertyId, file, "photo")) as { data: Photo };
      const newPhoto = json.data;
      setPhotos((prev) => [...prev, newPhoto]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePhoto(propertyId, id);
      setPhotos((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeleteTargetId(null);
    }
  };

  const handleMove = async (index: number, direction: "up" | "down") => {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= photos.length) return;
    const next = [...photos];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    const reordered = next.map((p, i) => ({ ...p, sortOrder: i }));
    setPhotos(reordered);
    try {
      await Promise.all([
        updatePhoto(propertyId, reordered[index].id, {
          sortOrder: reordered[index].sortOrder,
        }),
        updatePhoto(propertyId, reordered[swapIndex].id, {
          sortOrder: reordered[swapIndex].sortOrder,
        }),
      ]);
    } catch {
      fetchPhotosData();
    }
  };

  const startCaptionEdit = (photo: Photo) => {
    setEditingCaptionId(photo.id);
    setCaptionDraft(photo.caption ?? "");
  };

  const saveCaptionEdit = async (photoId: string) => {
    const trimmed = captionDraft.trim();
    try {
      await updatePhoto(propertyId, photoId, {
        caption: trimmed || null,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId ? { ...p, caption: trimmed || null } : p,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setEditingCaptionId(null);
    }
  };

  const handleTogglePrimary = async (photo: Photo) => {
    const newVal = !photo.isPrimary;
    try {
      await updatePhoto(propertyId, photo.id, { isPrimary: newVal });
      setPhotos((prev) =>
        prev.map((p) => ({
          ...p,
          isPrimary: p.id === photo.id ? newVal : newVal ? false : p.isPrimary,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました");
    }
  };

  // --- Loading state ---
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Inline error (アップロード失敗等) — 全画面置換しないことで再試行可能 */}
      {error && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <span>{error}</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={fetchPhotosData}
              className="underline hover:no-underline"
            >
              再読み込み
            </button>
            <button
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700"
              title="閉じる"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Image className="h-5 w-5" />
            物件写真
            {photos.length > 0 && (
              <span className="text-sm font-normal text-gray-500">
                ({photos.length})
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            この物件単体の写真です。共用部・外観などの棟全体写真は棟詳細「棟写真」をご利用ください。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {photos.length > 1 && (
            <button
              onClick={() => setReorderMode((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                reorderMode
                  ? "border-blue-300 bg-blue-50 text-blue-700"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              <GripVertical className="h-4 w-4" />
              並び替え
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_PHOTO_TYPES}
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={handleUploadClick}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            アップロード
          </button>
        </div>
      </div>

      {/* Empty state */}
      {photos.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 py-16 text-gray-400">
          <Camera className="mb-3 h-12 w-12" />
          <p className="text-sm">物件写真はありません</p>
        </div>
      )}

      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {photos.map((photo, index) => {
            const url = getPhotoUrl(photo);
            return (
              <div
                key={photo.id}
                className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
              >
                {/* Thumbnail */}
                <button
                  type="button"
                  onClick={() => {
                    if (!reorderMode) setLightboxPhoto(photo);
                  }}
                  className={`flex aspect-square w-full items-center justify-center overflow-hidden ${url ? "bg-gray-100" : getPlaceholderColor(index)} cursor-pointer`}
                >
                  {url && url.startsWith("/mock/") === false ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt={photo.caption ?? "写真"}
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <Camera className="h-10 w-10 text-gray-500/40" />
                  )}
                </button>

                {/* Primary badge */}
                {photo.isPrimary && (
                  <span className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-yellow-400 px-1.5 py-0.5 text-xs font-bold text-yellow-900">
                    <Star className="h-3 w-3 fill-current" />
                    代表
                  </span>
                )}

                {/* Caption & date */}
                <div className="p-2">
                  {editingCaptionId === photo.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={captionDraft}
                        onChange={(e) => setCaptionDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveCaptionEdit(photo.id);
                          if (e.key === "Escape") setEditingCaptionId(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-blue-400 px-1 py-0.5 text-xs focus:outline-none"
                        placeholder="キャプション"
                      />
                      <button
                        onClick={() => saveCaptionEdit(photo.id)}
                        className="rounded bg-blue-600 p-0.5 text-white"
                        title="保存"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-1">
                      <p
                        className="truncate text-sm font-medium text-gray-800"
                        title={photo.caption ?? "無題"}
                      >
                        {photo.caption ?? (
                          <span className="text-gray-400">無題</span>
                        )}
                      </p>
                      {!reorderMode && (
                        <button
                          onClick={() => startCaptionEdit(photo)}
                          className="shrink-0 text-gray-300 hover:text-gray-600"
                          title="キャプション編集"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  <p className="mt-0.5 text-xs text-gray-400">
                    {formatDate(photo.createdAt)}
                  </p>
                </div>

                {/* Reorder controls */}
                {reorderMode && (
                  <div className="absolute left-1 top-1 flex flex-col gap-1">
                    <button
                      onClick={() => handleMove(index, "up")}
                      disabled={index === 0}
                      className="rounded bg-white/80 p-1 text-xs font-bold text-gray-600 shadow backdrop-blur hover:bg-white disabled:opacity-30"
                      title="上へ"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => handleMove(index, "down")}
                      disabled={index === photos.length - 1}
                      className="rounded bg-white/80 p-1 text-xs font-bold text-gray-600 shadow backdrop-blur hover:bg-white disabled:opacity-30"
                      title="下へ"
                    >
                      ▼
                    </button>
                  </div>
                )}

                {/* Action buttons (not in reorder mode) */}
                {!reorderMode && (
                  <div className="absolute right-1 top-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={() => handleTogglePrimary(photo)}
                      className={`rounded-full p-1 shadow backdrop-blur transition-colors ${
                        photo.isPrimary
                          ? "bg-yellow-400 text-yellow-900"
                          : "bg-white/80 text-gray-400 hover:bg-white hover:text-yellow-500"
                      }`}
                      title={photo.isPrimary ? "代表解除" : "代表に設定"}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTargetId(photo.id)}
                      className="rounded-full bg-white/80 p-1 text-gray-400 shadow backdrop-blur hover:bg-white hover:text-red-600"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-gray-900">
              写真を削除しますか？
            </h4>
            <p className="mt-2 text-sm text-gray-500">
              この操作は取り消せません。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTargetId(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={() => handleDelete(deleteTargetId)}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox modal */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setLightboxPhoto(null)}
        >
          <div
            className="relative mx-4 w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightboxPhoto(null)}
              className="absolute -right-2 -top-2 z-10 rounded-full bg-white p-1.5 text-gray-600 shadow-lg hover:text-gray-900"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="overflow-hidden rounded-lg bg-white shadow-2xl">
              {(() => {
                const url = getPhotoUrl(lightboxPhoto);
                const isReal = url && !url.startsWith("/mock/");
                return isReal ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={lightboxPhoto.caption ?? "写真"}
                    className="max-h-[80vh] w-full object-contain"
                  />
                ) : (
                  <div
                    className={`flex aspect-video w-full items-center justify-center ${getPlaceholderColor(
                      photos.findIndex((p) => p.id === lightboxPhoto.id),
                    )}`}
                  >
                    <Camera className="h-20 w-20 text-gray-500/30" />
                  </div>
                );
              })()}
              <div className="p-4">
                <p className="text-base font-medium text-gray-900">
                  {lightboxPhoto.caption ?? "無題"}
                </p>
                <p className="mt-1 text-sm text-gray-400">
                  {formatDate(lightboxPhoto.createdAt)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
