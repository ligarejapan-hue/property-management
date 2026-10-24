"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import FileDropZone from "@/components/ui/file-drop-zone";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Paperclip,
  FileText,
  ImageIcon,
  Trash2,
  Download,
  AlertTriangle,
  Eye,
  X,
} from "lucide-react";
import {
  beginRefresh,
  createRefreshState,
  resolveFailure,
  resolveSuccess,
  shouldClearLoading,
} from "@/lib/property-refresh/refresh-coordinator";
import {
  fetchAttachments as apiFetchAttachments,
  deleteAttachment,
  updateAttachmentKind,
  uploadFile,
} from "@/lib/api-client";
import { DOC_KINDS, DOC_STAGES, docKindByCode } from "@/lib/doc-classify/classify";
import { defaultOpenStage } from "@/lib/doc-classify/stage";
import { displayTitle, groupAttachmentsByStage, needsKindCheck, visibleFolders } from "@/lib/attachments/doc-folders";
import { normalizeFileUrl } from "@/lib/url-normalize";
import { sendsDownloadIntent } from "@/lib/attachments/download-intent";
import {
  uploadFailureMessage,
  uploadProgressLabel,
  type UploadFailure,
  type UploadProgress,
} from "@/lib/attachments/multi-upload";
import { registryDisplayName } from "@/lib/attachments/registry-display-name";
import { MAX_ATTACHMENT_BYTES, MAX_PDF_UPLOAD_BYTES } from "@/lib/pdf-compress/policy";
import { MAX_FILE_SIZE } from "@/lib/storage/types";

type AttachmentType = "general" | "registry";

interface AttachmentData {
  id: string;
  type?: AttachmentType;
  /** 謄本の請求種別（owner|all）。type="registry" のときだけ意味を持つ・非PII。 */
  registryCertificateType?: string | null;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  /** 自動で縮めたときだけ、圧縮前の大きさ(bytes)。 */
  originalSize?: number | null;
  mimeType: string;
  createdAt: string;
  uploader: { id: string; name: string };
  /** 書類の自動整理(2026-10-23): 段階・種類・そろえた名前・確からしさ(high|low|manual)。null=その他・元の名前。 */
  docStage?: string | null;
  docKind?: string | null;
  docTitle?: string | null;
  docConfidence?: string | null;
}

/** 保存してよい上限(20MB・2026-10-19 発注者決定・謄本も同じ)。値はサーバーと同じ定数から。 */
const MAX_SIZE_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;
/**
 * 通常添付の PDF は、8MB(MAX_FILE_SIZE)を超えるとサーバーが自動で縮める(2026-10-10)ので
 * ここまで受け付ける(縮めて 20MB 以下になれば保存)。
 * 謄本PDFは縮めない(課金した原本)ので 20MB まで。
 */
const MAX_PDF_MB = MAX_PDF_UPLOAD_BYTES / 1024 / 1024;

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
 * download 属性のいずれにも出さない。
 * ⚠名前の作り方は `@/lib/attachments/registry-display-name` に**1本化**してある
 *   （添付タブ・添付ファイル検索・ゴミ箱・server の Content-Disposition が同じ関数を通る）。
 * ⚠手元に落ちるファイル名を決めるのは download 属性ではなく server の Content-Disposition。
 *   ここの download 属性は、ヘッダを解釈できない経路のための保険にすぎない。
 */

