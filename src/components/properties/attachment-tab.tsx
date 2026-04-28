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

type AttachmentType = "general" | "registry";

interface AttachmentData {
  id: string;
  type?: AttachmentType;
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

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

export default function AttachmentTab({
  propertyId,
}: {
  propertyId: string;
}) {
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 通常添付 と 謄本PDF で個別の uploading / error 状態を持つ
  const [uploadingGeneral, setUploadingGeneral] = useState(false);
  const [uploadingRegistry, setUploadingRegistry] = useState(false);
  const [uploadErrorGeneral, setUploadErrorGeneral] = useState<string | null>(null);
  const [uploadErrorRegistry, setUploadErrorRegistry] = useState<string | null>(null);
  const [dragOverGeneral, setDragOverGeneral] = useState(false);
  const [dragOverRegistry, setDragOverRegistry] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const fileInputRefGeneral = useRef<HTMLInputElement>(null);
  const fileInputRefRegistry = useRef<HTMLInputElement>(null);

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

  const handleUpload = async (file: File, type: AttachmentType) => {
    const setUploading = type === "registry" ? setUploadingRegistry : setUploadingGeneral;
    const setUploadError =
      type === "registry" ? setUploadErrorRegistry : setUploadErrorGeneral;

    setUploadError(null);
    if (file.size <= 0) {
      setUploadError("空ファイルはアップロードできません");
      return;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setUploadError(`ファイルサイズが上限 (${MAX_SIZE_MB}MB) を超えています`);
      return;
    }
    // 謄本PDF はクライアント側でも PDF のみ受け付け（サーバ側でも 422 で再チェック）
    if (type === "registry" && !isPdfFile(file)) {
      setUploadError("謄本PDFは PDF ファイルのみアップロードできます");
      return;
    }
    setUploading(true);
    try {
      await uploadFile(propertyId, file, "attachment", { attachmentType: type });
      await fetchAttachmentsData();
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "アップロードに失敗しました",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent, type: AttachmentType) => {
    e.preventDefault();
    if (type === "registry") setDragOverRegistry(false);
    else setDragOverGeneral(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file, type);
  };

  const handleFileSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: AttachmentType,
  ) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file, type);
    e.target.value = "";
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAttachment(propertyId, id);
      await fetchAttachmentsData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "削除に失敗しました",
      );
    } finally {
      setDeleteTargetId(null);
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

  const registryAttachments = attachments.filter((a) => a.type === "registry");
  const generalAttachments = attachments.filter((a) => a.type !== "registry");

  return (
    <div className="space-y-8">
      {/* ============================== 通常添付 ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">添付ファイル</h3>

        {/* Upload area: general */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverGeneral(true); }}
          onDragLeave={() => setDragOverGeneral(false)}
          onDrop={(e) => handleDrop(e, "general")}
          onClick={() => fileInputRefGeneral.current?.click()}
          className={`mb-3 cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            dragOverGeneral
              ? "border-blue-400 bg-blue-50"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
          }`}
        >
          {uploadingGeneral ? (
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
            ref={fileInputRefGeneral}
            type="file"
            className="hidden"
            onChange={(e) => handleFileSelect(e, "general")}
            accept=".pdf,.xlsx,.xls,.csv,.docx,.jpg,.jpeg,.png,.webp,.heic"
          />
        </div>

        {uploadErrorGeneral && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {uploadErrorGeneral}
          </div>
        )}

        {generalAttachments.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-gray-400">
            <Paperclip className="mb-2 h-8 w-8" />
            <p className="text-sm">添付ファイルはまだありません</p>
          </div>
        ) : (
          <div className="space-y-2">
            {generalAttachments.map((att) => (
              <AttachmentRow
                key={att.id}
                att={att}
                onDeleteClick={() => setDeleteTargetId(att.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================== 謄本PDF ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">謄本PDF</h3>

        {/* Upload area: registry */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverRegistry(true); }}
          onDragLeave={() => setDragOverRegistry(false)}
          onDrop={(e) => handleDrop(e, "registry")}
          onClick={() => fileInputRefRegistry.current?.click()}
          className={`mb-3 cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            dragOverRegistry
              ? "border-amber-400 bg-amber-50"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
          }`}
        >
          {uploadingRegistry ? (
            <div className="flex items-center justify-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
              <span className="text-sm text-gray-600">アップロード中...</span>
            </div>
          ) : (
            <>
              <FileText className="mx-auto mb-2 h-8 w-8 text-amber-500" />
              <p className="text-sm text-gray-600">
                謄本PDFをドラッグ＆ドロップ、またはクリックして選択
              </p>
              <p className="mt-1 text-xs text-gray-400">
                PDF のみ / 上限 {MAX_SIZE_MB}MB
              </p>
            </>
          )}
          <input
            ref={fileInputRefRegistry}
            type="file"
            className="hidden"
            onChange={(e) => handleFileSelect(e, "registry")}
            accept="application/pdf,.pdf"
          />
        </div>

        {uploadErrorRegistry && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {uploadErrorRegistry}
          </div>
        )}

        {registryAttachments.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-gray-400">
            <FileText className="mb-2 h-8 w-8" />
            <p className="text-sm">謄本PDFはまだありません</p>
          </div>
        ) : (
          <div className="space-y-2">
            {registryAttachments.map((att) => (
              <AttachmentRow
                key={att.id}
                att={att}
                onDeleteClick={() => setDeleteTargetId(att.id)}
              />
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-gray-900">
              ファイルを削除しますか？
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
    </div>
  );
}

// 一覧行（通常添付・謄本PDF で共有）
function AttachmentRow({
  att,
  onDeleteClick,
}: {
  att: AttachmentData;
  onDeleteClick: () => void;
}) {
  const Icon = getFileIcon(att.mimeType);
  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-white p-3">
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
        download={att.fileName}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
        title="ダウンロード"
      >
        <Download className="h-4 w-4" />
      </a>
      <button
        onClick={onDeleteClick}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
        title="削除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
