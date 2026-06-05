"use client";

import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import {
  useParams,
  useRouter,
  usePathname,
  useSearchParams,
} from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Plus,
  Link2,
  Ban,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  RotateCcw,
} from "lucide-react";
import {
  fetchImportJobDetail,
  fetchAffectedProperties,
  resolveImportRow,
  bulkResolveImportRows,
  retryImportRow,
  rollbackImportJob,
  searchProperties,
  searchOwners,
  manualLinkReceptionOwnerRow,
  type AffectedPropertiesResponse,
  type RollbackResponse,
} from "@/lib/api-client";
import {
  isDuplicateMessage,
  extractDuplicateReason,
  isUpdateMessage,
  extractUpdateReason,
  extractUpdatedFields,
} from "@/lib/import-row-display";
import { calcImportSummary, type ImportSummary } from "@/lib/import-summary";
import { classifyImportError } from "@/lib/import-error-display";
import { getImportTypeLabel } from "@/lib/import-labels";

// B2: import job detail rows の既定ページサイズ（server 側 MAX_ROW_LIMIT=100 以内）。
const ROW_LIMIT = 50;
// 候補5: ユーザーが切り替え可能な表示件数（いずれも server MAX_ROW_LIMIT=100 以内）。
const ROW_LIMIT_OPTIONS = [50, 100] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportJobRow {
  id: string;
  jobId: string;
  rowNumber: number;
  status: "success" | "error" | "skipped" | "needs_review";
  rawData: Record<string, string> | null;
  errorMessage: string | null;
  createdId: string | null;
  createdAt: string;
}

interface ImportJob {
  id: string;
  jobType: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  successCount: number | null;
  errorCount: number | null;
  executedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  executor: { id: string; name: string };
  rows: ImportJobRow[];
  // 段階A(PR-A): 詳細API がサーバ側 groupBy で算出した 5 区分サマリ。
  // 旧形状/モックでは未提供のこともあるため optional。
  summary?: ImportSummary;
  // B2: B1 で server が additive 返却する全体判定 / ページングメタ。
  isReceptionOwnerJob?: boolean;
  duplicateCount?: number;
  // B4(Codex P2): bulk-resolve scope="duplicate" の対象件数（needs_review のみ・「重複」始まり）。
  duplicateActionableCount?: number;
  pagination?: {
    page: number;
    limit: number;
    totalRows: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    status: string | null;
  };
}

interface SearchResult {
  id: string;
  address?: string;
  name?: string;
  lotNumber?: string | null;
  realEstateNumber?: string | null;
  propertyType?: string;
  nameKana?: string | null;
  phone?: string | null;
  externalLinkKey?: string | null;
}

type FilterStatus = "all" | "needs_review" | "error" | "success" | "skipped";

// 理由別 filter（Phase 2）: token は server の VALID_ROW_REASONS と一致させる
// （URL-safe な英語 enum・PII なし）。B4 bulk-resolve の scope="duplicate" と
// 衝突しないよう "duplicate" という token は使わない（dup_candidate）。
const ROW_REASON_OPTIONS = [
  { key: "dup_candidate", label: "重複候補" },
  { key: "address_dup", label: "住所重複（既存物件）" },
  { key: "no_address", label: "住所なし/空" },
  { key: "owner_unmatched", label: "所有者未突合" },
  { key: "no_key", label: "突合キー不足" },
  { key: "building_unresolved", label: "棟未解決" },
] as const;
type RowReason = (typeof ROW_REASON_OPTIONS)[number]["key"];
type ReasonFilter = RowReason | "all";

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const ROW_STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: typeof CheckCircle2 }
> = {
  success: {
    label: "成功",
    color: "text-green-700",
    bg: "bg-green-50 border-green-200",
    icon: CheckCircle2,
  },
  error: {
    label: "エラー",
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
    icon: XCircle,
  },
  needs_review: {
    label: "要レビュー",
    color: "text-amber-700",
    bg: "bg-amber-50 border-amber-200",
    icon: AlertTriangle,
  },
  skipped: {
    label: "スキップ",
    color: "text-gray-500",
    bg: "bg-gray-50 border-gray-200",
    icon: SkipForward,
  },
};

