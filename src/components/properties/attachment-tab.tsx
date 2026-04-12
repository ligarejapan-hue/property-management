"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2,
  Paperclip,
  FileText,
  ImageIcon,
  Trash2,
  Download,
  Upload,
  AlertTriangle,
} from "lucide-react";
import {
  fetchAttachments as apiFetchAttachments,
  deleteAttachment,
  uploadFile,
} from "@/lib/api-client";

interface AttachmentData {
  id: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  uploader: { id: string; name: string };
}

const MAX_SIZE_MB = 8;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  return FileText;
}

export default function AttachmentTab({
  propertyId,
}: {
  propertyId: string;
}) {
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAttachmentsData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiFetchAttachments(propertyId);
      setAttachments(json.data as AttachmentData[]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchAttachmentsData();
  }, [fetchAttachmentsData]);

  const handleUpload = async (file: File) => {
    setUploadError(null);
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setUploadError(`ファイルサイズが上限 (${MAX_SIZE_MB}MB) を超えています`);
      return;
    }
    setUploading(true);
    try {
      await uploadFile(propertyId, file, "attachment");
      await fetchAttachmentsData();
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "アップロードに失敗しました",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = "";
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAttachment(propertyId, id);
      fetchAttachmentsData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "削除に失敗しました",
      );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  return (
    <div>
      {/* Upload area */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`mb-4 cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
        }`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            <span className="text-sm text-gray-600">アップロード中...</span>
          </div>
        ) : (
          <>
            <Upload className="mx-auto mb-2 h-8 w-8 text-gray-400" />
            <p className="text-sm text-gray-600">
              ファイルをドラッグ＆ドロップ、またはクリックして選択
            </p>
            <p className="mt-1 text-xs text-gray-400">
              上限 {MAX_SIZE_MB}MB / PDF, Excel, CSV, Word, 画像
            </p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          accept=".pdf,.xlsx,.xls,.csv,.docx,.jpg,.jpeg,.png,.webp,.heic"
        />
      </div>

      {uploadError && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {uploadError}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {attachments.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-gray-400">
          <Paperclip className="mb-2 h-8 w-8" />
          <p className="text-sm">添付ファイルはまだありません</p>
        </div>
      ) : (
        <div className="space-y-2">
          {attachments.map((att) => {
            const Icon = getFileIcon(att.mimeType);
            return (
              <div
                key={att.id}
                className="flex items-center gap-3 rounded-md border border-gray-200 bg-white p-3"
              >
                <Icon className="h-5 w-5 shrink-0 text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-800">
                    {att.fileName}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatFileSize(att.fileSize)} ·{" "}
                    {att.uploader.name} ·{" "}
                    {new Date(att.createdAt).toLocaleDateString("ja-JP")}
                  </p>
                </div>
                <a
                  href={att.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                  title="ダウンロード"
                >
                  <Download className="h-4 w-4" />
                </a>
                <button
                  onClick={() => handleDelete(att.id)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  title="削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