export default function AttachmentTab({
  propertyId,
  refreshToken = 0,
  onRegistryMutated,
  caseStatus = null,
  occupancyStatus = null,
}: {
  /** 現況。賃貸中(rented)のときだけ「⑤ 賃貸関係」のフォルダを空でも出す。 */
  occupancyStatus?: string | null;
  propertyId: string;
  /** 案件ステータス。最初に開いておく段階のフォルダを決める(契約予定→②・契約完了以降→③)。 */
  caseStatus?: string | null;
  /**
   * 外から「一覧を読み直して」と伝える合図。値が変わったときだけ読み直す。
   * ⚠このタブは**開いた瞬間に一度だけ**読み込む作りなので、タブを開いたまま
   *   謄本を取り込んでも一覧は増えない。2026-08-20 に本番で回収に成功したのに
   *   『取り込めていない』と誤解された原因がこれ（実際は成功していた）。
   */
  refreshToken?: number;
  /**
   * registry 添付(謄本)を追加/削除して成功したときに呼ぶ。親(物件詳細)が物件を
   * 取り直し、基本情報の件数行を最新にするために使う(@codex #429 P2)。
   * このタブ自身の一覧は fetchAttachmentsData で別途更新される。
   */
  onRegistryMutated?: () => void;
}) {
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 通常添付 と 謄本PDF で個別の uploading / error 状態を持つ
  const [uploadingGeneral, setUploadingGeneral] = useState(false);
  // 8MB を超える PDF を送っている間は「圧縮しています」と出す(数秒〜十数秒かかる)。
  const [compressingGeneral, setCompressingGeneral] = useState(false);
  // 複数ファイルを送っている間の「N件中M件目」(1件だけのときは null)。
  const [uploadProgressGeneral, setUploadProgressGeneral] = useState<UploadProgress | null>(null);
  const [uploadProgressRegistry, setUploadProgressRegistry] = useState<UploadProgress | null>(null);
  const [uploadingRegistry, setUploadingRegistry] = useState(false);
  const [uploadErrorGeneral, setUploadErrorGeneral] = useState<string | null>(null);
  const [uploadErrorRegistry, setUploadErrorRegistry] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<AttachmentData | null>(null);
  // 種類を直している最中の添付(二重送信を防ぐ)。
  const [kindSavingId, setKindSavingId] = useState<string | null>(null);
  // 一覧の取り直しの交通整理は、物件ページと**同じ純関数**に委ねる
  // （@codex #395 R7 P2）。独自の世代ガードだと、**新しい取り直しが失敗しただけ**で
  // 先に届いていた使える一覧を捨て、タブが空/古いままエラーになる。
  const refreshStateRef = useRef(createRefreshState());

  const fetchAttachmentsData = useCallback(async (options?: { silent?: boolean }) => {
    const ticket = beginRefresh(
      refreshStateRef.current,
      options?.silent ? "quiet" : "full",
    );
    // ⚠合図での取り直しは「読み込み中」に差し替えない（見ている表が一瞬消えるため）。
    //   エラー表示にも触らない（静かな更新が見えている状態を乱さない）。
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const json = await apiFetchAttachments(propertyId);
      const outcome = resolveSuccess(refreshStateRef.current, ticket);
      if (outcome.applyData) setAttachments(json.data as AttachmentData[]);
      if (outcome.showError !== null) setError(outcome.showError);
      else if (outcome.clearError) setError(null);
    } catch (err) {
      const outcome = resolveFailure(
        refreshStateRef.current,
        ticket,
        err instanceof Error ? err.message : "取得に失敗しました",
      );
      if (outcome.showError !== null) setError(outcome.showError);
    } finally {
      if (shouldClearLoading(refreshStateRef.current, ticket)) setLoading(false);
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

  /** 1件を確かめて送る。失敗の理由を返す(成功は null)。一覧の読み直しは呼び出し側でまとめて行う。 */
  const uploadOne = async (file: File, type: AttachmentType): Promise<string | null> => {
    if (file.size <= 0) return "空ファイルはアップロードできません";
    // 種類(MIME)が空でも拡張子が .pdf なら PDF とみなす(サーバーと同じ判定・@codex PR#498 P2)。
    const compressible = type === "general" && isPdfFile(file);
    const limitMb = compressible ? MAX_PDF_MB : MAX_SIZE_MB;
    if (file.size > limitMb * 1024 * 1024) {
      return `ファイルサイズが上限 (${limitMb}MB) を超えています`;
    }
    // 謄本PDF はクライアント側でも PDF のみ受け付け（サーバ側でも 422 で再チェック）
    if (type === "registry" && !isPdfFile(file)) {
      return "謄本PDFは PDF ファイルのみアップロードできます";
    }
    if (type === "general") {
      setCompressingGeneral(compressible && file.size > MAX_FILE_SIZE);
    }
    try {
      await uploadFile(propertyId, file, "attachment", { attachmentType: type });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "アップロードに失敗しました";
    }
  };

  /**
   * 選んだ・ドロップした**すべて**のファイルを1件ずつ順に送る(2026-10-12 ご指摘: 複数ドロップで1件しか入らない)。
   * ⚠同時に送らない(大きいPDFの圧縮はサーバーで1件ずつ・席は「処理中1+待ち1」)。
   * 1件が失敗しても残りは続け、最後に失敗した分だけをまとめて出す。
   */
  const handleUploads = async (files: File[], type: AttachmentType) => {
    if (files.length === 0) return;
    const setUploading = type === "registry" ? setUploadingRegistry : setUploadingGeneral;
    const setUploadError =
      type === "registry" ? setUploadErrorRegistry : setUploadErrorGeneral;
    const setProgress = type === "registry" ? setUploadProgressRegistry : setUploadProgressGeneral;
    setUploadError(null);
    setUploading(true);
    const failures: UploadFailure[] = [];
    let succeeded = 0;
    try {
      for (const [i, file] of files.entries()) {
        setProgress(files.length > 1 ? { current: i + 1, total: files.length } : null);
        const reason = await uploadOne(file, type);
        if (reason === null) succeeded++;
        else failures.push({ index: i + 1, fileName: file.name, reason });
      }
      if (succeeded > 0) {
        await fetchAttachmentsData();
        // 謄本の増減時だけ親へ通知(基本情報の件数を取り直す)。一般添付は件数行に無関係。
        if (type === "registry") onRegistryMutated?.();
      }
      // ⚠謄本のファイル名は所有者名を含み得るので出さない(何件目かだけ)。
      setUploadError(uploadFailureMessage(failures, files.length, { showFileNames: type !== "registry" }));
    } finally {
      setUploading(false);
      setProgress(null);
      if (type === "general") setCompressingGeneral(false);
    }
  };

  const handleDelete = async (id: string) => {
    // 削除前に種別を控える(削除後は一覧から消えて判定できない)。謄本のときだけ親へ通知。
    const wasRegistry =
      attachments.find((a) => a.id === id)?.type === "registry";
    try {
      await deleteAttachment(propertyId, id);
      await fetchAttachmentsData();
      if (wasRegistry) onRegistryMutated?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "削除に失敗しました",
      );
    } finally {
      setDeleteTargetId(null);
    }
  };

  /** 種類を人が決め直す。段階とそろえた名前はサーバーが作り直すので、一覧を静かに読み直す。 */
  const handleKindChange = async (id: string, docKind: string | null) => {
    if (kindSavingId !== null) return;
    setKindSavingId(id);
    try {
      await updateAttachmentKind(propertyId, id, docKind);
      await fetchAttachmentsData({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "種類の変更に失敗しました");
    } finally {
      setKindSavingId(null);
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
  // 最初に開いておく段階。その段階が空のときは「その他」に中身があればそちらも開く(古い添付が隠れないように)。
  const openStage = defaultOpenStage(caseStatus);
  const openStageEmpty = !generalAttachments.some((a) => a.docStage === openStage);

  return (
    <div className="space-y-8">
      {/* ============================== 通常添付 ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">添付ファイル</h3>

        {/* Upload area: general */}
        <FileDropZone
          className="mb-3"
          accept=".pdf,.xlsx,.xls,.csv,.docx,.jpg,.jpeg,.png,.webp,.heic"
          multiple
          title="ファイルをここにドラッグ＆ドロップ"
          hint={`上限 ${MAX_SIZE_MB}MB / PDF, Excel, CSV, Word, 画像（8MB を超えるPDFは自動で縮めます。${MAX_PDF_MB}MBまで受け付け、縮めて${MAX_SIZE_MB}MB以下になれば保存）`}
          onFiles={(files) => void handleUploads(files, "general")}
          busy={
            uploadingGeneral ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                <span>
                  {uploadProgressLabel(uploadProgressGeneral)}
                  {compressingGeneral
                    ? "大きいPDFを圧縮して保存しています…（数十秒かかることがあります）"
                    : "アップロード中..."}
                </span>
              </>
            ) : undefined
          }
        />

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
          // 段階ごとのフォルダ(①調査資料等 ②管理関係 ③契約関係 ④決済関係 ⑤賃貸関係[賃貸中のときだけ] 本人確認 その他)。
          // 案件ステータスに合う段階を開いた状態にし、ほかは件数だけ見せる。
          <div className="space-y-2">
            {visibleFolders(groupAttachmentsByStage(generalAttachments), { occupancyStatus }).map((folder) => (
              <details
                key={folder.code}
                open={folder.code === openStage || (folder.code === "other" && folder.items.length > 0 && openStageEmpty)}
                className="rounded-md border border-gray-200 dark:border-gray-800"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                  <span>{folder.short ? `${folder.short} ${folder.label}` : folder.label}</span>
                  <span className="rounded-full bg-gray-100 px-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {folder.items.length}
                  </span>
                  {folder.items.some((it) => (it.type === undefined || it.type === "general") && needsKindCheck(it)) && (
                    <span className="rounded-full bg-amber-50 px-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      種類を確認
                    </span>
                  )}
                </summary>
                {folder.items.length === 0 ? (
                  <p className="px-3 pb-2 text-xs text-gray-400 dark:text-gray-500">まだありません</p>
                ) : (
                  <div className="space-y-2 px-2 pb-2">
                    {folder.items.map((att) => (
                      <AttachmentRow
                        key={att.id}
                        att={att}
                        onPreviewClick={() => setPreviewTarget(att)}
                        onDeleteClick={() => setDeleteTargetId(att.id)}
                        onKindChange={(kind) => void handleKindChange(att.id, kind)}
                        kindSaving={kindSavingId === att.id}
                      />
                    ))}
                  </div>
                )}
              </details>
            ))}
          </div>
        )}
      </section>

      {/* ============================== 謄本PDF ============================== */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">謄本PDF</h3>

        {/* Upload area: registry */}
        <FileDropZone
          className="mb-3"
          accept="application/pdf,.pdf"
          multiple
          hideFileNames
          icon={FileText}
          title="謄本PDFをここにドラッグ＆ドロップ"
          hint={`PDF のみ / 上限 ${MAX_SIZE_MB}MB（縮めずにそのまま保存）`}
          onFiles={(files) => void handleUploads(files, "registry")}
          busy={
            uploadingRegistry ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
                <span>{uploadProgressLabel(uploadProgressRegistry)}アップロード中...</span>
              </>
            ) : undefined
          }
        />

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

      {/* Delete confirmation dialog(第3弾⑪: 共通 ConfirmDialog) */}
      {deleteTargetId && (
        <ConfirmDialog
          title="ファイルを削除しますか？"
          onCancel={() => setDeleteTargetId(null)}
          onConfirm={() => handleDelete(deleteTargetId)}
        />
      )}
    </div>
  );
}

// 一覧行（通常添付・謄本PDF で共有）
function AttachmentRow({
  att,
  onPreviewClick,
  onDeleteClick,
  onKindChange,
  kindSaving = false,
}: {
  att: AttachmentData;
  onPreviewClick: () => void;
  onDeleteClick: () => void;
  /** 通常添付だけ: 種類を人が決め直す(null=その他)。謄本の行では渡さない。 */
  onKindChange?: (docKind: string | null) => void;
  kindSaving?: boolean;
}) {
  const Icon = getFileIcon(att.mimeType);
  const previewable = getPreviewKind(att) !== null;
  const isRegistry = att.type === "registry";
  const normalizedUrl = normalizeFileUrl(att.fileUrl);
  const downloadHref = sendsDownloadIntent(att) ? withDownloadIntent(normalizedUrl) : normalizedUrl;
  // registry は表示名・保存名ともに generic（att.fileName の PII を client 表示にも出さない）。
  // 通常添付は、そろえた名前(docTitle)があればそれを出し、元の名前は小さく添える。
  const displayName = isRegistry
    ? registryDisplayName(att.registryCertificateType, att.createdAt)
    : displayTitle(att);
  // 元の名前を添えるのは通常添付だけ(registry の生ファイル名は出さない)。
  const originalName = !isRegistry && displayName !== att.fileName ? att.fileName : null;
  // 種類の選択は type=general だけ(反響資料・査定報告書は配信の守りがあり、サーバーも 422 にする)。
  const canEditKind = onKindChange !== undefined && (att.type === undefined || att.type === "general");
  const kindCheck = canEditKind && needsKindCheck(att);
  const kindLabel = docKindByCode(att.docKind)?.label ?? null;
  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
      <Icon className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400" />
      <div className="min-w-0 flex-1">
        {previewable ? (
          // data-ui=raw: ファイル名そのものが押せる文字(1行で省略表示・余白を足すと下の行とずれる)
          <button
            type="button"
            data-ui="raw"
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
        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
          {originalName !== null ? `元: ${originalName} · ` : ""}
          {formatFileSize(att.fileSize)}
          {att.originalSize ? `（自動で圧縮・元 ${formatFileSize(att.originalSize)}）` : ""} ·{" "}
          {att.uploader.name} ·{" "}
          {new Date(att.createdAt).toLocaleDateString("ja-JP")}
        </p>
        {canEditKind && onKindChange && (
          <label className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <span>種類:</span>
            <select
              aria-label="書類の種類"
              value={att.docKind ?? ""}
              disabled={kindSaving}
              onChange={(e) => onKindChange(e.target.value === "" ? null : e.target.value)}
              className={`rounded border px-1 py-0.5 text-xs ${
                kindCheck
                  ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                  : "border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              }`}
            >
              <option value="">その他</option>
              {DOC_STAGES.map((stage) => (
                <optgroup key={stage.code} label={stage.short ? `${stage.short} ${stage.label}` : stage.label}>
                  {DOC_KINDS.filter((k) => k.stage === stage.code).map((k) => (
                    <option key={k.code} value={k.code}>{k.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {kindCheck && (
              <span className="text-amber-700 dark:text-amber-300">
                {kindLabel ? "自動で当てました。確かめてください" : "種類を選んでください"}
              </span>
            )}
            {kindCheck && att.docKind && (
              // 自動で当てた種類が合っているとき、同じ選択肢は onChange が走らないので「確定」を置く
              // (同じ種類で保存すると確からしさが manual になり、確認の表示が消える・@codex #556 P2)。
              <Button
                variant="ghost"
                size="sm"
                disabled={kindSaving}
                onClick={() => onKindChange(att.docKind ?? null)}
                className="h-6 px-2 text-xs text-indigo-600 dark:text-indigo-400"
              >
                この種類で確定
              </Button>
            )}
          </label>
        )}
      </div>
      {previewable && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onPreviewClick}
          className="shrink-0 text-gray-400 dark:text-gray-500 hover:text-indigo-500"
          title="プレビュー"
        >
          <Eye className="h-4 w-4" />
        </Button>
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
      <Button
        variant="ghost"
        size="sm"
        onClick={onDeleteClick}
        className="shrink-0 text-gray-400 dark:text-gray-500 hover:text-red-500"
        title="削除"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
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
  const downloadHref = sendsDownloadIntent(att) ? withDownloadIntent(safeUrl) : safeUrl;
  // registry は表示名・保存名ともに generic（att.fileName の PII を client 表示にも出さない）。
  const displayName = isRegistry
    ? registryDisplayName(att.registryCertificateType, att.createdAt)
    : displayTitle(att);
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
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-gray-500 dark:text-gray-400"
              title="閉じる"
            >
              <X className="h-5 w-5" />
            </Button>
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