// 取込種別ラベルは共通定義 (src/lib/import-labels.ts) を使用

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ImportJobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const jobId = params.jobId as string;

  // B2: page / status を URL query から初期復元する。
  const initialFilter: FilterStatus = ((): FilterStatus => {
    const s = searchParams.get("status");
    return s === "needs_review" ||
      s === "error" ||
      s === "success" ||
      s === "skipped"
      ? s
      : "all";
  })();
  const initialPage: number = (() => {
    const n = Number(searchParams.get("page"));
    return Number.isInteger(n) && n >= 1 ? n : 1;
  })();
  // 候補5: limit を URL から復元。許可値（50/100）以外は既定 ROW_LIMIT に正規化する。
  const initialLimit: number = (() => {
    const n = Number(searchParams.get("limit"));
    return (ROW_LIMIT_OPTIONS as readonly number[]).includes(n) ? n : ROW_LIMIT;
  })();
  // 理由別 filter（Phase 2）: reason を URL から復元。allowlist 外は未指定（all）に正規化。
  const initialReason: ReasonFilter = (() => {
    const r = searchParams.get("reason");
    return r && ROW_REASON_OPTIONS.some((o) => o.key === r)
      ? (r as RowReason)
      : "all";
  })();

  const [job, setJob] = useState<ImportJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterStatus>(initialFilter);
  const [page, setPage] = useState<number>(initialPage);
  // 候補5: 表示件数（limit）切替とページジャンプ入力。
  const [limit, setLimit] = useState<number>(initialLimit);
  const [gotoPage, setGotoPage] = useState<string>("");
  // 理由別 filter（Phase 2）: 閲覧用の行絞り込み（"all"=未指定）。
  const [reason, setReason] = useState<ReasonFilter>(initialReason);

  // この取込で作成・更新された物件一覧（物件CSVジョブのみ）。
  // 主の job fetch と並列に取得する。失敗時は null のまま縮退表示。
  const [affected, setAffected] = useState<AffectedPropertiesResponse | null>(
    null,
  );

  // Row action state
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [editedData, setEditedData] = useState<Record<string, string>>({});

  // Rollback dialog state
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackPreview, setRollbackPreview] = useState<RollbackResponse | null>(null);
  const [rollbackResult, setRollbackResult] = useState<RollbackResponse | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // Search-and-link state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<SearchResult | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch job detail（B2: page/limit/status をサーバへ送る。status="all" は送らない）
  const fetchJob = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchImportJobDetail(jobId, {
        page,
        limit,
        status: filter === "all" ? undefined : filter,
        // 理由別 filter（Phase 2）: 未指定（all）は送らない（全理由・後方互換）。
        reason: reason === "all" ? undefined : reason,
      });
      const j = data as ImportJob;
      setJob(j);
      // B2: mutation 等で件数が減り現在ページが範囲外になったら安全にクランプ。
      const totalPages = j.pagination?.totalPages ?? 1;
      if (page > totalPages) setPage(totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [jobId, page, filter, limit, reason]);

  // この取込で作成・更新された物件一覧。job 本体とは別 API。
  // 行解決で createdId が増えた後にも最新化したいので、resolve / retry の
  // 完了直後にも呼べるよう関数化しておく。
  const fetchAffected = useCallback(async () => {
    try {
      const res = await fetchAffectedProperties(jobId);
      setAffected(res);
    } catch {
      // 取得失敗は致命ではない（メイン UI は動作継続）
      setAffected(null);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
    fetchAffected();
  }, [fetchJob, fetchAffected]);

  // B2: page / status を URL query に同期（履歴は置換・スクロール維持）。
  useEffect(() => {
    const sp = new URLSearchParams();
    if (filter !== "all") sp.set("status", filter);
    if (page > 1) sp.set("page", String(page));
    // 候補5: 既定（ROW_LIMIT）以外のときだけ limit を URL に載せる（page/status と整合）。
    if (limit !== ROW_LIMIT) sp.set("limit", String(limit));
    // 理由別 filter（Phase 2）: 未指定（all）のときは URL に載せない。
    if (reason !== "all") sp.set("reason", reason);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filter, page, limit, reason, pathname, router]);

  // B2: status タブ切り替え時は 1 ページ目に戻す。
  const changeFilter = (next: FilterStatus) => {
    setFilter(next);
    setPage(1);
  };

  // 候補5: 表示件数（limit）切替時は 1 ページ目に戻す（fetchJob deps の limit で再取得）。
  const changeLimit = (next: number) => {
    setLimit(next);
    setPage(1);
  };

  // 理由別 filter（Phase 2）: 理由変更時は 1 ページ目に戻す。
  const changeReason = (next: ReasonFilter) => {
    setReason(next);
    setPage(1);
  };

  // 候補5: ページジャンプ。入力値を 1〜totalPages に正規化してから移動する。
  const handleGoto = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const totalPages = job?.pagination?.totalPages ?? 1;
    const n = Math.floor(Number(gotoPage));
    if (!Number.isFinite(n) || n < 1) return;
    setPage(Math.min(n, totalPages));
    setGotoPage("");
  };

  // ロールバック確認ダイアログ起動 → dry-run で対象件数を取得
  const openRollbackDialog = useCallback(async () => {
    setRollbackOpen(true);
    setRollbackPreview(null);
    setRollbackResult(null);
    setRollbackError(null);
    setRollbackLoading(true);
    try {
      const res = await rollbackImportJob(jobId, true);
      setRollbackPreview(res);
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "プレビュー取得に失敗しました");
    } finally {
      setRollbackLoading(false);
    }
  }, [jobId]);

  // 実行（二重送信は rollbackLoading で防止）
  const executeRollback = useCallback(async () => {
    if (rollbackLoading) return;
    setRollbackLoading(true);
    setRollbackError(null);
    try {
      const res = await rollbackImportJob(jobId, false);
      setRollbackResult(res);
      // 実行後はジョブ状態を最新化
      await fetchJob();
      await fetchAffected();
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "ロールバックに失敗しました");
    } finally {
      setRollbackLoading(false);
    }
  }, [jobId, rollbackLoading, fetchJob, fetchAffected]);

  const closeRollbackDialog = () => {
    if (rollbackLoading) return;
    setRollbackOpen(false);
  };

  // 受付帳×所有者ジョブを行ベースで検出する。
  // jobType === "owner_csv" だが rawData に受付帳×所有者固有マーカがある場合は、
  // 検索対象を Owner ではなく Property に切り替え、紐づけ API も新パスを使う。
  // B2: 全体判定はサーバ確定値（job.isReceptionOwnerJob）を使う。
  // ページング後に現ページ分の rows.some(...) で誤判定しないため。
  const isReceptionOwnerJob = job?.isReceptionOwnerJob ?? false;
  // 既存の owner_csv 単独取込のときだけ Owner 検索モード。
  const useOwnerSearch = job?.jobType === "owner_csv" && !isReceptionOwnerJob;

  // Debounced search
  const doSearch = useCallback(
    async (query: string) => {
      if (!job || query.length < 2) {
        setSearchResults([]);
        return;
      }
      setSearchLoading(true);
      try {
        const result = useOwnerSearch
          ? await searchOwners(query)
          : await searchProperties(query);
        setSearchResults(result.data as SearchResult[]);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [job, useOwnerSearch],
  );

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    setSelectedTarget(null);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(value), 300);
  };

  // B2: rows はサーバが status で絞った現在ページ分。client では再フィルタしない。
  const filteredRows = job?.rows ?? [];

  // 段階A(PR-A): 5区分の集計は **サーバ側 summary (job.summary)** を一意の真実とする。
  // job.summary は詳細API が groupBy で算出して additive に返す値。旧形状/モックや
  // 取得前 (job=null) でも壊れないよう、未提供時のみ calcImportSummary(job.rows) に
  // フォールバックする。これにより後続の rows ページング(PR-B)でも件数が現ページに
  // 引きずられない。
  // B2: duplicate はサーバ確定の job.duplicateCount を使う（ジョブ全体・ページ分非依存）。
  const summary = job?.summary ?? calcImportSummary(job?.rows ?? []);
  const counts = {
    all: summary.totalCount,
    needs_review: summary.needsReviewCount,
    error: summary.errorCount,
    success: summary.createdCount + summary.updatedCount,
    skipped: summary.skippedCount,
    // 重複候補（B2: サーバ確定の duplicateCount=ジョブ全体・ページ分に化けない）。
    // 表示ヒント用（needs_review + skipped の内数・従来表示/互換）。
    duplicate: job?.duplicateCount ?? 0,
    // B4(Codex P2): bulk-resolve scope="duplicate" の actionable 件数（needs_review のみ）。
    // 「重複候補のみスキップ」ボタンの N と確認件数はこちらを使う（endpoint と一致・過大防止）。
    duplicateActionable: job?.duplicateActionableCount ?? 0,
    // 更新件数 (= summary.updatedCount のエイリアス。既存表示との互換のため残す)
    updated: summary.updatedCount,
    // 新規件数 (派生表示用)
    created: summary.createdCount,
  };

  // Handle row actions
  const handleResolve = async (
    rowId: string,
    action: "create_new" | "link_existing" | "skip" | "mark_error",
  ) => {
    setActionLoading(rowId);
    try {
      const targetId =
        action === "link_existing" ? selectedTarget?.id : undefined;
      const edited =
        action === "create_new" && editingRow === rowId
          ? editedData
          : undefined;
      // 受付帳×所有者ジョブの link_existing は新 API を呼び、Property 補完 +
      // Owner upsert + PropertyOwner link を transaction でまとめて実行する。
      if (action === "link_existing" && isReceptionOwnerJob && targetId) {
        await manualLinkReceptionOwnerRow(jobId, rowId, targetId);
      } else {
        await resolveImportRow(jobId, rowId, action, targetId, edited);
      }
      // F10-subset: affected-properties は status="success" かつ createdId 有りの行のみ
      // 由来（affected-properties/route.ts）。skip / mark_error は行を success+createdId に
      // しないため affected は不変＝fetchAffected は冗長。create_new / link_existing のみ
      // affected を更新するので、その時だけ再取得する。
      const mutatesAffected =
        action === "create_new" || action === "link_existing";
      await (mutatesAffected
        ? Promise.all([fetchJob(), fetchAffected()])
        : fetchJob());
      setExpandedRow(null);
      setEditingRow(null);
      setEditedData({});
      setSelectedTarget(null);
      setSearchQuery("");
      setSearchResults([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作に失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (rowId: string) => {
    setActionLoading(rowId);
    try {
      await retryImportRow(
        jobId,
        rowId,
        editingRow === rowId ? editedData : undefined,
      );
      await Promise.all([fetchJob(), fetchAffected()]);
      setExpandedRow(null);
      setEditingRow(null);
      setEditedData({});
    } catch (err) {
      alert(err instanceof Error ? err.message : "リトライに失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  // Start editing
  const startEdit = (row: ImportJobRow) => {
    setEditingRow(row.id);
    setEditedData(row.rawData ? { ...row.rawData } : {});
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditedData({});
  };

  // Batch actions（B3: 現在の status フィルタ needs_review / error の **全件** を
  // server-side where + updateMany で一括処理する。現ページに限定せず client は ID を持たない）。
  const handleBatchResolve = async (action: "skip" | "mark_error") => {
    if (filter !== "needs_review" && filter !== "error") return;
    const scope = filter; // "needs_review" | "error"
    // 件数は server summary（ジョブ全体）由来。現ページ件数ではない。
    const total =
      scope === "needs_review" ? summary.needsReviewCount : summary.errorCount;
    if (total === 0) return;
    const label = action === "skip" ? "スキップ" : "エラー確定";
    if (!confirm(`全 ${total} 件を「${label}」にしますか？`)) return;

    setActionLoading("batch");
    try {
      const res = await bulkResolveImportRows(jobId, { action, scope });
      // F10-subset: skip / mark_error の一括処理は行を success+createdId にしないため
      // affected は不変。fetchAffected を省略し fetchJob のみで行/件数を更新する。
      await fetchJob();
      alert(`${res.affectedCount} 件を処理しました`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作に失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  // B4: 重複候補（needs_review かつ errorMessage「重複」始まり）**だけ**を一括スキップする。
  // 「全件スキップ」(= needs_review 全件) とは別操作で、非重複の要レビュー行は残す。
  // 件数 N は server の job.duplicateActionableCount（= bulk endpoint scope="duplicate" の
  // where と完全一致＝needs_review のみ）由来。skipped 済み重複を含む duplicateCount は使わない
  // （確認件数が実処理件数より過大になるのを防ぐ・Codex P2）。現ページ件数でもない。
  const handleBulkResolveDuplicates = async () => {
    if (filter !== "needs_review") return;
    const total = counts.duplicateActionable; // job.duplicateActionableCount 由来
    if (total === 0) return;
    if (!confirm(`重複候補 全 ${total} 件を「スキップ」にしますか？`)) return;

    setActionLoading("batch");
    try {
      const res = await bulkResolveImportRows(jobId, {
        action: "skip",
        scope: "duplicate",
      });
      // F10-subset: 重複候補の一括スキップは affected を変えない（skip は success+
      // createdId にしない）。fetchAffected を省略する。
      await fetchJob();
      alert(`${res.affectedCount} 件を処理しました`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作に失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="py-10 text-center">
        <p className="mb-4 text-red-600">{error ?? "ジョブが見つかりません"}</p>
        <button
          onClick={() => router.back()}
          className="text-sm text-indigo-600 hover:underline"
        >
          戻る
        </button>
      </div>
    );
  }

  // 受付帳×所有者ジョブは jobType=owner_csv を流用しているため、
  // 純粋な所有者CSV取込のときだけ「Owner として扱う」UI を出す。
  const isOwnerJob = useOwnerSearch;

  return (
    // S1b-3: import job 詳細は rawData（住所/氏名/所有者名/電話 等の平文）・行ヘッダ
    // preview・検索結果・影響物件テーブルなど PII を表示する。root を broad container と
    // して保護し、copy/cut/contextmenu 抑止＋print scoping（PR #118）を surface="import"
    // で有効化する。container 内の button/a/input/select は screen-protection guard の
    // exemption で通常操作のまま（個別 marker は付けない）。
    <div data-pii-protected data-pii-surface="import">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/import"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-800">取込ジョブ詳細</h2>
          <p className="text-sm text-gray-500">
            {getImportTypeLabel(job.jobType)} - {job.fileName}
          </p>
        </div>
        {/* ロールバックボタン: 物件CSV かつ完了状態のみ。ロールバック済みはバッジ表示のみ */}
        {job.jobType === "property_csv" && job.status === "completed" && (
          <button
            onClick={openRollbackDialog}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
            title="この取込で作成された物件を削除します"
          >
            <RotateCcw className="h-4 w-4" />
            ロールバック
          </button>
        )}
        {job.status === "rolled_back" && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-sm font-medium text-purple-700">
            <RotateCcw className="h-4 w-4" />
            ロールバック済み
          </span>
        )}
      </div>

      {/* Job summary
          段階A: 既存の job.successCount / job.errorCount は使用せず、
          ImportJobRow から動的に再計算した 5 区分 (新規/更新/スキップ/要レビュー/エラー)
          を表示する。これは行単位 resolve 後の最新状態と整合させるため。 */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 lg:grid-cols-9">
          <div>
            <span className="text-gray-500">ステータス</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.status === "completed" && (
                <span className="text-green-600">完了</span>
              )}
              {job.status === "failed" && (
                <span className="text-red-600">エラーあり</span>
              )}
              {job.status === "processing" && (
                <span className="text-blue-600">処理中</span>
              )}
              {job.status === "pending" && (
                <span className="text-amber-600">待機中</span>
              )}
              {job.status === "rolled_back" && (
                <span className="text-purple-700">ロールバック済み</span>
              )}
            </div>
          </div>
          <div>
            <span className="text-gray-500">総行数</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.totalRows ?? job.rows.length ?? "-"}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="success かつ「更新」プレフィックス無し">
              新規
            </span>
            <div className="mt-0.5 font-medium text-green-600">
              {summary.createdCount}
            </div>
          </div>
          <div>
            <span
              className="text-gray-500"
              title="success かつ errorMessage が「更新...」"
            >
              更新
            </span>
            <div className="mt-0.5 font-medium text-blue-600">
              {summary.updatedCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="status === skipped">
              スキップ
            </span>
            <div className="mt-0.5 font-medium text-gray-700">
              {summary.skippedCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="status === needs_review">
              要レビュー
            </span>
            <div className="mt-0.5 font-medium text-amber-600">
              {summary.needsReviewCount}
            </div>
          </div>
          <div>
            <span
              className="text-gray-500"
              title="status === error（要レビューを含まない純エラー）"
            >
              エラー
            </span>
            <div className="mt-0.5 font-medium text-red-600">
              {summary.errorCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500">実行者</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.executor.name}
            </div>
          </div>
          <div>
            <span className="text-gray-500">実行日時</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.createdAt
                ? new Date(job.createdAt).toLocaleString("ja-JP")
                : "-"}
            </div>
          </div>
        </div>
        {/* 補助情報: 重複候補（表示ヒント。要レビュー/スキップ件数の内数） */}
        {counts.duplicate > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-2 text-xs text-amber-700">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            上記のうち <strong>{counts.duplicate} 件</strong>{" "}
            は重複検知（要レビュー / スキップ の内数）です
          </div>
        )}
      </div>

      {/* ============================================================
          この取込で作成・更新された物件 (将来のロールバック準備のための表示)
          ============================================================
          - jobType !== "property_csv" は applicable=false で対象外表示
          - applicable=true で件数 0 のときは「対象なし」
          - 一覧表示では isUpdate でバッジを切替（新規/更新）
          - 物件が削除済みの場合は found=false で「削除済み」バッジ */}
      {affected && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-700">
              この取込で作成・更新された物件
            </h3>
            {affected.applicable && affected.affected.length > 0 && (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">
                  全 <strong>{affected.affected.length}</strong> 件
                </span>
                <span className="text-green-700">
                  新規 <strong>{affected.createdCount}</strong>
                </span>
                <span className="text-blue-700">
                  更新 <strong>{affected.updatedCount}</strong>
                </span>
                {affected.missingCount > 0 && (
                  <span className="text-gray-400">
                    削除済み <strong>{affected.missingCount}</strong>
                  </span>
                )}
              </div>
            )}
          </div>

          {!affected.applicable ? (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              このジョブ種別 ({getImportTypeLabel(affected.jobType)}) は物件の作成・更新一覧表示に対応していません。受付帳CSV取込ジョブで確認できます。
            </p>
          ) : affected.affected.length === 0 ? (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              この取込で作成・更新された物件はありません（成功行に createdId が無いか、対象が見つかりません）。
            </p>
          ) : (
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-12">行</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-16">区分</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">住所</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">識別</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">管理ID</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">棟</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-20">詳細</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {affected.affected.map((p) => (
                    <tr
                      key={`${p.rowNumber}-${p.propertyId}`}
                      className="hover:bg-gray-50"
                    >
                      <td className="px-2 py-1.5 font-mono text-gray-500">
                        #{p.rowNumber}
                      </td>
                      <td className="px-2 py-1.5">
                        {!p.found ? (
                          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">
                            削除済み
                          </span>
                        ) : p.isUpdate ? (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800">
                            更新
                          </span>
                        ) : (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800">
                            新規
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-700">
                        {p.address ?? (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">
                        {[
                          p.lotNumber && `地番 ${p.lotNumber}`,
                          p.buildingNumber && `家屋 ${p.buildingNumber}`,
                          p.roomNo && `${p.roomNo}号`,
                        ]
                          .filter(Boolean)
                          .join(" / ") || (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">
                        {p.importSource ?? "—"}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">
                        {p.buildingName ? (
                          <Link
                            href={`/buildings/${p.buildingId}`}
                            className="text-indigo-600 hover:underline"
                          >
                            {p.buildingName}
                          </Link>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {p.found ? (
                          <Link
                            href={`/properties/${p.propertyId}`}
                            className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline"
                          >
                            開く
                            <ChevronRight className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Completion guidance */}
      {job.status === "completed" && counts.needs_review === 0 && counts.error === 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 className="mr-1.5 inline h-4 w-4" />
          すべての行が処理済みです。
          <Link href="/properties" className="ml-2 font-medium text-green-700 underline hover:text-green-900">
            物件一覧へ
          </Link>
        </div>
      )}
      {counts.needs_review > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mr-1.5 inline h-4 w-4" />
          <strong>{counts.needs_review} 件</strong>の行がレビュー待ちです
          {counts.duplicate > 0 && (
            <>（うち <strong>{counts.duplicate} 件</strong>は重複検知によるスキップ候補）</>
          )}
          。 各行を展開して「新規作成」「既存に紐付け」「スキップ」のいずれかを選択してください。
        </div>
      )}
      {counts.updated > 0 && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <RefreshCw className="mr-1.5 inline h-4 w-4" />
          <strong>{counts.updated} 件</strong>の行が既存レコードを更新しました（識別子/棟内部屋番号の強い一致のみ）。空欄の値は上書きしていません。
        </div>
      )}

      {/* Filter tabs + batch actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            { key: "all", label: "すべて" },
            { key: "needs_review", label: "要レビュー" },
            { key: "error", label: "エラー" },
            { key: "success", label: "成功" },
            { key: "skipped", label: "スキップ" },
          ] as { key: FilterStatus; label: string }[]
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => changeFilter(tab.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              filter === tab.key
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 opacity-70">({counts[tab.key]})</span>
          </button>
        ))}

        {/* 理由別 filter（Phase 2）: 閲覧用・全タブで表示。変更時は changeReason で page=1。
            token は server VALID_ROW_REASONS と一致（B4 scope="duplicate" と衝突しない命名）。 */}
        <label className="flex items-center gap-1">
          <span className="text-xs text-gray-500">理由</span>
          <select
            value={reason}
            onChange={(e) => changeReason(e.target.value as ReasonFilter)}
            disabled={loading}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
            aria-label="理由で絞り込み"
          >
            <option value="all">すべての理由</option>
            {ROW_REASON_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* 右側: 一括操作 + CSVエクスポート */}
        {((filter === "needs_review" || filter === "error") &&
          counts[filter] > 0) ||
        counts.error > 0 ||
        counts.needs_review > 0 ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Batch actions: 現在のフィルタが needs_review / error のときのみ。
                理由別 filter（Phase 2）適用中は **非表示** にする＝一括操作の対象は
                常にジョブ全体の status/scope 集合（理由で絞らない）であり、絞った
                表示と一括件数が食い違う誤操作を防ぐ（disabled ではなく非表示を採用）。 */}
            {reason === "all" &&
              (filter === "needs_review" || filter === "error") &&
              counts[filter] > 0 && (
                <>
                  <button
                    onClick={() => handleBatchResolve("skip")}
                    disabled={actionLoading === "batch"}
                    className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <SkipForward className="h-3 w-3" />
                    全件スキップ
                  </button>
                  <button
                    onClick={() => handleBatchResolve("mark_error")}
                    disabled={actionLoading === "batch"}
                    className="flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Ban className="h-3 w-3" />
                    全件エラー確定
                  </button>
                  {/* B4: 重複候補のみスキップ（needs_review の重複サブセット限定）。
                      「全件スキップ」と取り違えないよう amber 色＋件数を明示。 */}
                  {filter === "needs_review" &&
                    counts.duplicateActionable > 0 && (
                      <button
                        onClick={handleBulkResolveDuplicates}
                        disabled={actionLoading === "batch"}
                        title="取込時に検出された重複候補（要レビューの内数）だけをスキップします。非重複の要レビュー行は残ります。"
                        className="flex items-center gap-1 rounded-md border border-amber-300 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        重複候補のみスキップ（{counts.duplicateActionable}件）
                      </button>
                    )}
                </>
              )}

            {/* 理由別 filter 適用中の一括操作ヒント（非表示の理由をユーザーに明示） */}
            {reason !== "all" &&
              (filter === "needs_review" || filter === "error") &&
              counts[filter] > 0 && (
                <span className="text-xs text-gray-500">
                  理由フィルタ解除後に一括操作できます
                </span>
              )}

            {/* CSV エクスポート: error / needs_review が1件以上あるときに表示
                サーバ側 Content-Disposition で attachment 指定済み。
                download 属性はファイル名のクライアント側ヒント。 */}
            {(counts.error > 0 || counts.needs_review > 0) && (
              <a
                href={`/api/import/jobs/${jobId}/export-errors`}
                download={`import-errors-${jobId}.csv`}
                className="flex items-center gap-1 rounded-md border border-indigo-300 bg-white px-3 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                title="error / needs_review 行を CSV でダウンロード（Excel 互換 / UTF-8 BOM 付き）"
              >
                <Download className="h-3 w-3" />
                エラー行をCSVダウンロード
              </a>
            )}
          </div>
        ) : null}
      </div>

      {/* B2 + 候補5: ページネーション（server pagination メタ）＋ 表示件数切替 / ページジャンプ */}
      {job?.pagination && job.pagination.totalRows > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
          <span>
            {job.pagination.totalRows} 件中{" "}
            {(page - 1) * job.pagination.limit + 1}–
            {Math.min(page * job.pagination.limit, job.pagination.totalRows)} 件
            （{page} / {job.pagination.totalPages} ページ）
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {/* 候補5: 表示件数（limit）切替。変更時は changeLimit で page=1 に戻る。 */}
            <label className="flex items-center gap-1">
              <span className="text-xs text-gray-500">表示件数</span>
              <select
                value={limit}
                onChange={(e) => changeLimit(Number(e.target.value))}
                disabled={loading}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
                aria-label="1ページあたりの表示件数"
              >
                {ROW_LIMIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt} 件
                  </option>
                ))}
              </select>
            </label>
            {/* 候補5: ページジャンプ（1〜totalPages の範囲に制御。複数ページのときのみ表示）。 */}
            {job.pagination.totalPages > 1 && (
              <form onSubmit={handleGoto} className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  max={job.pagination.totalPages}
                  value={gotoPage}
                  onChange={(e) => setGotoPage(e.target.value)}
                  placeholder={String(page)}
                  aria-label="移動先ページ番号"
                  className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                />
                <span className="text-xs text-gray-400">
                  / {job.pagination.totalPages}
                </span>
                <button
                  type="submit"
                  disabled={loading || gotoPage === ""}
                  className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-50"
                >
                  移動
                </button>
              </form>
            )}
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!job.pagination.hasPrevPage || loading}
              className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-50"
            >
              前へ
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!job.pagination.hasNextPage || loading}
              className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-50"
            >
              次へ
            </button>
          </div>
        </div>
      )}

      {/* Rows list */}
      <div className="space-y-2">
        {filteredRows.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white py-10 text-center text-sm text-gray-400">
            該当する行はありません
          </div>
        ) : (
          filteredRows.map((row) => {
            const config =
              ROW_STATUS_CONFIG[row.status] ?? ROW_STATUS_CONFIG.error;
            const Icon = config.icon;
            const isExpanded = expandedRow === row.id;
            const isEditing = editingRow === row.id;
            const isLoading = actionLoading === row.id;
            const rawData = row.rawData ?? {};
            // 段階A: error / needs_review 行のみ分類器を通す。
            // success 行は従来の「Update summary」表示を残すため null。
            const classified =
              row.status === "error" || row.status === "needs_review"
                ? classifyImportError(row.errorMessage, rawData)
                : null;

            return (
              <div
                key={row.id}
                className={`rounded-lg border ${config.bg} overflow-hidden`}
              >
                {/* Row header */}
                <button
                  onClick={() =>
                    setExpandedRow(isExpanded ? null : row.id)
                  }
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="w-8 text-xs font-mono text-gray-400">
                    #{row.rowNumber}
                  </span>
                  <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
                  <span className={`text-sm font-medium ${config.color}`}>
                    {config.label}
                  </span>
                  {isDuplicateMessage(row.errorMessage) && (
                    <span
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                      title={row.errorMessage ?? ""}
                    >
                      重複{extractDuplicateReason(row.errorMessage) ? `・${extractDuplicateReason(row.errorMessage)}` : ""}
                    </span>
                  )}
                  {isUpdateMessage(row.errorMessage) && (
                    <span
                      className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800"
                      title={row.errorMessage ?? ""}
                    >
                      更新{extractUpdateReason(row.errorMessage) ? `・${extractUpdateReason(row.errorMessage)}` : ""}
                      {(() => {
                        const fields = extractUpdatedFields(row.errorMessage);
                        return fields.length > 0 ? `（${fields.length}項目）` : "";
                      })()}
                    </span>
                  )}
                  <span className="flex-1 truncate text-sm text-gray-600">
                    {rawData["住所"] ||
                      rawData["address"] ||
                      rawData["氏名"] ||
                      rawData["name"] ||
                      ""}
                  </span>
                  {row.errorMessage &&
                    !isDuplicateMessage(row.errorMessage) &&
                    !isUpdateMessage(row.errorMessage) && (
                      <span className="hidden max-w-[200px] truncate text-xs text-red-500 sm:inline">
                        {row.errorMessage}
                      </span>
                    )}
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
                  )}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gray-200 bg-white px-4 py-4">
                    {/* Update summary (success + update) */}
                    {row.status === "success" && isUpdateMessage(row.errorMessage) && (
                      <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                        <strong>更新:</strong>{" "}
                        {extractUpdateReason(row.errorMessage) ?? "既存レコード更新"}
                        {(() => {
                          const fields = extractUpdatedFields(row.errorMessage);
                          if (fields.length === 0) {
                            return <span className="ml-2 text-blue-600">（差分なし）</span>;
                          }
                          return (
                            <span className="ml-2 text-blue-700">
                              更新項目: {fields.join(", ")}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    {/* 段階A: エラー / 要レビュー 行の 3ブロック表示
                        ① 大きいラベル ② 対象列ヒント ③ 修正方法
                        対象列ハイライトは下の rawData テーブル側で行う。 */}
                    {classified && (
                      <div
                        className={`mb-4 overflow-hidden rounded-md border ${
                          row.status === "needs_review"
                            ? "border-amber-300 bg-amber-50"
                            : "border-red-300 bg-red-50"
                        }`}
                      >
                        {/* ① エラー内容（大きく） */}
                        <div
                          className={`flex items-center gap-2 px-4 py-2.5 text-base font-semibold ${
                            row.status === "needs_review"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-red-100 text-red-900"
                          }`}
                        >
                          {row.status === "needs_review" ? (
                            <AlertTriangle className="h-5 w-5 shrink-0" />
                          ) : (
                            <XCircle className="h-5 w-5 shrink-0" />
                          )}
                          <span>
                            [{row.status === "needs_review" ? "要レビュー" : "エラー"}]{" "}
                            {classified.label}
                          </span>
                        </div>

                        {/* ② 対象列（ある場合のみ。テーブル側で赤背景になる） */}
                        {classified.field && (
                          <div
                            className={`px-4 py-1.5 text-xs ${
                              row.status === "needs_review"
                                ? "text-amber-800"
                                : "text-red-800"
                            }`}
                          >
                            <span className="font-medium">対象列:</span>{" "}
                            <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px]">
                              {classified.field}
                            </code>
                            <span className="ml-1 text-[11px] opacity-75">
                              （下の元データテーブルで赤くハイライト）
                            </span>
                          </div>
                        )}

                        {/* ③ 修正方法 */}
                        <div
                          className={`flex items-start gap-2 px-4 py-2 text-sm ${
                            row.status === "needs_review"
                              ? "border-t border-amber-200 text-amber-900"
                              : "border-t border-red-200 text-red-900"
                          }`}
                        >
                          <span className="mt-0.5 shrink-0 font-semibold">
                            修正:
                          </span>
                          <span>{classified.hint}</span>
                        </div>

                        {/* 元のメッセージは折りたたみで残す（管理者・調査用） */}
                        {row.errorMessage && (
                          <details
                            className={`border-t px-4 py-1.5 text-[11px] ${
                              row.status === "needs_review"
                                ? "border-amber-200 text-amber-700"
                                : "border-red-200 text-red-700"
                            }`}
                          >
                            <summary className="cursor-pointer select-none">
                              元のメッセージを表示
                            </summary>
                            <code className="mt-1 block break-all font-mono text-[11px] opacity-80">
                              {row.errorMessage}
                            </code>
                          </details>
                        )}
                      </div>
                    )}

                    {/* Created ID */}
                    {row.createdId && (
                      <div className="mb-4 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>
                          作成済ID:{" "}
                          <Link
                            href={
                              isOwnerJob
                                ? "#"
                                : `/properties/${row.createdId}`
                            }
                            className="font-mono underline"
                          >
                            {row.createdId.slice(0, 8)}...
                          </Link>
                        </span>
                      </div>
                    )}

                    {/* Building candidates (for unit import needs_review) */}
                    {row.status === "needs_review" &&
                      rawData["__building_candidates"] && (
                        <BuildingCandidates
                          candidatesJson={rawData["__building_candidates"]}
                          onSelect={(buildingId) => {
                            // Set buildingId in editedData for create_new
                            startEdit(row);
                            setEditedData((prev) => ({
                              ...prev,
                              __resolved_building_id: buildingId,
                            }));
                          }}
                        />
                      )}

                    {/* Raw data display / edit */}
                    <div className="mb-4">
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-sm font-medium text-gray-700">
                          元データ
                        </h4>
                        {(row.status === "error" ||
                          row.status === "needs_review") &&
                          !isEditing && (
                            <button
                              onClick={() => startEdit(row)}
                              className="flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                            >
                              編集
                            </button>
                          )}
                        {isEditing && (
                          <button
                            onClick={cancelEdit}
                            className="text-xs text-gray-500 hover:underline"
                          >
                            キャンセル
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto rounded border border-gray-200">
                        <table className="w-full text-xs">
                          <tbody className="divide-y divide-gray-100">
                            {Object.entries(
                              isEditing ? editedData : rawData,
                            ).filter(([key]) => !key.startsWith("__")).map(([key, value]) => {
                              // 段階A: 分類器が特定した「対象列」と一致するキーは
                                // 赤背景で強調。tooltip で「この列でエラー」も表示。
                              const isErrorField =
                                !!classified && classified.field === key;
                              return (
                              <tr
                                key={key}
                                className={
                                  isErrorField
                                    ? "bg-red-50/70 hover:bg-red-100"
                                    : "hover:bg-gray-50"
                                }
                                title={isErrorField ? "この列でエラー" : undefined}
                              >
                                <td
                                  className={`w-[120px] whitespace-nowrap px-3 py-1.5 font-medium ${
                                    isErrorField
                                      ? "text-red-800"
                                      : "text-gray-600"
                                  }`}
                                >
                                  {isErrorField && (
                                    <XCircle className="mr-1 inline h-3.5 w-3.5 -translate-y-px text-red-500" />
                                  )}
                                  {key}
                                </td>
                                <td
                                  className={`px-3 py-1.5 ${
                                    isErrorField
                                      ? "bg-red-100 text-red-900 ring-1 ring-inset ring-red-300"
                                      : "text-gray-800"
                                  }`}
                                >
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={editedData[key] ?? ""}
                                      onChange={(e) =>
                                        setEditedData((prev) => ({
                                          ...prev,
                                          [key]: e.target.value,
                                        }))
                                      }
                                      className={`w-full rounded border px-2 py-0.5 text-xs focus:outline-none focus:ring-1 ${
                                        isErrorField
                                          ? "border-red-400 bg-white focus:border-red-500 focus:ring-red-500"
                                          : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500"
                                      }`}
                                      autoFocus={isErrorField}
                                    />
                                  ) : (
                                    <span>
                                      {value === "" || value == null ? (
                                        <span className="text-gray-400">
                                          (未入力)
                                        </span>
                                      ) : (
                                        String(value)
                                      )}
                                    </span>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Action buttons */}
                    {(row.status === "needs_review" ||
                      row.status === "error") && (
                      <div className="space-y-3">
                        {/* Search & link existing */}
                        {row.status === "needs_review" && (
                          <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                            <p className="mb-2 text-xs font-medium text-gray-600">
                              既存{isOwnerJob ? "所有者" : "物件"}を検索して紐付け
                            </p>
                            <div className="relative">
                              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                              <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) =>
                                  handleSearchInput(e.target.value)
                                }
                                placeholder={
                                  isOwnerJob
                                    ? "氏名・電話番号・住所で検索..."
                                    : "住所・地番・不動産番号で検索..."
                                }
                                className="w-full rounded border border-gray-300 py-1.5 pl-8 pr-2 text-xs focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                              />
                            </div>

                            {/* Search results */}
                            {searchLoading && (
                              <div className="mt-2 flex items-center gap-1 text-xs text-gray-400">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                検索中...
                              </div>
                            )}
                            {searchResults.length > 0 && (
                              <div className="mt-2 max-h-[200px] overflow-y-auto rounded border border-gray-200 bg-white">
                                {searchResults.map((result) => (
                                  <button
                                    key={result.id}
                                    onClick={() => {
                                      setSelectedTarget(result);
                                      setSearchResults([]);
                                      setSearchQuery(
                                        result.address ??
                                          result.name ??
                                          result.id,
                                      );
                                    }}
                                    className={`flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left text-xs hover:bg-indigo-50 last:border-b-0 ${
                                      selectedTarget?.id === result.id
                                        ? "bg-indigo-50"
                                        : ""
                                    }`}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <p className="font-medium text-gray-800 truncate">
                                        {isOwnerJob
                                          ? result.name
                                          : result.address}
                                      </p>
                                      <p className="text-gray-500 truncate">
                                        {isOwnerJob
                                          ? [
                                              result.nameKana,
                                              result.phone,
                                              result.address,
                                            ]
                                              .filter(Boolean)
                                              .join(" / ")
                                          : [
                                              result.lotNumber &&
                                                `地番: ${result.lotNumber}`,
                                              result.realEstateNumber &&
                                                `不動産番号: ${result.realEstateNumber}`,
                                            ]
                                              .filter(Boolean)
                                              .join(" / ")}
                                      </p>
                                    </div>
                                    <span className="shrink-0 font-mono text-[10px] text-gray-400">
                                      {result.id.slice(0, 8)}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Selected target */}
                            {selectedTarget && (
                              <div className="mt-2 flex items-center gap-2">
                                <div className="flex-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700">
                                  <Link2 className="mr-1 inline h-3 w-3" />
                                  紐付け先:{" "}
                                  {isOwnerJob
                                    ? selectedTarget.name
                                    : selectedTarget.address}{" "}
                                  ({selectedTarget.id.slice(0, 8)}...)
                                </div>
                                <button
                                  onClick={() =>
                                    handleResolve(row.id, "link_existing")
                                  }
                                  disabled={isLoading}
                                  className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {isLoading ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Link2 className="h-3 w-3" />
                                  )}
                                  紐付け確定
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Action buttons row */}
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              handleResolve(row.id, "create_new")
                            }
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {isLoading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            {isEditing ? "修正して新規作成" : "新規作成"}
                          </button>

                          {row.status === "error" && (
                            <button
                              onClick={() => handleRetry(row.id)}
                              disabled={isLoading}
                              className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                              {isLoading ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              {isEditing ? "修正してリトライ" : "リトライ"}
                            </button>
                          )}

                          <button
                            onClick={() => handleResolve(row.id, "skip")}
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          >
                            <SkipForward className="h-3 w-3" />
                            スキップ
                          </button>

                          <button
                            onClick={() =>
                              handleResolve(row.id, "mark_error")
                            }
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Ban className="h-3 w-3" />
                            エラー確定
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Rollback dialog */}
      {rollbackOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
            <div className="border-b border-gray-200 px-5 py-3">
              <h3 className="flex items-center gap-2 text-base font-semibold text-gray-800">
                <RotateCcw className="h-4 w-4 text-red-600" />
                取込ロールバック
              </h3>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm">
              {rollbackLoading && !rollbackPreview && !rollbackResult && (
                <div className="flex items-center gap-2 text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  対象を確認中...
                </div>
              )}
              {rollbackError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-700">
                  {rollbackError}
                </div>
              )}
              {rollbackResult ? (
                <div className="space-y-2">
                  <div className="rounded-md border border-green-200 bg-green-50 p-3 text-green-800">
                    ロールバック完了: {rollbackResult.deletedCount ?? 0} 件削除 /
                    {" "}
                    {rollbackResult.restoredPropertyCount ?? 0} 件復元
                    {(rollbackResult.restoredFieldCount ?? 0) > 0 && (
                      <span className="ml-1 text-xs text-green-700">
                        （{rollbackResult.restoredFieldCount} 項目）
                      </span>
                    )}
                  </div>
                  {rollbackResult.restoreDetails &&
                    rollbackResult.restoreDetails.length > 0 && (
                      <details className="text-xs text-gray-600">
                        <summary className="cursor-pointer text-gray-700">
                          復元したフィールドの内訳を表示
                        </summary>
                        <ul
                          data-testid="rollback-restore-result-list"
                          className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2"
                        >
                          {rollbackResult.restoreDetails.map((r) => (
                            <li key={`${r.rowNumber}-${r.propertyId}`}>
                              行 {r.rowNumber} (物件 {r.propertyId.slice(0, 8)}…):
                              {" "}
                              {r.fieldNames.join(", ")}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  {rollbackResult.blockedDetails.length > 0 && (
                    <div>
                      <p className="font-medium text-gray-700">対応できなかった行 ({rollbackResult.blockedDetails.length}):</p>
                      <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
                        {rollbackResult.blockedDetails.map((b) => (
                          <li key={`${b.rowNumber}-${b.action}`}>
                            行 {b.rowNumber} ({b.action === "delete" ? "削除" : "復元"}): {b.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : rollbackPreview && rollbackPreview.eligible ? (
                <>
                  <p className="text-gray-700">
                    この取込で作成された物件を削除し、更新された物件は変更ログに基づいて復元します。
                    この操作は取り消せません。
                  </p>
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                    <div className="grid grid-cols-4 gap-2 text-xs">
                      <div>
                        <div className="text-gray-500">削除対象 (新規)</div>
                        <div className="text-base font-semibold text-red-600">
                          {rollbackPreview.summary.deletable}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">復元対象 (更新)</div>
                        <div className="text-base font-semibold text-blue-600">
                          {rollbackPreview.summary.restorable}
                          {(rollbackPreview.summary.restorableFieldCount ?? 0) > 0 && (
                            <span className="ml-1 text-xs text-blue-500">
                              ({rollbackPreview.summary.restorableFieldCount}項目)
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">ロールバック不可</div>
                        <div className="text-base font-semibold text-amber-600">
                          {rollbackPreview.summary.blocked}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">対象外 (skip/error 等)</div>
                        <div className="text-base font-semibold text-gray-700">
                          {rollbackPreview.summary.skipped}
                        </div>
                      </div>
                    </div>
                  </div>
                  {rollbackPreview.restoreDetails &&
                    rollbackPreview.restoreDetails.length > 0 && (
                      <details className="text-xs text-gray-600">
                        <summary className="cursor-pointer text-gray-700">
                          復元するフィールドの内訳を表示
                        </summary>
                        <ul
                          data-testid="rollback-restore-preview-list"
                          className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2"
                        >
                          {rollbackPreview.restoreDetails.map((r) => (
                            <li key={`${r.rowNumber}-${r.propertyId}`}>
                              行 {r.rowNumber} (物件 {r.propertyId.slice(0, 8)}…):
                              {" "}
                              {r.fieldNames.join(", ")}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  {rollbackPreview.blockedDetails.length > 0 && (
                    <details className="text-xs text-gray-600">
                      <summary className="cursor-pointer text-gray-700">
                        ロールバック不可の内訳を表示
                      </summary>
                      <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2">
                        {rollbackPreview.blockedDetails.map((b) => (
                          <li key={`${b.rowNumber}-${b.action}`}>
                            行 {b.rowNumber} ({b.action === "delete" ? "削除" : "復元"}): {b.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              ) : rollbackPreview && !rollbackPreview.eligible ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
                  {rollbackPreview.ineligibleReason ?? "ロールバックできません"}
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
              <button
                onClick={closeRollbackDialog}
                disabled={rollbackLoading}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {rollbackResult ? "閉じる" : "キャンセル"}
              </button>
              {!rollbackResult &&
                rollbackPreview &&
                rollbackPreview.eligible &&
                (rollbackPreview.summary.deletable > 0 ||
                  rollbackPreview.summary.restorable > 0) && (
                  <button
                    onClick={executeRollback}
                    disabled={rollbackLoading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {rollbackLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    実行する
                  </button>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building candidates component (for unit import needs_review)
// ---------------------------------------------------------------------------

function BuildingCandidates({
  candidatesJson,
  onSelect,
}: {
  candidatesJson: string;
  onSelect: (buildingId: string) => void;
}) {
  let candidates: Array<{ id: string; name: string; address: string }> = [];
  try {
    candidates = JSON.parse(candidatesJson);
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  return (
    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
      <p className="mb-2 text-xs font-medium text-blue-800">
        棟候補が見つかりました。正しい棟を選択してください:
      </p>
      <div className="space-y-1">
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className="flex w-full items-center gap-2 rounded border border-blue-200 bg-white px-3 py-2 text-left text-xs hover:bg-blue-100 transition-colors"
          >
            <span className="font-medium text-gray-800">{c.name}</span>
            <span className="text-gray-500">{c.address}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-400">
              {c.id.slice(0, 8)}...
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
