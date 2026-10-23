"use client";

/**
 * 書類の受け取り箱(2026-10-10 査定報告書 → 2026-10-24 全書類)。
 *
 * 書類(PDF・画像・Excel など)をここへドラッグ&ドロップ →
 * 本文から読んだマンション名・部屋番号・所在地(または登録済みの物件名)で物件の候補を出し、
 * 種類(売買契約書・管理規約・賃貸借契約書…)も自動で当てる →
 * 人が確かめて「この物件に添付」。査定報告書は今までどおり「査定報告書」として、それ以外は
 * 通常の添付として段階のフォルダに入る。
 *
 * ⚠自動では添付しない(候補を出すだけ)。⚠添付しなかったものも消さない(発注者決定)。
 * ⚠使えるのは所有者情報をすべて見られる人だけ(報告書・契約書・本人確認書類に氏名が載るため)。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Loader2, Search, Trash2 } from "lucide-react";
import { DOC_KINDS, DOC_STAGES, docKindByCode, docStageLabel } from "@/lib/doc-classify/classify";
import { MAX_ATTACHMENT_BYTES } from "@/lib/pdf-compress/policy";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Pagination } from "@/components/ui/pagination";
import ImportSwitcher from "@/components/import/import-switcher";
import FileDropZone from "@/components/ui/file-drop-zone";
import {
  attachReportInboxItem,
  deleteReportInboxItem,
  fetchReportInbox,
  searchPropertiesForReportInbox,
  uploadReportToInbox,
  type ReportInboxCandidate,
  type ReportInboxItem,
  type ReportInboxSearchRow,
} from "@/lib/api-client";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { keepSelectionIfShown } from "@/lib/report-inbox/selection";
import { MAX_PDF_UPLOAD_BYTES } from "@/lib/pdf-compress/policy";

const MATCH_LABELS: Record<ReportInboxCandidate["match"], string> = {
  name_room: "マンション名・部屋番号が一致",
  name: "マンション名が一致(部屋番号は違う)",
  address_room: "所在地・部屋番号が一致",
  address: "所在地が一致",
};

const LARGE_PDF_BYTES = 8 * 1024 * 1024;

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

interface UploadProgress {
  name: string;
  state: "waiting" | "uploading" | "done" | "error";
  message?: string;
}

export default function ReportInboxPage() {
  const [items, setItems] = useState<ReportInboxItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetchReportInbox(page);
      // 最後のページの報告書を処理して空になったら、1つ前のページへ戻る。
      if (res.data.length === 0 && page > 1) {
        setPage(page - 1);
        return;
      }
      setItems(res.data);
      setTotal(res.total);
      setPageSize(res.pageSize);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 複数のファイルは1つずつ順番に送る(サーバーの圧縮も1本ずつのため)。
  const handleFiles = async (files: File[]) => {
    const list: UploadProgress[] = files.map((f) => ({ name: f.name, state: "waiting" }));
    setUploads(list);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      const update = (p: Partial<UploadProgress>) =>
        setUploads((prev) => prev.map((u, j) => (j === i ? { ...u, ...p } : u)));
      // PDF は 50MB まで(8MB を超える分は自動で圧縮)。それ以外は物件の添付と同じ 20MB まで。
      const limit = isPdf ? MAX_PDF_UPLOAD_BYTES : MAX_ATTACHMENT_BYTES;
      if (f.size > limit) {
        update({ state: "error", message: `大きすぎます(${formatMb(limit)}まで)` });
        continue;
      }
      update({
        state: "uploading",
        message: isPdf && f.size > LARGE_PDF_BYTES ? "大きいPDFを圧縮して受け取っています…(数十秒かかることがあります)" : "受け取っています…",
      });
      try {
        await uploadReportToInbox(f);
        update({ state: "done", message: "受け取りました" });
      } catch (e) {
        update({ state: "error", message: e instanceof Error ? e.message : "受け取れませんでした" });
      }
    }
    await load();
  };

  const uploading = uploads.some((u) => u.state === "uploading" || u.state === "waiting");

  return (
    <div>
      <ImportSwitcher />
      <PageHeader
        title="書類の受け取り箱"
        description="どの物件のものか決まっていない書類(査定報告書・契約書・管理規約・賃貸借契約書など)をここに入れると、本文から読んだマンション名・部屋番号・所在地で添付先の物件を探し、種類も自動で当てます。確かめてから「この物件に添付」を押してください(自動では添付しません)。"
      />

      <div className="max-w-4xl space-y-6">
        <FileDropZone
          accept=".pdf,.xlsx,.xls,.csv,.docx,.jpg,.jpeg,.png,.webp,.heic"
          multiple
          disabled={uploading}
          title="書類をここにドラッグ＆ドロップ"
          hint={`PDFは${formatMb(MAX_PDF_UPLOAD_BYTES)}まで(8MBを超えるものは自動で圧縮して保存)・Excel/Word/CSV/画像は${formatMb(MAX_ATTACHMENT_BYTES)}まで`}
          onFiles={(files) => void handleFiles(files)}
        />

        {uploads.length > 0 && (
          <ul className="space-y-1 text-sm" aria-live="polite">
            {uploads.map((u, i) => (
              <li key={`${i}-${u.name}`} className="flex items-center gap-2">
                {u.state === "uploading" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                <span className="truncate text-gray-700 dark:text-gray-200">{u.name}</span>
                <span
                  className={
                    u.state === "error"
                      ? "text-red-600 dark:text-red-400"
                      : u.state === "done"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-gray-500 dark:text-gray-400"
                  }
                >
                  {u.state === "waiting" ? "順番待ち" : u.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">
            未処理の書類{!loading && !loadError ? `(${total}件)` : ""}
          </h2>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              読み込んでいます…
            </p>
          ) : loadError ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {loadError}
            </p>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">未処理の書類はありません。</p>
          ) : (
            <>
              <ul className="space-y-4">
                {items.map((item) => (
                  <InboxItemCard key={item.id} item={item} onChanged={load} />
                ))}
              </ul>
              {total > pageSize && (
                <Pagination
                  className="mt-4"
                  page={page}
                  totalPages={Math.ceil(total / pageSize)}
                  total={total}
                  pageSize={pageSize}
                  onPrev={() => setPage(page - 1)}
                  onNext={() => setPage(page + 1)}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function InboxItemCard({ item, onChanged }: { item: ReportInboxItem; onChanged: () => Promise<void> }) {
  // ⚠最初から選んだ状態にしない(候補の先頭でも、人が見て選ぶ)。
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ReportInboxSearchRow[] | null>(null);
  // 種類は自動判別の結果を最初の値にし、人が選び直せる("" = その他)。
  const [kind, setKind] = useState<string>(item.docKind ?? "");
  const isSre = item.source === "sre";
  const kindChanged = (kind === "" ? null : kind) !== (item.docKind ?? null);
  const kindLabel = docKindByCode(kind)?.label ?? null;
  const needsKindCheck =
    !isSre && (item.docConfidence === "low" || (!item.docKind && !item.mimeType.startsWith("image/")));

  const attach = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await attachReportInboxItem(item.id, selected, kindChanged ? (kind === "" ? null : kind) : undefined);
      setDone(selected);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添付できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteReportInboxItem(item.id);
      setConfirmDelete(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除できませんでした");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      const rows = await searchPropertiesForReportInbox(query);
      setResults(rows);
      // ⚠表示から消えた物件の選択は外す(@codex PR#500 8巡目)。残すと、どれも選ばれていない見た目のまま
      //   「この物件に添付」で前に選んだ物件へ付いてしまう。
      setSelected((cur) =>
        keepSelectionIfShown(cur, [...item.candidates.map((c) => c.propertyId), ...rows.map((r) => r.id)]),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "探せませんでした");
    } finally {
      setSearching(false);
    }
  };

  const clue = [item.buildingName, item.roomNo ? `${item.roomNo}号室` : null].filter(Boolean).join(" ");

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <FileText className="h-4 w-4 shrink-0 text-gray-400" />
            <span className="truncate">{item.fileName}</span>
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {new Date(item.createdAt).toLocaleString("ja-JP")}
            {item.uploaderName ? `・${item.uploaderName}` : ""}・{formatMb(item.fileSize)}
            {item.originalSize ? `(自動で圧縮・元 ${formatMb(item.originalSize)})` : ""}
          </p>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
            書類から読んだ物件: {clue || "(マンション名を読み取れませんでした)"}
            {item.address ? ` / ${item.address}` : ""}
          </p>
          {/* 種類(自動判別の結果)。査定報告書(SRE の書式)は固定。それ以外は人が選び直せる。 */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">種類:</span>
            {isSre ? (
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                査定報告書(査定サイトの書式)
              </span>
            ) : (
              <>
                <select
                  aria-label="書類の種類"
                  value={kind}
                  disabled={busy || item.status !== "pending"}
                  onChange={(e) => setKind(e.target.value)}
                  className={`rounded border px-2 py-1 text-sm ${
                    needsKindCheck && !kindChanged
                      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                      : "border-gray-300 bg-white text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  }`}
                >
                  <option value="">その他(種類なし)</option>
                  {DOC_STAGES.map((stage) => (
                    <optgroup key={stage.code} label={stage.short ? `${stage.short} ${stage.label}` : stage.label}>
                      {DOC_KINDS.filter((k) => k.stage === stage.code).map((k) => (
                        <option key={k.code} value={k.code}>{k.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {kind ? `→ ${docStageLabel(docKindByCode(kind)?.stage)} のフォルダ` : "→ その他"}
                </span>
                {needsKindCheck && !kindChanged && (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    {kindLabel ? "自動で当てました。確かめてください" : "種類を選んでください(そのままなら「その他」)"}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {item.status === "pending" && (
            <a
              href={`/api/report-inbox/${item.id}/file`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              開く
            </a>
          )}
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            <Trash2 className="h-3.5 w-3.5" />
            削除
          </Button>
        </div>
      </div>

      {item.status !== "pending" && (
        <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          {item.status === "discarding"
            ? "削除の途中で止まっています。もう一度「削除」を押してください(この書類は添付できません)。"
            : "取り込みの途中で止まっています。「削除」を押してから、必要ならもう一度入れてください。"}
        </p>
      )}

      <fieldset className="mt-3 space-y-1" disabled={item.status !== "pending"}>
        <legend className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">添付先の物件</legend>
        {item.candidates.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            候補が見つかりませんでした。下の検索で物件を探してください。
          </p>
        )}
        {[...item.candidates.map((c) => ({ ...c, id: c.propertyId, label: MATCH_LABELS[c.match] })),
          ...(results ?? [])
            .filter((r) => !item.candidates.some((c) => c.propertyId === r.id))
            .map((r) => ({ ...r, propertyId: r.id, label: "検索で見つけた物件" }))].map((c) => (
          <label key={c.propertyId} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
            <input
              type="radio"
              name={`target-${item.id}`}
              checked={selected === c.propertyId}
              onChange={() => setSelected(c.propertyId)}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="text-gray-800 dark:text-gray-100">
                {[c.buildingName, c.roomNo ? `${c.roomNo}号室` : null].filter(Boolean).join(" ") || "(物件名なし)"}
              </span>
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {c.address}・{PROPERTY_TYPE_LABELS[c.propertyType] ?? c.propertyType}
              </span>
              <span className="ml-2 text-xs text-blue-700 dark:text-blue-300">{c.label}</span>
              <Link
                href={`/properties/${c.propertyId}`}
                target="_blank"
                className="ml-2 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                onClick={(e) => e.stopPropagation()}
              >
                物件を開く
              </Link>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && query.trim().length >= 2) {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="マンション名・所在地・部屋番号で探す(例: 東急ドエル 302)"
          aria-label="物件を探す"
          className="w-72 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
        />
        <Button variant="secondary" onClick={() => void search()} disabled={searching || query.trim().length < 2}>
          <Search className="mr-1 h-4 w-4" />
          探す
        </Button>
        {results !== null && results.length === 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">見つかりませんでした</span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => void attach()} disabled={!selected || busy || item.status !== "pending"}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          この物件に添付
        </Button>
        {done && <span className="text-sm text-emerald-700 dark:text-emerald-400">添付しました</span>}
        {error && (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="この書類を受け取り箱から削除しますか?"
          message="どの物件にも添付されずに消えます。元に戻せません(元のファイルから入れ直せます)。"
          confirmLabel="削除"
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </li>
  );
}
