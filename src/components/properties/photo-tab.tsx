"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Camera,
  Upload,
  Trash2,
  X,
  GripVertical,
  Image,
  Loader2,
} from "lucide-react";
import { fetchPhotos, uploadPhoto, deletePhoto } from "@/lib/api-client";

interface Photo {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number;
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

export default function PhotoTab({ propertyId }: { propertyId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<Photo | null>(null);

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

  const handleUpload = async () => {
    setUploading(true);
    try {
      const mockPhoto: Omit<Photo, "id"> = {
        url: `/mock/photo-${Date.now()}.jpg`,
        caption: `写真 ${photos.length + 1}`,
        sortOrder: photos.length,
        createdAt: new Date().toISOString(),
      };
      const json = (await uploadPhoto(propertyId, mockPhoto)) as { data: Photo };
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

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    setPhotos((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next.map((p, i) => ({ ...p, sortOrder: i }));
    });
  };

  const handleMoveDown = (index: number) => {
    if (index === photos.length - 1) return;
    setPhotos((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next.map((p, i) => ({ ...p, sortOrder: i }));
    });
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

  // --- Error state ---
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
        <button
          onClick={fetchPhotosData}
          className="ml-3 underline hover:no-underline"
        >
          再読み込み
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Image className="h-5 w-5" />
          写真
          {photos.length > 0 && (
            <span className="text-sm font-normal text-gray-500">
              ({photos.length})
            </span>
          )}
        </h3>
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
              並び替えモード
            </button>
          )}
          <button
            onClick={handleUpload}
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
          <p className="text-sm">写真はありません</p>
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
              {/* Thumbnail placeholder */}
              <button
                type="button"
                onClick={() => {
                  if (!reorderMode) setLightboxPhoto(photo);
                }}
                className={`flex aspect-square w-full items-center justify-center ${getPlaceholderColor(index)} cursor-pointer`}
              >
                <Camera className="h-10 w-10 text-gray-500/40" />
              </button>

              {/* Caption & date */}
              <div className="p-2">
                <p className="truncate text-sm font-medium text-gray-800">
                  {photo.caption ?? "無題"}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {formatDate(photo.createdAt)}
                </p>
              </div>

              {/* Reorder controls */}
              {reorderMode && (
                <div className="absolute left-1 top-1 flex flex-col gap-1">
                  <button
                    onClick={() => handleMoveUp(index)}
                    disabled={index === 0}
                    className="rounded bg-white/80 p-1 text-xs font-bold text-gray-600 shadow backdrop-blur hover:bg-white disabled:opacity-30"
                    title="上へ"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => handleMoveDown(index)}
                    disabled={index === photos.length - 1}
                    className="rounded bg-white/80 p-1 text-xs font-bold text-gray-600 shadow backdrop-blur hover:bg-white disabled:opacity-30"
                    title="下へ"
                  >
                    ▼
                  </button>
                </div>
              )}

              {/* Delete button */}
              {!reorderMode && (
                <button
                  onClick={() => setDeleteTargetId(photo.id)}
                  className="absolute right-1 top-1 rounded-full bg-white/80 p-1 text-gray-500 opacity-0 shadow backdrop-blur transition-opacity hover:bg-white hover:text-red-600 group-hover:opacity-100"
                  title="削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
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
              {/* Large placeholder */}
              <div
                className={`flex aspect-video w-full items-center justify-center ${getPlaceholderColor(
                  photos.findIndex((p) => p.id === lightboxPhoto.id),
                )}`}
              >
                <Camera className="h-20 w-20 text-gray-500/30" />
              </div>
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
