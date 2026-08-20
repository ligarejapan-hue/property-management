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
  Eye,
  X,
} from "lucide-react";
import {
  fetchAttachments as apiFetchAttachments,
  deleteAttachment,
  uploadFile,
} from "@/lib/api-client";
import { normalizeFileUrl } from "@/lib/url-normalize";

type AttachmentType = "general" | "registry";

interface AttachmentData {
  id: string;
  type?: AttachmentType;
  /** 謄本の請求種別（owner|all）。type="registry" のときだけ意味を持つ・非PII。 */
  registryCertificateType?: string | null;
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

/** ブラウザ内プレビュー可能なものだけ true。Excel/Word/CSV はダウンロード扱い。 */
function getPreviewKind(att: { mimeType: string; fileName: string }): "image" | "pdf" | null {
  const name = att.fileName.toLowerCase();
  if (att.mimeType.startsWith("image/")) return "image";
  if (att.mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  // 一部ブラウザで MIME が image/* でなくても拡張子で判定可能なケース
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/.test(name)) return "image";
  return null;
}

/**
 * S1b-4: 謄本PDF(registry) の download は server-side で registry_pdf:download を
 * gate するため download intent param を付ける。既存 query があれば & で連結する。
 * preview iframe には付けない（preview は registry_pdf:preview で別 gate）。
 */
function withDownloadIntent(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

/**
 * registry 添付の client 表示名・保存名は generic 固定。
 * 元の att.fileName（所有者名・住所等 PII を含む恐れ）を画面表示・title/alt・iframe title・
 * download 属性のいずれにも出さない（server も Content-Disposition を registry.pdf に伏せている）。
 */
const REGISTRY_DOWNLOAD_NAME = "registry.pdf";

/**
 * registry 添付の表示名を、**種別が分かるときだけ固定ラベル**にする（非PII）。
 * ⚠生ファイル名(所有者名・住所を含み得る)は使わない=マスク方針は不変。
 * 種別(owner|all)は非PIIなので「謄本(所有者事項).pdf」「謄本(全部事項).pdf」を組み立ててよい。
 * 種別不明(手動取込等)は従来どおり "registry.pdf"。
 */
export function registryDisplayName(certType?: string | null): string {
  if (certType === "owner") return "謄本(所有者事項).pdf";
  if (certType === "all") return "謄本(全部事項).pdf";
  return REGISTRY_DOWNLOAD_NAME;
}

export default function AttachmentTab({
  propertyId,
  refreshToken = 0,
}: {
  propertyId: string;
  /**
   * 外から「一覧を読み直して」と伝える合図。値が変わったときだけ読み直す。
   * ⚠このタブは**開いた瞬間に一度だけ**読み込む作りなので、タブを開いたまま
   *   謄本を取り込んでも一覧は増えない。2026-08-20 に本番で回収に成功したのに
   *   『取り込めていない』と誤解された原因がこれ（実際は成功していた）。
   */
  refreshToken?: number;
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
  const [previewTarget, setPreviewTarget] = useState<AttachmentData | null>(null);
  const fileInputRefGeneral = useRef<HTMLInputElement>(null);
  const fileInputRefRegistry = useRef<HTMLInputElement>(null);

  const fetchAttachmentsData = useCallback(async (options?: { silent?: boolean }) => {
    // ⚠合図での取り直しは「読み込み中」に差し替えない（見ている表が一瞬消えるため）。
    if (!options?.silent) setLoading(true);
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

  // 合図（refreshToken）が変わったときだけ、一覧を**静かに**読み直す。
  // ⚠初回は上の useEffect が読み込むので走らせない（二重取得を避ける）。
  const seenRefreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (seenRefreshTokenRef.current === refreshToken) return;
    seenRefreshTokenRef.current = refreshToken;
    void fetchAttachmentsData({ silent: true });
  }, [refreshToken, fetchAttachmentsData]);

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
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
      </div>
    );
  }

  const registryAttachments = attachments.filter((a) => a.type === "registry");
  const generalAttachments = attachments.filter((a) => a.type !== "registry");

  return (
    <div className="space-y-8">
      {/* ============================== 通常添付 ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">添付ファイル</h3>

        {/* Upload area: general */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverGeneral(true); }}
          onDragLeave={() => setDragOverGeneral(false)}
          onDrop={(e) => handleDrop(e, "general")}
          onClick={() => fileInputRefGeneral.current?.click()}
          className={`mb-3 cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            dragOverGeneral
              ? "border-blue-400 bg-blue-50 dark:border-blue-400/40 dark:bg-blue-500/15"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600 dark:hover:bg-gray-800"
          }`}
        >
          {uploadingGeneral ? (
            <div className="flex items-center justify-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
              <span className="text-sm text-gray-600 dark:text-gray-300">アップロード中...</span>
            </div>
          ) : (
            <>
              <Upload className="mx-auto mb-2 h-8 w-8 text-gray-400 dark:text-gray-500" />
              <p className="text-sm text-gray-600 dark:text-gray-300">
                ファイルをドラッグ＆ドロップ、またはクリックして選択
              </p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
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
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {uploadErrorGeneral}
          </div>
        )}

        {generalAttachments.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-gray-400 dark:text-gray-500">
            <Paperclip className="mb-2 h-8 w-8" />
            <p className="text-sm">添付ファイルはまだありません</p>
          </div>
        ) : (
          <div className="space-y-2">
            {generalAttachments.map((att) => (
              <AttachmentRow
                key={att.id}
                att={att}
                onPreviewClick={() => setPreviewTarget(att)}
                onDeleteClick={() => setDeleteTargetId(att.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================== 謄本PDF ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">謄本PDF</h3>

        {/* Upload area: registry */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverRegistry(true); }}
          onDragLeave={() => setDragOverRegistry(false)}
          onDrop={(e) => handleDrop(e, "registry")}
          onClick={() => fileInputRefRegistry.current?.click()}
          className={`mb-3 cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            dragOverRegistry
              ? "border-amber-400 bg-amber-50 dark:border-amber-400/40 dark:bg-amber-500/15"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600 dark:hover:bg-gray-800"
          }`}
        >
          {uploadingRegistry ? (
            <div className="flex items-center justify-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
              <span className="text-sm text-gray-600 dark:text-gray-300">アップロード中...</span>
            </div>
          ) : (
            <>
              <FileText className="mx-auto mb-2 h-8 w-8 text-amber-500" />
              <p className="text-sm text-gray-600 dark:text-gray-300">
                謄本PDFをドラッグ＆ドロップ、またはクリックして選択
              </p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
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
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {uploadErrorRegistry}
          </div>
        )}

        {registryAttachments.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-gray-400 dark:text-gray-500">
            <FileText className="mb-2 h-8 w-8" />
            <p className="text-sm">謄本PDFはまだありません</p>
          </div>
        ) : (
          <div className="space-y-2">
            {registryAttachments.map((att) => (
              <AttachmentRow
                key={att.id}
                att={att}
                onPreviewClick={() => setPreviewTarget(att)}
                onDeleteClick={() => setDeleteTargetId(att.id)}
              />
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Preview modal */}
      {previewTarget && (
        <PreviewModal att={previewTarget} onClose={() => setPreviewTarget(null)} />
      )}

      {/* Delete confirmation dialog */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white dark:bg-gray-900 p-6 shadow-xl">
            <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              ファイルを削除しますか？
            </h4>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              この操作は取り消せません。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTargetId(null)}
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
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
  onPreviewClick,
  onDeleteClick,
}: {
  att: AttachmentData;
  onPreviewClick: () => void;
  onDeleteClick: () => void;
}) {
  const Icon = getFileIcon(att.mimeType);
  const previewable = getPreviewKind(att) !== null;
  const isRegistry = att.type === "registry";
  const normalizedUrl = normalizeFileUrl(att.fileUrl);
  const downloadHref = isRegistry ? withDownloadIntent(normalizedUrl) : normalizedUrl;
  // registry は表示名・保存名ともに generic（att.fileName の PII を client 表示にも出さない）。
  const displayName = isRegistry
    ? registryDisplayName(att.registryCertificateType)
    : att.fileName;
  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
      <Icon className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400" />
      <div className="min-w-0 flex-1">
        {previewable ? (
          <button
            type="button"
            onClick={onPreviewClick}
            className="block w-full truncate text-left text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            title="プレビュー"
          >
            {displayName}
          </button>
        ) : (
          <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {displayName}
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {formatFileSize(att.fileSize)} ·{" "}
          {att.uploader.name} ·{" "}
          {new Date(att.createdAt).toLocaleDateString("ja-JP")}
        </p>
      </div>
      {previewable && (
        <button
          onClick={onPreviewClick}
          className="shrink-0 rounded p-1 text-gray-400 dark:text-gray-500 hover:bg-indigo-50 hover:text-indigo-500 dark:hover:bg-gray-800"
          title="プレビュー"
        >
          <Eye className="h-4 w-4" />
        </button>
      )}
      <a
        href={downloadHref}
        target="_blank"
        rel="noopener noreferrer"
        download={displayName}
        className="shrink-0 rounded p-1 text-gray-400 dark:text-gray-500 hover:bg-indigo-50 hover:text-indigo-500 dark:hover:bg-gray-800"
        title="ダウンロード"
      >
        <Download className="h-4 w-4" />
      </a>
      <button
        onClick={onDeleteClick}
        className="shrink-0 rounded p-1 text-gray-400 dark:text-gray-500 hover:bg-red-50 hover:text-red-500"
        title="削除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// プレビュー用モーダル。画像 / PDF のみ画面内表示、それ以外はダウンロード誘導。
function PreviewModal({
  att,
  onClose,
}: {
  att: AttachmentData;
  onClose: () => void;
}) {
  const kind = getPreviewKind(att);
  // 過去保存の絶対URL（http://host:3000/uploads/...）を相対パスに正規化。
  // 表示中のオリジン（nginx 経由）から `/uploads/...` を引けば 200 で返るため。
  const safeUrl = normalizeFileUrl(att.fileUrl);
  const isRegistry = att.type === "registry";
  // preview(iframe) は無 param のまま。download リンクのみ download intent を付ける。
  const downloadHref = isRegistry ? withDownloadIntent(safeUrl) : safeUrl;
  // registry は表示名・保存名ともに generic（att.fileName の PII を client 表示にも出さない）。
  const displayName = isRegistry
    ? registryDisplayName(att.registryCertificateType)
    : att.fileName;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex h-full w-full max-w-[90vw] sm:max-w-5xl flex-col overflow-hidden rounded-lg bg-white dark:bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-4 py-2">
          <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100" title={displayName}>
            {displayName}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={downloadHref}
              target="_blank"
              rel="noopener noreferrer"
              download={displayName}
              className="rounded p-1 text-gray-500 dark:text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-gray-800"
              title="ダウンロード"
            >
              <Download className="h-4 w-4" />
            </a>
            <button
              onClick={onClose}
              className="rounded p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              title="閉じる"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto bg-gray-100 dark:bg-gray-800">
          {kind === "image" && (
            <div className="flex h-full w-full items-center justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={safeUrl}
                alt={displayName}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
          {kind === "pdf" && (
            // registry PDF は native browser viewer（iframe）で表示する。本 PR では viewer を置換しない。
            // 限界: iframe 内 PDF viewer の copy / contextmenu / selection / 印刷 / 「PDF として保存」は
            // 別 document のため、親 document の ScreenProtectionGuard では捕捉できない。
            // registry PDF bytes は S1b-4 の server-side permission gate（registry_pdf:preview/download）・
            // no-store・generic filename・server-side 監査で保護する（＝主防御）。OS スクリーンショット・
            // 画面録画・外部カメラは Web からは防止も検知もできない。prevention ではなく抑止＋事後追跡。
            <iframe
              src={safeUrl}
              title={displayName}
              className="h-full w-full"
            />
          )}
          {kind === null && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-gray-600 dark:text-gray-300">
              <FileText className="h-12 w-12 text-gray-400 dark:text-gray-500" />
              <p>このファイル形式はブラウザ内プレビュー非対応です。</p>
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={displayName}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                <Download className="h-4 w-4" />
                ダウンロード
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
