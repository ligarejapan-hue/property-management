"use client";

/**
 * まとめてある PDF の分け方を確かめる小窓(2026-10-28 発注者依頼)。
 * サーバーの案(split-analyze)を出し、人が分け目と種類を直してから保存する。押すまで何も保存しない。
 * ⚠ページの中身は端末の中の PDF を新しいタブで開いて見る(サーバーへ取りに行かない)。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Scissors } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { DOC_KINDS, DOC_STAGES } from "@/lib/doc-classify/classify";
import { BUNDLE_ORIGINAL_KIND, REGISTRY_KIND, cutsOf, segmentsFromCuts } from "@/lib/pdf-split/segments";
import { segmentKindLabel } from "@/lib/attachments/unified-drop";
import type { BundleAnalysisResult, BundleSegment } from "@/lib/api-client";

/** 書類ごとの色(並びの順に繰り返す)。 */
const SEGMENT_COLORS = [
  "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-900/50 dark:text-rose-100",
  "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/50 dark:text-cyan-100",
  "bg-lime-100 text-lime-900 dark:bg-lime-900/50 dark:text-lime-100",
] as const;

/** 選べる種類(謄本・種類の表・その他)。元のファイルの種類は出さない。 */
const SELECTABLE_KINDS = DOC_KINDS.filter((k) => k.code !== BUNDLE_ORIGINAL_KIND);

export function pageRangeLabel(seg: { from: number; to: number }): string {
  return seg.from === seg.to ? `${seg.from}ページ` : `${seg.from}〜${seg.to}ページ`;
}

export default function SplitPdfDialog({
  file,
  analysis,
  onSave,
  onSaveWhole,
  onCancel,
}: {
  file: File;
  analysis: BundleAnalysisResult & { pageCount: number };
  onSave: (segments: BundleSegment[]) => Promise<void>;
  /** 分けずに保存。今の分け方を渡す(謄本のページが入っているかで名前を替えるため)。 */
  onSaveWhole: (segments: BundleSegment[]) => Promise<void>;
  onCancel: () => void;
}) {
  const pageCount = analysis.pageCount;
  const [cuts, setCuts] = useState<Set<number>>(() => cutsOf(analysis.segments));
  // 書類の種類は「始まりのページ」で覚える(分け目を動かしても、始まりが同じなら選び直した種類が残る)。
  const [kindByStart, setKindByStart] = useState<Map<number, string | null>>(
    () => new Map(analysis.segments.map((s) => [s.from, s.kind])),
  );
  const [saving, setSaving] = useState<"split" | "whole" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const segments = segmentsFromCuts(analysis.pageKinds, cuts, kindByStart);
  const segmentIndexOfPage = (page: number) => segments.findIndex((s) => page >= s.from && page <= s.to);

  // ページを見るための、端末の中の PDF の URL(押したときに作り、閉じたら片付ける)。
  const urlRef = useRef<string | null>(null);
  const pdfUrl = () => {
    if (urlRef.current === null) urlRef.current = URL.createObjectURL(file);
    return urlRef.current;
  };
  useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const toggleCut = (page: number) => {
    setCuts((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const changeKind = (from: number, kind: string | null) => {
    setKindByStart((prev) => new Map(prev).set(from, kind));
  };

  const run = async (mode: "split" | "whole") => {
    if (saving !== null) return;
    setSaving(mode);
    setError(null);
    try {
      if (mode === "split") await onSave(segments);
      else await onSaveWhole(segments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setSaving(null);
    }
  };

  const readFailed = analysis.ocr === "unavailable" || analysis.ocr === "failed";

  return (
    <ModalShell
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <Scissors className="h-5 w-5" aria-hidden="true" />
          このPDFには書類が{segments.length}つ入っています
        </span>
      }
      onClose={saving === null ? onCancel : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving !== null}>
            やめる
          </Button>
          <Button type="button" variant="secondary" onClick={() => void run("whole")} disabled={saving !== null}>
            {saving === "whole" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            分けずに1つのまま保存
          </Button>
          <Button type="button" onClick={() => void run("split")} disabled={saving !== null || segments.length < 2}>
            {saving === "split" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            この分け方で保存
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-gray-600 dark:text-gray-300">
          ページの間の「｜」を押すと、そこで分けたり、つなげたりできます。種類も選び直せます。
          ページの番号を押すと、そのページが新しいタブで開きます。
          <br />
          保存を押すまでは何も保存しません。元の1冊も「まとめてあるPDF(元のファイル)」として残します。
        </p>
        {readFailed && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            文字の無いページを読み取れなかったので、前の書類の続きとしてまとめています。分け目を確かめてください。
          </p>
        )}

        {/* ページの並びと分け目 */}
        <div className="flex flex-wrap items-center gap-y-2" aria-label="ページの分け方">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => {
            const idx = segmentIndexOfPage(page);
            return (
              <span key={page} className="flex items-center">
                {page > 1 && (
                  <button
                    type="button"
                    onClick={() => toggleCut(page)}
                    disabled={saving !== null}
                    aria-pressed={cuts.has(page)}
                    aria-label={cuts.has(page) ? `${page}ページの前をつなげる` : `${page}ページの前で分ける`}
                    title={cuts.has(page) ? "つなげる" : "ここで分ける"}
                    className={`mx-0.5 flex h-10 w-4 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      cuts.has(page)
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400"
                    }`}
                  >
                    <span className={`block h-8 rounded ${cuts.has(page) ? "w-1 bg-current" : "w-px bg-current"}`} />
                  </button>
                )}
                <a
                  href="#"
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => {
                    e.currentTarget.href = `${pdfUrl()}#page=${page}`;
                  }}
                  className={`flex h-10 w-8 items-end justify-center rounded border border-black/10 pb-0.5 text-xs tabular-nums ${SEGMENT_COLORS[idx % SEGMENT_COLORS.length]}`}
                  aria-label={`${page}ページを開く`}
                >
                  {page}
                </a>
              </span>
            );
          })}
        </div>

        {/* 書類ごとの種類 */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-2 py-1.5 font-medium">ページ</th>
                <th className="px-2 py-1.5 font-medium">種類</th>
                <th className="px-2 py-1.5 font-medium">入るところ</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg, i) => (
                <tr key={seg.from} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`mr-2 inline-block h-3 w-3 rounded-sm align-middle ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`} />
                    {pageRangeLabel(seg)}
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      aria-label={`${pageRangeLabel(seg)}の種類`}
                      value={seg.kind ?? ""}
                      disabled={saving !== null}
                      onChange={(e) => changeKind(seg.from, e.target.value === "" ? null : e.target.value)}
                      className="w-full max-w-xs rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    >
                      <option value={REGISTRY_KIND}>謄本</option>
                      {DOC_STAGES.map((stage) => (
                        <optgroup key={stage.code} label={stage.short ? `${stage.short} ${stage.label}` : stage.label}>
                          {SELECTABLE_KINDS.filter((k) => k.stage === stage.code).map((k) => (
                            <option key={k.code} value={k.code}>
                              {k.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      <option value="">その他</option>
                    </select>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-gray-600 dark:text-gray-300">
                    {seg.kind === REGISTRY_KIND ? "謄本PDF(面積を読みます)" : `添付ファイル(${segmentKindLabel(seg.kind)})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {segments.length < 2 && (
          <p className="text-gray-600 dark:text-gray-300">1つにまとめたときは「分けずに1つのまま保存」を押してください。</p>
        )}
        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
      </div>
    </ModalShell>
  );
}
