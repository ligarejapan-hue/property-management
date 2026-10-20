"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { FilterPanel } from "@/components/ui/filter-panel";
import { Button } from "@/components/ui/button";
import { formatJaDateTime } from "@/lib/format-datetime";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Eye,
  ArrowRight,
  FileUp,
  DownloadCloud,
} from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import Link from "next/link";
import {
  fetchImportJobs,
  fetchUsers,
  fetchStuckImportJobs,
  markImportJobFailed,
  previewReceptionOwnerCsv,
  importReceptionOwnerCsv,
  previewReceptionPropertyCsv,
  importReceptionPropertyCsv,
  readFileForImport,
  type ReceptionOwnerPreviewResponse,
  type ReceptionOwnerImportResponse,
  type ReceptionPropertyPreviewResponse,
  type ReceptionPropertyImportResponse,
  type StuckImportJob,
} from "@/lib/api-client";
import ImportSwitcher from "@/components/import/import-switcher";
import FileDropZone from "@/components/ui/file-drop-zone";
import { draftKey } from "@/lib/drafts/draft-store";
import { hasImportResultShape, isDefiniteSubmitFailure } from "@/lib/drafts/submit-outcome";
import {
  canTrustJobHistory,
  compactCsvImportDraftForPending,
  csvDraftAfterImport,
  HISTORY_SETTLE_MS,
  initialHistoryReadyAt,
  decideCsvImportRestore,
  nextCsvPending,
  type CsvPendingEvent,
  type CsvPendingState,
  isCsvImportDraftEmpty,
  parseCsvImportDraft,
  unifyReceptionDraft,
  type CsvImportDraft,
} from "@/lib/drafts/screens/csv-import";
import { useClientReady, useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import { DraftImportPendingNotice, DraftRestoredNotice, DraftTooLargeNotice, IMPORT_HISTORY_ID } from "@/components/drafts/draft-notices";
import {
  IMPORT_TYPE_FILTER_OPTIONS,
  getImportTypeLabel,
} from "@/lib/import-labels";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportJobSummary {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  needsReviewCount: number;
  errorCount: number;
  totalCount: number;
}

interface ImportJob {
  id: string;
  jobType: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  successCount: number | null;
  errorCount: number | null;
  createdAt: string;
  executor: { id: string; name: string };
  // 段階A: API 側で動的計算した 5 区分の集計を含む。旧データや
  // フォールバック時は undefined になる可能性があるため optional。
  summary?: ImportJobSummary;
  // 手動で failed 化されたジョブ（AuditLog 由来）。UI バッジ表示に使う。
  isManuallyFailed?: boolean;
}

interface ImportJobFilters {
  jobType: string; // "" = すべて
  executedBy: string; // "" = すべて
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

const DEFAULT_JOB_FILTERS: ImportJobFilters = { jobType: "", executedBy: "", from: "", to: "" };

/** 絞り込みなしの1ページ目か(取り込んだばかりの履歴が必ず見える表示)。 */
function isDefaultJobView(f: ImportJobFilters, page: number): boolean {
  return page === 1 && f.jobType === "" && f.executedBy === "" && f.from === "" && f.to === "";
}

const JOB_TYPE_OPTIONS = IMPORT_TYPE_FILTER_OPTIONS;

/** 成功の返事として読むのに要る欄(欠けていたら取り込まれたか分からない扱い・@codex P2)。 */
const RO_RESULT_SHAPE = {
  numbers: ["successCount", "needsReviewCount", "errorCount", "propertyUpdatedCount", "ownerCreatedCount", "ownerLinkedCount"],
  objects: ["summary"],
} as const;
const RP_RESULT_SHAPE = { numbers: ["successCount", "needsReviewCount", "errorCount"] } as const;
const UNREADABLE_IMPORT_RESULT = "取り込みの返事を読み取れませんでした。下の取り込み履歴で取り込まれたか確かめてください。";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  string,
  { label: string; icon: typeof CheckCircle2; color: string }
> = {
  completed: { label: "完了", icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { label: "エラーあり", icon: XCircle, color: "text-red-600 dark:text-red-400" },
  processing: { label: "処理中", icon: Loader2, color: "text-blue-600 dark:text-blue-400" },
  pending: { label: "待機中", icon: AlertTriangle, color: "text-amber-600 dark:text-amber-400" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function RoStat({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: number;
  tone?: "blue" | "green" | "amber" | "gray";
}) {
  const toneClass = {
    blue: "text-blue-700 dark:text-blue-300",
    green: "text-green-700 dark:text-green-300",
    amber: "text-amber-700 dark:text-amber-300",
    gray: "text-gray-600 dark:text-gray-300",
  }[tone];
  return (
    <div className="rounded bg-white dark:bg-gray-900 px-3 py-2 shadow-sm">
      <div className="text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

// 要レビュー行に対して、レビュー担当が「次にどこを直せば取り込めるか」が一目で分かるよう
// 理由ごとに具体的な修正先 / 確認先を示す。propertyId / 候補ID は preview API が
// 返してくる範囲のみで判定し、無理に推測しない。
function ReviewActionHint({
  sample,
}: {
  sample: ReceptionOwnerPreviewResponse["reviewSamples"][number];
}) {
  switch (sample.reason) {
    case "owner_unmatched":
      // 物件は特定できているが、所有者CSV側に同キーの行が無い → 所有者CSVのC列を確認
      return (
        <div className="space-y-1">
          <div className="text-gray-700 dark:text-gray-200">
            所有者CSV C列のキー
            <code className="mx-1 rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[10px]">
              {sample.matchKey || "(空)"}
            </code>
            と一致する行を確認
          </div>
          {sample.propertyId && (
            <Link
              href={`/properties/${sample.propertyId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              対象物件を開く <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      );
    case "property_not_found":
      // 物件未特定: DBに該当物件なし。新規登録 or 既存物件側を修正
      return (
        <div className="space-y-1">
          <div className="text-gray-700 dark:text-gray-200">
            該当物件が未登録
            {sample.lotNumber && (
              <>
                （地番:
                <code className="mx-1 rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[10px]">
                  {sample.lotNumber}
                </code>
                ）
              </>
            )}
            {sample.buildingNumber && (
              <>
                （家屋番号:
                <code className="mx-1 rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[10px]">
                  {sample.buildingNumber}
                </code>
                ）
              </>
            )}
          </div>
          <Link
            href="/properties"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            物件一覧で確認 / 新規登録 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      );
    case "property_multiple":
      // 候補複数: いずれかを正として確定する必要がある
      return (
        <div className="space-y-1">
          <div className="text-gray-700 dark:text-gray-200">
            候補が {sample.candidateCount} 件あります。正しい物件を選んで直接更新してください。
          </div>
          {sample.candidatePropertyIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sample.candidatePropertyIds.map((pid, i) => (
                <Link
                  key={pid}
                  href={`/properties/${pid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
                >
                  候補{i + 1} <ArrowRight className="h-3 w-3" />
                </Link>
              ))}
            </div>
          )}
        </div>
      );
    case "property_no_key":
      // 受付帳側に地番/家屋番号が抽出できていない → F列(区分)とK列を確認
      return (
        <div className="space-y-1">
          <div className="text-gray-700 dark:text-gray-200">
            受付帳の地番/家屋番号が空。F列(区分=
            <code className="mx-1 rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[10px]">
              {sample.fColumn || "(空)"}
            </code>
            )とK列(=
            <code className="mx-1 rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[10px]">
              {sample.kColumn || "(空)"}
            </code>
            )を確認してください。
          </div>
        </div>
      );
    default:
      return <span className="text-gray-400 dark:text-gray-500">-</span>;
  }
}

function ImportScreen({ draftEnabled }: { draftEnabled: boolean }) {
  // 作業中の控え(設計書 §2 S4)。3つの流れをまとめて1つの鍵に置く。
  const draftKeyValue = draftEnabled ? draftKey("csv-import") : null;
  const restored = useRestoredDraft(draftKeyValue, parseCsvImportDraft);
  // ⚠この画面は useState の初期化で1回だけ決める(描き直しで変わらない)。
  const [restoreDecision] = useState(() => decideCsvImportRestore(restored));
  // 第4回 D: 受付帳は1回だけ入れる=①と②の控えを1つのファイル・1組の条件にそろえて戻す。
  const s0 = unifyReceptionDraft(restoreDecision.start);

  // Job history
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobFilters, setJobFilters] = useState<ImportJobFilters>({
    jobType: "",
    executedBy: "",
    from: "",
    to: "",
  });
  // ページネーション state（page=1始まり）
  const [jobPage, setJobPage] = useState(1);
  const [jobLimit, setJobLimit] = useState<20 | 50 | 100>(50);
  const [jobPagination, setJobPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null>(null);

  // 異常ジョブ（processing のまま指定時間以上経過）。マウント時に
  // 取得して件数 0 でなければ警告セクションを表示する。
  const [stuckJobs, setStuckJobs] = useState<StuckImportJob[]>([]);
  const [stuckThresholdMin, setStuckThresholdMin] = useState<number>(10);
  const [stuckLoading, setStuckLoading] = useState(false);
  const [markingJobId, setMarkingJobId] = useState<string | null>(null);

  // 実行者フィルタ用の全ユーザー一覧。
  // 履歴の current page に登場する executor だけだとフィルタ対象が
  // 不十分なため、起動時に /api/users から全アクティブユーザーを取得して
  // dropdown のソースにする。/api/users は assignee dropdown などで
  // 既に全ロール共通で利用されており、追加の権限調整は不要。
  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string }>>(
    [],
  );

  // Reception × Owner (2-file) state
  // csvText または xlsxBase64 のどちらかが入る
  const [receptionFile, setReceptionFile] = useState<{
    name: string;
    csvText?: string;
    xlsxBase64?: string;
  } | null>(s0?.ro?.receptionFile ?? null);
  const [ownerFile, setOwnerFile] = useState<{
    name: string;
    csvText?: string;
    xlsxBase64?: string;
  } | null>(s0?.ro?.ownerFile ?? null);
  const [roPreview, setRoPreview] = useState<ReceptionOwnerPreviewResponse | null>((s0?.ro?.roPreview as never) ?? null);
  const [roResult, setRoResult] = useState<ReceptionOwnerImportResponse | null>(null);
  const [roLoading, setRoLoading] = useState(false);
  // どちらのボタンの処理中か(押した側だけに「処理中」の文言を出す)
  const [roBusy, setRoBusy] = useState<"preview" | "import" | null>(null);
  const [roError, setRoError] = useState<string | null>(null);
  // 取込条件: 既定は「DLに〇がついている物件のみ」かつ「既存のみ」
  const [dlFilter, setDlFilter] = useState<"marked" | "unmarked" | "all">(s0?.ro?.dlFilter ?? s0?.rp?.rpDlFilter ?? "marked");
  const [shinkiFilter, setShinkiFilter] = useState<"existing" | "new" | "all">(s0?.ro?.shinkiFilter ?? s0?.rp?.rpShinkiFilter ?? "existing");

  // Reception → Property (1-file) state
  const [rpFile, setRpFile] = useState<{
    name: string;
    csvText?: string;
    xlsxBase64?: string;
    // ⚠②の控え(ro.receptionFile)からは作り直さない。①が済むと①の控えは外れる(csvDraftAfterImport)ので、
    //   ここで②の受付帳を①へ戻すと、戻ったときに①がもう一度押せる形になり二重の取り込みへ誘う(@codex #523 P2)。
    //   ②の受付帳は共通の欄の表示(rpFile ?? receptionFile)と②だけで使う。
  } | null>(s0?.rp?.rpFile ?? null);
  const [rpPreview, setRpPreview] = useState<ReceptionPropertyPreviewResponse | null>((s0?.rp?.rpPreview as never) ?? null);
  const [rpResult, setRpResult] = useState<ReceptionPropertyImportResponse | null>(null);
  const [rpLoading, setRpLoading] = useState(false);
  // どちらのボタンの処理中か(ボタンの「処理中」の文言を押した側だけに出す。押せない状態は rpLoading のまま)
  const [rpBusy, setRpBusy] = useState<"preview" | "import" | null>(null);
  const [rpError, setRpError] = useState<string | null>(null);
  const [rpDlFilter, setRpDlFilter] = useState<"marked" | "unmarked" | "all">(s0?.rp?.rpDlFilter ?? s0?.ro?.dlFilter ?? "marked");
  const [rpShinkiFilter, setRpShinkiFilter] = useState<"existing" | "new" | "all">(s0?.rp?.rpShinkiFilter ?? s0?.ro?.shinkiFilter ?? "existing");

  const [restoredDismissed, setRestoredDismissed] = useState(false);

  const draftData = useMemo<CsvImportDraft>(
    () => ({
      rev: 1,
      // 画面に出ない古い取り込み手順(main)は第4回 D で外した。古い控えの main は読めるが戻さない。
      main: null,
      // 結果が出たら(取り込み済み)その流れは控えない。
      ro:
        (receptionFile || ownerFile) && !roResult
          ? { receptionFile, ownerFile, dlFilter, shinkiFilter, roPreview: roPreview as Record<string, unknown> | null }
          : null,
      rp:
        rpFile && !rpResult
          ? { rpFile, rpDlFilter, rpShinkiFilter, rpPreview: rpPreview as Record<string, unknown> | null }
          : null,
    }),
    [receptionFile, ownerFile, dlFilter, shinkiFilter, roPreview, roResult,
      rpFile, rpDlFilter, rpShinkiFilter, rpPreview, rpResult],
  );
  // ⚠送信中の印が残っていた控えは、中身は戻さず(上の restoreDecision)印だけ引き継ぐ。
  //   人が履歴で確かめる(帯のボタン)まで印を消さない=離れて戻っても案内が出続ける(§5.1 S4・@codex P1)。
  const draftSaver = useDraftAutosave(draftKeyValue, draftData, isCsvImportDraftEmpty, restored, {
    compactForPending: compactCsvImportDraftForPending,
  });
  // 取り込みが済んだとき、済んだ流れを外した形を書くため最新の控えの形を持っておく(描画中には書かない)。
  const draftDataRef = useRef(draftData);
  useEffect(() => {
    draftDataRef.current = draftData;
  }, [draftData]);

  /**
   * 「最初からやり直す」の世代。やり直した後に届いたファイルの読み込みは使わない
   * (届いた結果が、消したはずの控えを作り直さないように・@codex P2)。
   */
  const discardGenRef = useRef(0);

  // 送信中の印は3つの流れで1つ。数えて、全部済んだときだけ外す(@codex P1)。
  // ⚠前回の印を引き継いだときは「分からない」から始める(確かめるまで印を外さない・送れなくする)。
  const csvPendingRef = useRef<CsvPendingState>({ inflight: 0, unknown: restoreDecision.showPending });
  /** 結果が分からない(前回離れた/画面に残ったまま 5xx・通信切れ)。履歴で確かめるまで取り込みを止める。 */
  const [importBlocked, setImportBlocked] = useState(restoreDecision.showPending);
  const [importBlockReason, setImportBlockReason] = useState<"left" | "unknown">("left");
  /**
   * 下の取り込み履歴が、結果が分からなくなる前のままか。⚠古い履歴を見て「無かった」と
   *   確かめたことにさせない: 分からなくなった後に始めた読み込みが成功するまで true(@codex P1)。
   */
  const [historyStale, setHistoryStale] = useState(restoreDecision.showPending);
  const historyGenRef = useRef(0);
  /**
   * この時刻より後に始めた履歴の読み込みだけを根拠にする(サーバーがジョブを作り終える前の履歴で
   *   確かめさせない・@codex P1)。待っている間は「確かめた」を押させない。
   */
  const historyReadyAtRef = useRef(initialHistoryReadyAt(restored));
  const [historySettling, setHistorySettling] = useState(() => historyReadyAtRef.current > Date.now());
  const [historySettleKey, setHistorySettleKey] = useState(0);
  /** 履歴の読み込みの番号。最後に始めたもの以外の応答は捨てる(古い履歴で上書きしない)。 */
  const jobsReqRef = useRef(0);
  // ⚠どれかの取り込み中・結果が分からない間は「最初からやり直す」を出さない(送信中の印を消させない)。
  //   下見の返事を待つ間も出さない(届いた結果が控えを作り直す)。
  const importBusy = roLoading || rpLoading || importBlocked;
  const applyCsvPending = (e: CsvPendingEvent) => {
    const r = nextCsvPending(csvPendingRef.current, e);
    csvPendingRef.current = r.state;
    if (e === "start") draftSaver.markSubmitting();
    if (r.unmark) draftSaver.unmarkSubmitting();
    if (e === "unknown") {
      // 履歴を古い扱いにし、今回の取り込みが必ず見えるよう絞り込みを外して1ページ目へ戻す(@codex P1)。
      historyGenRef.current += 1;
      historyReadyAtRef.current = Date.now() + HISTORY_SETTLE_MS;
      setHistorySettling(true);
      setHistorySettleKey((k) => k + 1);
      setHistoryStale(true);
      setJobFilters(DEFAULT_JOB_FILTERS);
      setJobPage(1);
      setImportBlocked(true);
      setImportBlockReason("unknown");
    }
    if (e === "confirm") setImportBlocked(false);
  };
  /**
   * 1つの流れの取り込みが済んだ。済んだ流れを外した形を書いてから数える。
   * ⚠共有の形(ref)に積み重ねる: 画面を離れた後に2つ済むと、2つめが離れる前の形から作り直して
   *   先に済んだ流れを書き戻してしまう(@codex P1)。
   */
  const finishCsvFlow = (flow: "main" | "ro" | "rp") => {
    draftDataRef.current = csvDraftAfterImport(draftDataRef.current, flow);
    draftSaver.writeNow(draftDataRef.current);
    applyCsvPending("ok");
  };


  // ------ Jobs ------
  // jobFilters / jobPage / jobLimit はクライアント State なので
  // 最新値をクロージャに焼き込むため useCallback の deps に含める。
  const fetchJobs = useCallback(async () => {
    const gen = historyGenRef.current;
    const startedAt = Date.now();
    const req = ++jobsReqRef.current;
    setJobsLoading(true);
    try {
      // 日付フィルタは「YYYY-MM-DD」を受け取り、ISO 文字列に変換して渡す。
      // from は 00:00:00、to は 23:59:59 として丸める（同日入力で 0 件にならないように）。
      const fromIso =
        jobFilters.from !== ""
          ? new Date(`${jobFilters.from}T00:00:00`).toISOString()
          : undefined;
      const toIso =
        jobFilters.to !== ""
          ? new Date(`${jobFilters.to}T23:59:59.999`).toISOString()
          : undefined;
      const json = await fetchImportJobs({
        jobType: jobFilters.jobType || undefined,
        executedBy: jobFilters.executedBy || undefined,
        from: fromIso,
        to: toIso,
        page: jobPage,
        limit: jobLimit,
      });
      if (req !== jobsReqRef.current) return;
      setJobs((json.data ?? []) as ImportJob[]);
      setJobPagination(json.pagination ?? null);
      // ⚠絞り込みや2ページ目以降では今回の取り込みが見えないことがある=外さない。
      if (
        canTrustJobHistory({
          sameGen: gen === historyGenRef.current,
          defaultView: isDefaultJobView(jobFilters, jobPage),
          startedAt,
          readyAt: historyReadyAtRef.current,
        })
      ) {
        setHistoryStale(false);
      }
    } catch {
      // ignore
    } finally {
      if (req === jobsReqRef.current) setJobsLoading(false);
    }
  }, [jobFilters, jobPage, jobLimit]);

  // ⚠再読み込み(F5)では、控えを読む前の仮の画面がいったん作られて作り直される(下の ImportPage)。
  //   仮の画面では取りに行かない(初回の取得が2回走らないように)。
  useEffect(() => {
    if (!draftEnabled) return;
    fetchJobs();
  }, [fetchJobs, draftEnabled]);

  // 待ち時間が過ぎたら履歴を自動で読み直す(その読み込みが確かめる根拠になる)。
  const fetchJobsRef = useRef(fetchJobs);
  useEffect(() => {
    fetchJobsRef.current = fetchJobs;
  }, [fetchJobs]);
  useEffect(() => {
    if (!historySettling) return;
    const t = setTimeout(() => {
      setHistorySettling(false);
      fetchJobsRef.current();
    }, Math.max(0, historyReadyAtRef.current - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [historySettling, historySettleKey]);

  // 異常ジョブの取得。履歴一覧と独立してマウント時に1度引く。
  // マーク失敗操作後にも再取得するため useCallback にしておく。
  const fetchStuck = useCallback(async () => {
    setStuckLoading(true);
    try {
      const res = await fetchStuckImportJobs();
      setStuckJobs(res.data);
      setStuckThresholdMin(res.thresholdMinutes);
    } catch {
      // 異常ジョブ取得は致命ではない（メイン履歴 UI は動作継続）
      setStuckJobs([]);
    } finally {
      setStuckLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!draftEnabled) return;
    fetchStuck();
  }, [fetchStuck, draftEnabled]);

  // 異常ジョブを「失敗にする」操作。確認ダイアログ → API 呼び出し →
  // 異常ジョブ一覧と履歴一覧の両方を refetch（履歴側に failed として反映する）。
  const handleMarkStuckFailed = async (jobId: string) => {
    if (
      !window.confirm(
        "このジョブを「失敗」として確定します。元には戻せません。よろしいですか？",
      )
    ) {
      return;
    }
    setMarkingJobId(jobId);
    try {
      await markImportJobFailed(jobId);
      // 異常ジョブ一覧から消し、履歴側で failed として表示されるよう両方更新
      await Promise.all([fetchStuck(), fetchJobs()]);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "失敗化に失敗しました",
      );
    } finally {
      setMarkingJobId(null);
    }
  };

  /**
   * フィルタ変更時のヘルパ。値の更新と同時に「常に 1 ページ目に戻す」。
   * ページ送り中にフィルタを変えると意味のないオフセットになるため、
   * 必ずページを 1 に戻してから refetch する。
   */
  const updateJobFilter = <K extends keyof ImportJobFilters>(
    key: K,
    value: ImportJobFilters[K],
  ) => {
    setJobFilters((prev) => ({ ...prev, [key]: value }));
    setJobPage(1);
  };

  const updateJobLimit = (next: 20 | 50 | 100) => {
    setJobLimit(next);
    setJobPage(1);
  };

  // 実行者ドロップダウンの選択肢は /api/users から取得した全アクティブ
  // ユーザー一覧を使う。これにより「現在表示中のページに含まれていない
  // 実行者」も絞り込み対象として選べるようになる。
  // フェッチは初回マウント時のみ（ユーザーマスタは滅多に変わらないため）。
  useEffect(() => {
    if (!draftEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchUsers();
        if (cancelled) return;
        // /api/users は { id, name, role } を返す。表示には id / name のみ使う。
        const list = ((json.data ?? []) as Array<{ id: string; name: string }>)
          .map((u) => ({ id: u.id, name: u.name ?? "" }))
          // name 昇順（API側でも sort 済みだがクライアント側でも安定化）
          .sort((a, b) => a.name.localeCompare(b.name, "ja"));
        setAllUsers(list);
      } catch {
        // 失敗時は dropdown は空のまま運用継続（フィルタ機能のみ縮退）
        if (!cancelled) setAllUsers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftEnabled]);

  // dropdown 表示用。name が空なら短縮 id をフォールバックに表示する。
  const executorOptions = useMemo(
    () =>
      allUsers.map((u) => ({
        id: u.id,
        label: u.name && u.name.trim() !== "" ? u.name : `(名前未設定 ${u.id.slice(0, 8)})`,
      })),
    [allUsers],
  );

  const handleResetJobFilters = () => {
    setJobFilters({ jobType: "", executedBy: "", from: "", to: "" });
    setJobPage(1);
  };

  // ------ Reception × Owner ------
  // 受付帳は上の共通の欄(handleReceptionFile)で入れる。ここは所有者ファイルだけ(第4回 D)。
  const handleOwnerFile = async (file: File | null) => {
    const gen = discardGenRef.current;
    setRoError(null);
    setRoPreview(null);
    setRoResult(null);
    if (!file) {
      setOwnerFile(null);
      return;
    }
    // B-11: ファイル名では拒否しない。種別はプレビュー時にサーバーが
    // 内容(列構成)から判定し、取り違えのみエラーにする。
    try {
      const buf = await readFileForImport(file);
      if (gen !== discardGenRef.current) return;
      setOwnerFile({ name: file.name, csvText: buf.csvText, xlsxBase64: buf.xlsxBase64 });
    } catch (e) {
      setRoError(e instanceof Error ? e.message : "ファイル読込に失敗しました");
    }
  };

  const handleRoPreview = async () => {
    if (!receptionFile || !ownerFile) return;
    setRoLoading(true);
    setRoBusy("preview");
    setRoError(null);
    setRoResult(null);
    try {
      const res = await previewReceptionOwnerCsv({
        receptionFileName: receptionFile.name,
        ownerFileName: ownerFile.name,
        receptionCsv: receptionFile.csvText,
        ownerCsv: ownerFile.csvText,
        receptionXlsxBase64: receptionFile.xlsxBase64,
        ownerXlsxBase64: ownerFile.xlsxBase64,
        dlFilter,
        shinkiFilter,
      });
      setRoPreview(res);
    } catch (e) {
      setRoError(e instanceof Error ? e.message : "プレビューに失敗しました");
    } finally {
      setRoLoading(false);
      setRoBusy(null);
    }
  };

  const handleRoImport = async () => {
    if (importBlocked) return;
    if (!receptionFile || !ownerFile) return;
    if (!window.confirm("一意特定できた行だけを既存物件に反映します。よろしいですか？")) return;
    setRoLoading(true);
    setRoBusy("import");
    setRoError(null);
    applyCsvPending("start");
    try {
      const res = await importReceptionOwnerCsv({
        receptionFileName: receptionFile.name,
        ownerFileName: ownerFile.name,
        receptionCsv: receptionFile.csvText,
        ownerCsv: ownerFile.csvText,
        receptionXlsxBase64: receptionFile.xlsxBase64,
        ownerXlsxBase64: ownerFile.xlsxBase64,
        dlFilter,
        shinkiFilter,
      });
      if (!hasImportResultShape(res, RO_RESULT_SHAPE)) throw new Error(UNREADABLE_IMPORT_RESULT);
      setRoResult(res);
      finishCsvFlow("ro");
      fetchJobs();
    } catch (e) {
      applyCsvPending(isDefiniteSubmitFailure(e) ? "definite" : "unknown");
      // 結果が分からないときも履歴を読み直す(古い履歴を見て「無かった」と思わせない)。
      fetchJobs();
      setRoError(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setRoLoading(false);
      setRoBusy(null);
    }
  };

  const handleRoReset = () => {
    setReceptionFile(null);
    setOwnerFile(null);
    setRoPreview(null);
    setRoResult(null);
    setRoError(null);
    setDlFilter("marked");
    setShinkiFilter("existing");
  };

  // ------ Reception → Property ------
  const handleRpPreview = async () => {
    if (!rpFile) return;
    setRpLoading(true);
    setRpBusy("preview");
    setRpError(null);
    setRpResult(null);
    try {
      const res = await previewReceptionPropertyCsv({
        receptionFileName: rpFile.name,
        receptionCsv: rpFile.csvText,
        receptionXlsxBase64: rpFile.xlsxBase64,
        dlFilter: rpDlFilter,
        shinkiFilter: rpShinkiFilter,
      });
      setRpPreview(res);
    } catch (e) {
      setRpError(e instanceof Error ? e.message : "プレビューに失敗しました");
    } finally {
      setRpLoading(false);
      setRpBusy(null);
    }
  };

  const handleRpImport = async () => {
    if (importBlocked) return;
    if (!rpFile) return;
    if (!window.confirm("住所が既存物件と重複しない行を物件として新規作成します。よろしいですか？")) return;
    setRpLoading(true);
    setRpBusy("import");
    setRpError(null);
    applyCsvPending("start");
    try {
      const res = await importReceptionPropertyCsv({
        receptionFileName: rpFile.name,
        receptionCsv: rpFile.csvText,
        receptionXlsxBase64: rpFile.xlsxBase64,
        dlFilter: rpDlFilter,
        shinkiFilter: rpShinkiFilter,
      });
      if (!hasImportResultShape(res, RP_RESULT_SHAPE)) throw new Error(UNREADABLE_IMPORT_RESULT);
      setRpResult(res);
      finishCsvFlow("rp");
      fetchJobs();
    } catch (e) {
      applyCsvPending(isDefiniteSubmitFailure(e) ? "definite" : "unknown");
      // 結果が分からないときも履歴を読み直す(古い履歴を見て「無かった」と思わせない)。
      fetchJobs();
      setRpError(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setRpLoading(false);
      setRpBusy(null);
    }
  };

  const handleRpReset = () => {
    setRpFile(null);
    setRpPreview(null);
    setRpResult(null);
    setRpError(null);
    setRpDlFilter("marked");
    setRpShinkiFilter("existing");
  };

  // ------ 受付帳(①②共通・第4回 D) ------
  // 受付帳は1回だけ入れる。画面の state は流れごとに2つのまま(控え・送信中の印の数え方を変えない)で、
  // 入れたファイルと取込条件を両方へ同じものとして渡す。変えたら両方の下見を捨てる(下見と違う中身で取り込ませない)。
  const handleReceptionFile = async (file: File | null) => {
    const gen = discardGenRef.current;
    setRpError(null);
    setRpPreview(null);
    setRpResult(null);
    setRoError(null);
    setRoPreview(null);
    setRoResult(null);
    if (!file) {
      setRpFile(null);
      setReceptionFile(null);
      return;
    }
    // B-11: ファイル名では拒否しない (種別はプレビュー時に内容から判定)。
    try {
      const buf = await readFileForImport(file);
      if (gen !== discardGenRef.current) return;
      const entry = { name: file.name, csvText: buf.csvText, xlsxBase64: buf.xlsxBase64 };
      setRpFile(entry);
      setReceptionFile(entry);
    } catch (e) {
      setRpError(e instanceof Error ? e.message : "ファイル読込に失敗しました");
    }
  };

  const changeDlFilter = (v: "marked" | "unmarked" | "all") => {
    setRpDlFilter(v);
    setDlFilter(v);
    setRpPreview(null);
    setRoPreview(null);
  };
  const changeShinkiFilter = (v: "existing" | "new" | "all") => {
    setRpShinkiFilter(v);
    setShinkiFilter(v);
    setRpPreview(null);
    setRoPreview(null);
  };

  const handleReceptionReset = () => {
    handleRpReset();
    handleRoReset();
  };

  /** ②の所有者ファイルだけ外す(受付帳と条件は①と共通なので残す)。 */
  const handleOwnerClear = () => {
    setOwnerFile(null);
    setRoPreview(null);
    setRoResult(null);
    setRoError(null);
  };

  const handleDiscardDraft = () => {
    discardGenRef.current += 1;
    draftSaver.discard();
    handleRoReset();
    handleRpReset();
    setRestoredDismissed(true);
  };

  return (
    <div data-pii-protected data-pii-surface="import">
      <ImportSwitcher />
      <PageHeader
        title="受付帳CSV取込"
        description="受付帳のCSV / Excel(.xlsx) から物件を新規作成し、所有者CSVで所有者を紐づけます。"
      />
      {importBlocked && (
        <div className="mb-4">
          <DraftImportPendingNotice reason={importBlockReason} settling={historySettling} confirmDisabled={historySettling || jobsLoading || historyStale} historyError={historyStale && !jobsLoading && !historySettling} onDismiss={() => applyCsvPending("confirm")} />
        </div>
      )}
      {restoreDecision.start && restored && !restoredDismissed && !importBusy && (
        <div className="mb-4">
          <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleDiscardDraft} />
        </div>
      )}
      {draftSaver.tooLarge && (
        <div className="mb-4">
          <DraftTooLargeNotice />
        </div>
      )}

      {/* 利用者向け操作ガイド: 取込の順番と各CSVの役割を説明 */}
      <div className="mb-6 rounded-lg border border-blue-200 dark:border-blue-400/20 bg-blue-50 dark:bg-blue-500/10 p-4 text-sm">
        <p className="mb-2 font-semibold text-blue-900 dark:text-blue-300">取込の進め方</p>
        <ol className="ml-4 list-decimal space-y-1 text-blue-900 dark:text-blue-300">
          <li>
            <span className="font-medium">受付帳を1回入れる</span>
            <span className="ml-1 text-blue-700 dark:text-blue-300">— 取込条件（DL・新既）もここで1回だけ選びます</span>
          </li>
          <li>
            <span className="font-medium">① 物件を新規作成</span>
            <span className="ml-1 text-blue-700 dark:text-blue-300">— 受付帳の行から住所・地番・区分で物件レコードを作成します</span>
          </li>
          <li>
            <span className="font-medium">② 所有者ファイルで所有者を付ける</span>
            <span className="ml-1 text-blue-700 dark:text-blue-300">— ①で作成した物件に所有者情報を紐づけます</span>
          </li>
          <li>
            <span className="font-medium">謄本PDF</span> は物件詳細または<Link href="/import/registry-pdf" className="font-semibold underline underline-offset-2">専用ページ</Link>から登録します
          </li>
        </ol>
        <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">
          物件が未登録の状態で所有者ファイルを取り込んでも、所有者は物件に紐づきません。①を先に実行してください。
        </p>
      </div>

      {/* ============ 受付帳を入れる(①②共通・第4回 D) ============ */}
      {/* 以前は①と②で同じ受付帳を2回入れていた。1回だけ入れ、取込条件も1組にする。 */}
      <div id="reception-shared" data-testid="reception-shared" className="mb-8 scroll-mt-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6">
        <div className="mb-4 flex items-center gap-2">
          <FileUp className="h-5 w-5 text-green-600 dark:text-green-400" />
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">
            受付帳を入れる（CSV / Excel(.xlsx) 対応）
          </h3>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          受付帳は1回だけ入れます。下の①（物件を作る）と②（所有者を付ける）の両方で、このファイルと取込条件を使います。
        </p>

        {/* 取込条件: プレビュー・取込の両方(①②とも)に同じ条件が適用される */}
        <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-3">
          <div className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-200">取込条件</div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <span className="text-xs text-gray-500 dark:text-gray-400">取込物件選択（DL）</span>
              <select
                value={rpDlFilter}
                onChange={(e) => changeDlFilter(e.target.value as typeof rpDlFilter)}
                disabled={rpLoading || roLoading}
                className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-sm"
              >
                <option value="marked">DLに〇がついている物件のみ</option>
                <option value="unmarked">DLに〇がついていない物件のみ</option>
                <option value="all">両方</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <span className="text-xs text-gray-500 dark:text-gray-400">新既</span>
              <select
                value={rpShinkiFilter}
                onChange={(e) => changeShinkiFilter(e.target.value as typeof rpShinkiFilter)}
                disabled={rpLoading || roLoading}
                className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-sm"
              >
                <option value="existing">既存のみ</option>
                <option value="new">新規のみ</option>
                <option value="all">両方</option>
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            条件はプレビュー・取り込み実行の両方（①②とも）に同じものが適用されます。物件住所は「都道府県＋区＋住所＋番地」から作成されます。受付番号は取り込まず、「他」列は共有名義人の有無として扱います。
          </p>
        </div>

        {/* ファイル選択 (D&D) */}
        <div className="mb-3">
          <FileDropZone
            accept=".csv,.tsv,.txt,.xlsx"
            onFiles={(files) => void handleReceptionFile(files[0])}
            onNoneAccepted={() => void handleReceptionFile(null)}
            title="CSV または Excel(.xlsx) ファイルをここにドラッグ＆ドロップ"
            hint="受付帳のファイル — 種別は中身の列構成から自動判定します"
            fileName={rpFile?.name ?? receptionFile?.name ?? null}
          />
        </div>
        {(rpFile || receptionFile || ownerFile || rpPreview || rpResult || roPreview || roResult) && (
          <Button
            variant="secondary"
            onClick={handleReceptionReset}
            disabled={rpLoading || roLoading}
          >
            <RefreshCw className="h-4 w-4" />
            選択をクリア（①②とも）
          </Button>
        )}
      </div>

      {/* ============ ① 受付帳から物件を新規作成 ============ */}
      <div className="mb-8 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6">
        <div className="mb-4 flex items-center gap-2">
          <FileUp className="h-5 w-5 text-green-600 dark:text-green-400" />
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">
            ① 受付帳から物件を新規作成
          </h3>
          <span className="ml-2 rounded bg-green-50 dark:bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
            物件を新規作成
          </span>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          上で入れた受付帳から、住所が既存物件と重複しない行だけ物件レコードを新規作成します。
          地番・家屋番号・区分も自動で設定します。所有者の紐づけは②で行います。
        </p>
        <ol className="mb-3 ml-5 list-decimal space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
          <li>「プレビュー」で新規作成予定・重複・住所なし件数を確認</li>
          <li>「取り込む」で物件を作成</li>
        </ol>
        {!rpFile && receptionFile && (
          <p
            data-testid="rp-reception-kept-for-owner"
            className="mb-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300"
          >
            上の受付帳は②（所有者を付ける）のために残しています。①は前回この受付帳で済ませた可能性があります（下の取り込み履歴で確かめられます）。①をもう一度行うときは、上で受付帳を入れ直してください。
          </p>
        )}

        {/* ボタン */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleRpPreview}
            disabled={!rpFile || rpLoading}
            loading={rpBusy === "preview"}
            loadingLabel="プレビュー中"
          >
            <Eye className="h-4 w-4" />
            プレビュー
          </Button>
          {/* 0件のときは緑にしない(押せそうに見えないよう白の枠に。C-2) */}
          <Button
            variant={rpPreview && rpPreview.summary.toCreateCount > 0 ? "success" : "secondary"}
            onClick={handleRpImport}
            disabled={!rpPreview || rpPreview.summary.toCreateCount === 0 || rpLoading || importBlocked}
            loading={rpBusy === "import"}
            loadingLabel="取り込み中"
          >
            <DownloadCloud className="h-4 w-4" />
            取り込む（{rpPreview?.summary.toCreateCount ?? 0}件作成）
          </Button>
        </div>

        {/* エラー */}
        {rpError && (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {rpError}
          </div>
        )}

        {/* プレビュー結果 */}
        {rpPreview && !rpResult && (
          <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4">
            <p className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">プレビュー結果</p>
            {/* B-11: サーバー側のファイル種別判定の結果と注意を表示 */}
            {rpPreview.receptionFileType.label && (
              <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
                {rpPreview.receptionFileType.label}
              </p>
            )}
            {rpPreview.receptionFileType.warning && (
              <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
                {rpPreview.receptionFileType.warning}
              </p>
            )}
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded bg-green-50 dark:bg-green-500/10 p-2 text-center">
                <div className="text-xl font-bold text-green-700 dark:text-green-300">{rpPreview.summary.toCreateCount}</div>
                <div className="text-xs text-green-600 dark:text-green-300">新規作成</div>
              </div>
              <div className="rounded bg-amber-50 dark:bg-amber-500/10 p-2 text-center">
                <div className="text-xl font-bold text-amber-700 dark:text-amber-300">{rpPreview.summary.duplicateCount}</div>
                <div className="text-xs text-amber-600 dark:text-amber-300">既存と重複</div>
              </div>
              <div className="rounded bg-gray-50 dark:bg-gray-800/50 p-2 text-center">
                <div className="text-xl font-bold text-gray-600 dark:text-gray-300">{rpPreview.summary.noAddressCount}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">住所なし</div>
              </div>
              <div className="rounded bg-gray-50 dark:bg-gray-800/50 p-2 text-center">
                <div className="text-xl font-bold text-gray-600 dark:text-gray-300">{rpPreview.summary.filteredCount}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">フィルタ除外</div>
              </div>
            </div>
            {rpPreview.toCreateSamples.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">新規作成サンプル（最大5件）</p>
                <div className="overflow-auto rounded border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-800/50">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">行</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">区分</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">住所</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">地番</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {rpPreview.toCreateSamples.map((s) => (
                        <tr key={s.rowNumber}>
                          <td className="px-2 py-1 text-gray-500 dark:text-gray-400">{s.rowNumber}</td>
                          <td className="px-2 py-1 dark:text-gray-200">{s.fColumn || "—"}</td>
                          <td className="px-2 py-1 dark:text-gray-200">{s.propertyAddress}</td>
                          <td className="px-2 py-1 text-gray-500 dark:text-gray-400">{s.lotNumber ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 取込結果 */}
        {rpResult && (
          <div className="rounded-md border border-green-200 dark:border-green-400/20 bg-green-50 dark:bg-green-500/10 p-4">
            <p className="mb-2 text-sm font-semibold text-green-800 dark:text-green-300">取込完了</p>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="text-center">
                <div className="text-xl font-bold text-green-700 dark:text-green-300">{rpResult.successCount}</div>
                <div className="text-xs text-green-600 dark:text-green-300">作成成功</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-yellow-700 dark:text-amber-300">{rpResult.needsReviewCount}</div>
                <div className="text-xs text-yellow-600 dark:text-amber-300">要レビュー</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-red-700 dark:text-red-300">{rpResult.errorCount}</div>
                <div className="text-xs text-red-600 dark:text-red-300">エラー</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ============ ② 受付帳 × 所有者で所有者を付ける(受付帳は上で入れたもの・第4回 D) ============ */}
      {/* ⚠id はメニューの「所有者CSV取込」の着地点(@codex #411 R1 P2)。
          この作業は同じページの下の方にあり、上から入ると見つからない。
          scroll-mt-4 = 固定ヘッダに隠れない余白。 */}
      <div
        id="owner-match"
        className="mb-8 scroll-mt-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6"
      >
        <div className="mb-4 flex items-center gap-2">
          <FileUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">
            ② 所有者ファイルで所有者を付ける（CSV / Excel(.xlsx) 対応）
          </h3>
          <span className="ml-2 rounded bg-blue-50 dark:bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
            既存物件に反映
          </span>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          上で入れた受付帳と所有者ファイルをキーで突合し、一意に特定できた行だけを既存物件に反映します。
          共有名義人は複数行のまま残します。空値では既存データを上書きしません。
        </p>
        <ol className="mb-3 ml-5 list-decimal space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
          <li>所有者ファイルを選択（所有者名・住所などを読み込みます。受付帳は上で入れたものを使います）</li>
          <li>「突合結果をプレビュー」で突合成功・未突合・要レビューを確認</li>
          <li>「確認済みデータを取り込む」で一意に特定できた行だけを反映</li>
        </ol>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          ※売却DMの対象は、所有者ファイルで DM列が〇 だった物件のみです(それ以外は送付対象になりません)。
        </p>
        {/* ⚠メニューの「所有者CSV取込」(/import#owner-match)はここへ直接着く。受付帳の欄は上にあり見えないので、
            受付帳が無いときは理由と上へのリンクを出す(押せないプレビューだけ残さない・@codex #523 P2)。 */}
        {!receptionFile && (
          <p
            data-testid="owner-match-needs-reception"
            className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
          >
            {rpFile
              ? // ①の控えだけが戻った=②は前回この受付帳で済ませたのかもしれない(作り直さない・@codex #523 P2)。
                "上の受付帳は①（物件を作る）のために残しています。②は前回この受付帳で済ませた可能性があります（下の取り込み履歴で確かめられます）。②を行うときは、"
              : "先に、"}
            このページ上部の
            <a href="#reception-shared" className="mx-1 font-semibold underline underline-offset-2">「受付帳を入れる」</a>
            {rpFile ? "で受付帳を入れ直してください。" : "に受付帳を入れてください（②は上で入れた受付帳と所有者ファイルを突き合わせます）。"}
          </p>
        )}

        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          所有者ファイルの「物件住所」が、受付帳の物件住所と一致した場合のみ紐づけます。所有者住所は「都道府県＋所有者市区郡＋所有者住所＋建物名」を連結し、〒は別フィールドとして郵便番号に保存します。No / DL / 受付番号 / 「他」は紐づけキーに使いません。
        </p>

        <div className="mb-4">
          {/* 所有者 D&D */}
          <FileDropZone
            accept=".csv,.tsv,.txt,.xlsx"
            onFiles={(files) => void handleOwnerFile(files[0])}
            onNoneAccepted={() => void handleOwnerFile(null)}
            title="CSV または Excel(.xlsx) ファイルをここにドラッグ＆ドロップ"
            hint="所有者 — 種別は中身の列構成から自動判定します"
            fileName={ownerFile?.name ?? null}
          />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={handleRoPreview}
            disabled={!receptionFile || !ownerFile || roLoading}
            loading={roBusy === "preview"}
            loadingLabel="突合中"
          >
            <Eye className="h-4 w-4" />
            突合結果をプレビュー
          </Button>
          <Button
            variant="success"
            onClick={handleRoImport}
            disabled={!roPreview || roLoading || importBlocked}
            loading={roBusy === "import"}
            loadingLabel="取り込み中"
          >
            <ArrowRight className="h-4 w-4" />
            確認済みデータを取り込む
          </Button>
          <Button
            variant="secondary"
            onClick={handleOwnerClear}
            disabled={roLoading}
          >
            <RefreshCw className="h-4 w-4" />
            所有者ファイルをクリア
          </Button>
        </div>

        {roError && (
          <div className="mb-4 rounded-md border border-red-200 dark:border-red-400/20 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="mr-1 inline h-4 w-4" />
            {roError}
          </div>
        )}

        {roPreview && (
          <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4">
            <div className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">突合結果サマリ</div>
            {/* B-11: サーバー側のファイル種別判定の結果と注意を表示 */}
            {(roPreview.receptionFileType.label || roPreview.ownerFileType.label) && (
              <div className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
                受付帳: {roPreview.receptionFileType.label ?? "—"} / 所有者:{" "}
                {roPreview.ownerFileType.label ?? "—"}
              </div>
            )}
            {(roPreview.receptionFileType.warning || roPreview.ownerFileType.warning) && (
              <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
                {roPreview.receptionFileType.warning && (
                  <div>{roPreview.receptionFileType.warning}</div>
                )}
                {roPreview.ownerFileType.warning && (
                  <div>{roPreview.ownerFileType.warning}</div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <RoStat label="受付帳件数" value={roPreview.summary.receptionCount} />
              <RoStat label="所有者件数" value={roPreview.summary.ownerCount} />
              <RoStat label="所有者突合成功" value={roPreview.summary.ownerMatchedCount} tone="green" />
              <RoStat label="所有者未突合" value={roPreview.summary.ownerUnmatchedCount} tone="amber" />
              <RoStat label="物件一意特定" value={roPreview.summary.propertyMatchedCount} tone="green" />
              <RoStat label="物件未特定" value={roPreview.summary.propertyNotFoundCount} tone="amber" />
              <RoStat label="複数候補" value={roPreview.summary.propertyMultipleCount} tone="amber" />
              <RoStat label="キー不足" value={roPreview.summary.propertyNoKeyCount} tone="gray" />
              <RoStat label="除外（非データ行）" value={roPreview.summary.excludedCount - roPreview.summary.filteredByDlCount - roPreview.summary.filteredByShinkiCount} tone="gray" />
              <RoStat label="DL条件で除外" value={roPreview.summary.filteredByDlCount} tone="gray" />
              <RoStat label="新既条件で除外" value={roPreview.summary.filteredByShinkiCount} tone="gray" />
            </div>
            {roPreview.summary.excludedCount > 0 && (
              <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                内訳: 空行 {roPreview.summary.excludedEmptyCount} / ヘッダ反復{" "}
                {roPreview.summary.excludedHeaderRepeatCount} / 集計行{" "}
                {roPreview.summary.excludedAggregateCount} / 共担{" "}
                {roPreview.summary.excludedCoCollateralCount}
                <span className="ml-2">※突合・レビューの対象外にしています</span>
              </div>
            )}

            {roPreview.matchedSamples.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
                  反映対象サンプル（最大20件）
                </div>
                <div className="max-h-52 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-300">
                      <tr>
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">物件住所</th>
                        <th className="px-2 py-1">所有者数</th>
                        <th className="px-2 py-1">所有者名</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {roPreview.matchedSamples.map((s) => (
                        <tr key={s.rowNumber}>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.rowNumber}</td>
                          <td className="px-2 py-1 text-gray-800 dark:text-gray-100">{s.propertyAddress}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.ownerCount}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.ownerNames.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {roPreview.reviewSamples.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                    要レビューサンプル（最大20件）
                  </div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400">
                    理由ごとに「次にどこを直せばよいか」を右端に表示します
                  </div>
                </div>
                <div className="max-h-72 overflow-auto rounded border border-amber-200 dark:border-amber-400/25 bg-white dark:bg-gray-900">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      <tr>
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">理由</th>
                        <th className="px-2 py-1">物件状態</th>
                        <th className="px-2 py-1">F列</th>
                        <th className="px-2 py-1">K列</th>
                        <th className="px-2 py-1">候補数</th>
                        <th className="px-2 py-1">所有者数</th>
                        <th className="px-2 py-1">次のアクション</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {roPreview.reviewSamples.map((s) => (
                        <tr key={s.rowNumber} className="align-top">
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.rowNumber}</td>
                          <td className="px-2 py-1 text-amber-700 dark:text-amber-300">{s.reasonLabel}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">
                            {{
                              matched: "既存あり",
                              not_found: "未特定",
                              multiple: "複数候補",
                              no_key: "キー不足",
                            }[s.propertyStatus]}
                          </td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.fColumn}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.kColumn}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.candidateCount}</td>
                          <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{s.ownerCount}</td>
                          <td className="px-2 py-1">
                            <ReviewActionHint sample={s} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {roResult && (
          <div className="rounded-md border border-green-200 dark:border-green-400/20 bg-green-50 dark:bg-green-500/10 p-4 text-sm text-green-800 dark:text-green-300">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              取込完了（ジョブID: {roResult.jobId}）
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div>反映: <b>{roResult.successCount}</b></div>
              <div>要レビュー: <b>{roResult.needsReviewCount}</b></div>
              <div>エラー: <b>{roResult.errorCount}</b></div>
              <div>物件更新: <b>{roResult.propertyUpdatedCount}</b></div>
              <div>所有者作成: <b>{roResult.ownerCreatedCount}</b></div>
              <div>所有者紐付: <b>{roResult.ownerLinkedCount}</b></div>
            </div>
          </div>
        )}
      </div>

      {/* ============ 異常ジョブ（processing のまま放置） ============
          過去の不具合で残ったスタックジョブを可視化する運用セクション。
          件数 0 のときは丸ごと非表示。1 件以上あるときだけ警告色の枠で表示する。 */}
      {stuckJobs.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-300 dark:border-amber-400/25 bg-amber-50 dark:bg-amber-500/10 p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-amber-900 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                異常ジョブ（{stuckJobs.length} 件）
              </h3>
              <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                {stuckThresholdMin} 分以上 <code className="rounded bg-white/70 dark:bg-gray-900/50 px-1 font-mono text-[11px]">processing</code>{" "}
                のまま残っているジョブです。「失敗にする」を押して整理してください（自動修復はされません）。
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchStuck}
              disabled={stuckLoading}
              className="text-amber-700 dark:text-amber-300"
              title="再読み込み"
              aria-label="再読み込み"
            >
              <RefreshCw
                className={`h-4 w-4 ${stuckLoading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          <div className="overflow-x-auto rounded border border-amber-200 dark:border-amber-400/25 bg-white dark:bg-gray-900">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-amber-200 dark:border-amber-400/25 bg-amber-100/50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-300">
                <tr>
                  <th className="px-2 py-1.5 font-medium">種別</th>
                  <th className="px-2 py-1.5 font-medium">ファイル名</th>
                  <th className="px-2 py-1.5 font-medium">実行者</th>
                  <th className="px-2 py-1.5 font-medium">作成日時</th>
                  <th className="px-2 py-1.5 font-medium text-right">経過</th>
                  <th className="px-2 py-1.5 font-medium text-right">行数</th>
                  <th className="px-2 py-1.5 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100 dark:divide-amber-400/15">
                {stuckJobs.map((job) => (
                  <tr key={job.jobId} className="hover:bg-amber-50/50 dark:hover:bg-amber-500/10">
                    <td className="px-2 py-1.5 text-gray-700 dark:text-gray-200 text-[11px]">
                      {getImportTypeLabel(job.jobType)}
                    </td>
                    <td className="px-2 py-1.5 text-gray-800 dark:text-gray-100">
                      <Link
                        href={`/import/jobs/${job.jobId}`}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        {job.fileName}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
                      {job.executor.name}
                    </td>
                    <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400">
                      {formatJaDateTime(job.createdAt)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-amber-800 dark:text-amber-300">
                      {job.elapsedMinutes}分
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-300">
                      {job.rowCount}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {/* 他人の取込は import:manage が無いと失敗にできない
                          (Codex #349 R10 P2: 押して確認してから 403 を防ぐ)。 */}
                      {job.canMutate !== false && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleMarkStuckFailed(job.jobId)}
                        disabled={markingJobId === job.jobId}
                        loading={markingJobId === job.jobId}
                      >
                        <XCircle className="h-3 w-3" />
                        失敗にする
                      </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============ Job History ============ */}
      <div id={IMPORT_HISTORY_ID} className="scroll-mt-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">取込履歴</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchJobs}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            title="再読み込み"
            aria-label="再読み込み"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* ---- フィルタ UI(第2弾⑥⑦: FilterPanel=よく使う+詳細条件▾) ---- */}
        <FilterPanel
          className="mb-4"
          primary={
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  種別
                </label>
                <select
                  value={jobFilters.jobType}
                  onChange={(e) => updateJobFilter("jobType", e.target.value)}
                  className="w-44 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 py-1 px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  {JOB_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  実行者
                </label>
                <select
                  value={jobFilters.executedBy}
                  onChange={(e) => updateJobFilter("executedBy", e.target.value)}
                  className="w-44 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 py-1 px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="">すべての実行者</option>
                  {executorOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="self-end"
                onClick={handleResetJobFilters}
              >
                フィルタをクリア
              </Button>
            </>
          }
          advancedCount={[jobFilters.from, jobFilters.to].filter(Boolean).length}
          advanced={
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  日付（開始）
                </label>
                <input
                  type="date"
                  value={jobFilters.from}
                  onChange={(e) => updateJobFilter("from", e.target.value)}
                  className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 py-1 px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  日付（終了）
                </label>
                <input
                  type="date"
                  value={jobFilters.to}
                  onChange={(e) => updateJobFilter("to", e.target.value)}
                  className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 dark:text-gray-100 py-1 px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>
          }
        />

        {/* ---- ページネーション バー（テーブル上部）----
            APIから返る pagination をそのまま信頼し、件数表示・limit 切替・
            前後ページ操作を提供する。pagination が未取得 (= 初回ロード中)
            または total=0 でもレイアウトが崩れないようガードする。 */}
        {(() => {
          const total = jobPagination?.total ?? 0;
          const totalPages = jobPagination?.totalPages ?? 1;
          const currentPage = jobPagination?.page ?? jobPage;
          const currentLimit = jobPagination?.limit ?? jobLimit;
          return (
            <Pagination
              className="mb-3"
              page={currentPage}
              totalPages={totalPages}
              total={total}
              pageSize={currentLimit}
              busy={jobsLoading}
              onPrev={() => setJobPage((p) => Math.max(1, p - 1))}
              onNext={() =>
                setJobPage((p) =>
                  jobPagination ? Math.min(jobPagination.totalPages, p + 1) : p + 1,
                )
              }
            >
                <label className="flex items-center gap-1">
                  <span className="text-gray-500 dark:text-gray-400">1ページあたり</span>
                  <select
                    value={jobLimit}
                    onChange={(e) =>
                      updateJobLimit(Number(e.target.value) as 20 | 50 | 100)
                    }
                    className="rounded border border-gray-300 bg-white py-0.5 px-1.5 text-xs dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value={20}>20件</option>
                    <option value={50}>50件</option>
                    <option value={100}>100件</option>
                  </select>
                </label>
            </Pagination>
          );
        })()}

        {jobsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            条件に合う取込履歴はありません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">状態</th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    ファイル名
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">種別</th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">行数</th>
                  {/* 段階A: ImportJobRow から動的に算出した 5 区分。
                      旧データや行が空のジョブでは summary が無いので "-" 表示。 */}
                  <th
                    className="px-3 py-2 font-medium text-green-700 dark:text-green-300"
                    title="新規作成（success かつ「更新」プレフィックス無し）"
                  >
                    新規
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-blue-700 dark:text-blue-300"
                    title="既存レコード更新（success かつ errorMessage が「更新...」）"
                  >
                    更新
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300"
                    title="スキップ（status === skipped）"
                  >
                    スキップ
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-amber-700 dark:text-amber-300"
                    title="要レビュー（status === needs_review）"
                  >
                    要レビュー
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-red-700 dark:text-red-300"
                    title="純エラー（status === error。要レビューを含まない）"
                  >
                    エラー
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    実行者
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">日時</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {jobs.map((job) => {
                  const config =
                    STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
                  const Icon = config.icon;
                  const summary = job.summary;
                  const cell = (n: number | undefined, color: string) =>
                    summary ? (
                      <span className={n && n > 0 ? color : "text-gray-300 dark:text-gray-600"}>
                        {n ?? 0}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">-</span>
                    );
                  return (
                    <tr
                      key={job.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                      onClick={() =>
                        (window.location.href = `/import/jobs/${job.id}`)
                      }
                    >
                      <td className="px-3 py-2">
                        <span
                          className={`flex items-center gap-1 text-xs ${config.color}`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {config.label}
                        </span>
                        {/* 手動で failed 化されたジョブの目印。
                            通常の取込失敗 (status=failed) と運用上区別したい
                            ケース向け。AuditLog 由来なので確実性が高い。 */}
                        {job.isManuallyFailed && (
                          <span
                            className="mt-0.5 inline-flex items-center gap-0.5 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800"
                            title="processing 残留ジョブを手動で failed に確定したジョブ"
                          >
                            手動失敗
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-indigo-600 dark:text-indigo-400 hover:underline">
                        {job.fileName}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {getImportTypeLabel(job.jobType)}
                      </td>
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                        {job.totalRows ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.createdCount, "text-green-700 dark:text-green-300 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.updatedCount, "text-blue-700 dark:text-blue-300 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.skippedCount, "text-gray-700 dark:text-gray-200")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.needsReviewCount, "text-amber-700 dark:text-amber-300 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {cell(summary?.errorCount, "text-red-700 dark:text-red-300 font-medium")}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                        {job.executor.name}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {formatJaDateTime(job.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** 控えはブラウザで描き直した後だけ読む(F5 でサーバー描画と食い違わないように)。 */
export default function ImportPage() {
  const clientReady = useClientReady();
  return <ImportScreen key={clientReady ? "client" : "server"} draftEnabled={clientReady} />;
}
