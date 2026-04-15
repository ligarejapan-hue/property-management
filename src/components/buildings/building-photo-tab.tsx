"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Camera,
  Upload,
  Trash2,
  X,
  GripVertical,
  Loader2,
  Star,
  Pencil,
  Check,
} from "lucide-react";
import {
  fetchBuildingPhotos,
  uploadBuildingPhoto,
  deleteBuildingPhoto,
  updateBuildingPhoto,
  type BuildingPhotoData,
} from "@/lib/api-client";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function BuildingPhotoTab({
  buildingId,
}: {
  buildingId: string;
}) {
  const [photos, setPhotos] = useState<BuildingPhotoData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<BuildingPhotoData | null>(
    null,
  );
  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchBuildingPhotos(buildingId);
      setPhotos(
        (json.data as BuildingPhotoData[]).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Upload ─────────────────────────────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be selected again
    e.target.value = "";

    setUploading(true);
    setError(null);
    try {
      const json = await uploadBuildingPhoto(buildingId, file);
      setPhotos((prev) =>
        [...prev, json.data as BuildingPhotoData].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (photoId: string) => {
    try {
      await deleteBuildingPhoto(buildingId, photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeleteTargetId(null);
    }
  };

  // ── Reorder ────────────────────────────────────────────────────────────────

  const handleMove = async (index: number, direction: "up" | "down") => {
    const next = [...photos];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= next.length) return;
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    const reordered = next.map((p, i) => ({ ...p, sortOrder: i }));
    setPhotos(reordered);
    // Persist new sort order for the two swapped photos
    try {
      await Promise.all([
        updateBuildingPhoto(buildingId, reordered[index].id, {
          sortOrder: reordered[index].sortOrder,
        }),
        updateBuildingPhoto(buildingId, reordered[swapIndex].id, {
          sortOrder: reordered[swapIndex].sortOrder,
        }),
      ]);
    } catch {
      // Non-critical: reload to sync
      load();
    }
  };

  // ── Caption edit ───────────────────────────────────────────────────────────

  const startCaptionEdit = (photo: BuildingPhotoData) => {
    setEditingCaptionId(photo.id);
    setCaptionDraft(photo.caption ?? "");
  };

  const saveCaptionEdit = async (photoId: string) => {
    try {
      await updateBuildingPhoto(buildingId, photoId, {
        caption: captionDraft.trim() || null,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? { ...p, caption: captionDraft.trim() || null }
            : p,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setEditingCaptionId(null);
    }
  };

  // ── isPrimary ──────────────────────────────────────────────────────────────

  const handleTogglePrimary = async (photo: BuildingPhotoData) => {
    const newVal = !photo.isPrimary;
    try {
      await updateBuildingPhoto(buildingId, photo.id, { isPrimary: newVal });
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

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
        <button onClick={load} className="ml-3 underline hover:no-underline">
          再読み込み
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <Camera className="h-5 w-5 text-gray-500" />
          棟写真
          {photos.length > 0 && (
            <span className="text-sm font-normal text-gray-500">
              ({photos.length})
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {photos.length > 1 && (
            <button
              onClick={() => setReorderMode((v) => !v)}
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
          <button
            onClick={() => fileInputRef.current?.click()}
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
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 py-12 text-gray-400">
          <Camera className="mb-3 h-10 w-10" />
          <p className="text-sm">棟写真はありません</p>
          <p className="mt-1 text-xs">
            外観・エントランス・館銘板などをアップロードしてください
          </p>
        </div>
      )}

      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {photos.map((photo, index) => (
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
                className="block aspect-square w-full overflow-hidden bg-gray-100"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.fileUrl}
                  alt={photo.caption ?? photo.fileName}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
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
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-1">
                    <p
                      className="truncate text-xs text-gray-700"
                      title={photo.caption ?? photo.fileName}
                    >
                      {photo.caption || (
                        <span className="text-gray-400">{photo.fileName}</span>
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
                  {formatDate(photo.createdAt)} · {formatSize(photo.fileSize)}
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
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-gray-900">
              写真を削除しますか？
            </h4>
            <p className="mt-2 text-sm text-gray-500">この操作は取り消せません。</p>
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

      {/* Lightbox */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setLightboxPhoto(null)}
        >
          <div
            className="relative mx-4 w-full max-w-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightboxPhoto(null)}
              className="absolute -right-2 -top-2 z-10 rounded-full bg-white p-1.5 text-gray-600 shadow-lg hover:text-gray-900"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="overflow-hidden rounded-lg bg-black shadow-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightboxPhoto.fileUrl}
                alt={lightboxPhoto.caption ?? lightboxPhoto.fileName}
                className="max-h-[80vh] w-full object-contain"
              />
            </div>
            <div className="mt-2 px-1">
              <p className="text-sm font-medium text-white">
                {lightboxPhoto.caption || lightboxPhoto.fileName}
              </p>
              <p className="mt-0.5 text-xs text-gray-400">
                {formatDate(lightboxPhoto.createdAt)} ·{" "}
                {lightboxPhoto.photographer.name} ·{" "}
                {formatSize(lightboxPhoto.fileSize)}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
