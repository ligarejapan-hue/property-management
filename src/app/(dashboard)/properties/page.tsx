"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight, Loader2, Plus, Trash2, AlertTriangle, RotateCcw } from "lucide-react";
import { fetchProperties as apiFetchProperties, bulkUpdateProperties, deleteProperty, fetchQualityCheck, fetchUsers, fetchPropertySuggestions } from "@/lib/api-client";
import NewPropertyModal from "@/components/properties/new-property-modal";

// ---------- Label maps ----------

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";

const REGISTRY_STATUS_LABELS: Record<string, string> = {
  unconfirmed: "未取得",
  scheduled: "取得中",
  obtained: "取得済",
};

const DM_STATUS_LABELS: Record<string, string> = {
  send: "送付可",
  hold: "未判断",
  no_send: "送付不可",
};

const CASE_STATUS_LABELS: Record<string, string> = {
  new_case: "新規",
  site_checked: "現地確認済",
  waiting_registry: "登記待ち",
  dm_target: "DM対象",
  dm_sent: "DM送付済",
  hold: "保留",
  done: "完了",
};

const registryStatusStyles: Record<string, string> = {
  obtained: "bg-green-100 text-green-800",
  unconfirmed: "bg-red-100 text-red-800",
  scheduled: "bg-yellow-100 text-yellow-800",
};

const dmStatusStyles: Record<string, string> = {
  send: "bg-green-100 text-green-800",
  no_send: "bg-red-100 text-red-800",
  hold: "bg-gray-100 text-gray-600",
};

// ---------- Types ----------

interface ApiProperty {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
  registryStatus: string;
  dmStatus: string;
  caseStatus: string;
  isArchived: boolean;
  updatedAt: string;
  assignedTo: string | null;
  assignee: { id: string; name: string } | null;
  importSource?: string | null;
}

interface SuggestResult {
  id: string;
  address: string;
  dmStatus: string;
  importSource: string | null;
  owners: Array<{
    name: string | null;
    address: string | null;
    phone: string | null;
    zip: string | null;
  }>;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------- Component ----------

// Next.js 16 では useSearchParams を使うクライアントコンポーネントを Suspense で
// 包む必要がある。インナーに本体を置き、default export 側で Suspense ラップする。
export default function PropertiesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">読み込み中...</div>}>
      <PropertiesPageInner />
    </Suspense>
  );
}

function PropertiesPageInner() {
  const [properties, setProperties] = useState<ApiProperty[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // URL query params (state の初期値とブラウザ更新後の復元に使う)
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Filters — URL から初期化することでブックマーク・更新・共有が可能
  const [searchText, setSearchText] = useState(() => sp.get("keyword") ?? "");
  const [typeFilter, setTypeFilter] = useState(() => sp.get("propertyType") ?? "");
  const [registryFilter, setRegistryFilter] = useState(() => sp.get("registryStatus") ?? "");
  const [dmFilter, setDmFilter] = useState(() => sp.get("dmStatus") ?? "");
  const [caseFilter, setCaseFilter] = useState(() => sp.get("caseStatus") ?? "");
  const [assigneeFilter, setAssigneeFilter] = useState(() => sp.get("assignedTo") ?? "");
  const [updatedFromFilter, setUpdatedFromFilter] = useState(() => sp.get("updatedFrom") ?? "");
  const [updatedToFilter, setUpdatedToFilter] = useState(() => sp.get("updatedTo") ?? "");
  const [warningOnly, setWarningOnly] = useState(() => sp.get("hasWarning") === "true");
  // 並び替え。 "<sortBy>:<sortOrder>" を1つの値として保持する。
  const [sort, setSort] = useState<string>(() => sp.get("sort") ?? "updatedAt:desc");
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get("page") ?? "1") || 1));

  // 担当者プルダウン用ユーザー一覧
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

  // 入力中候補表示
  const [suggestResults, setSuggestResults] = useState<SuggestResult[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 警告 (quality-check) を propertyId 単位で集計。
  // 既存の /api/properties/quality-check を流用するので新 API は追加しない。
  // severity = "info" は粒度が細かいため一覧ではバッジ対象外 (error / warning のみ)。
  const [warningsByProperty, setWarningsByProperty] = useState<
    Map<string, { severity: "error" | "warning"; messages: string[] }>
  >(new Map());

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // 一括削除の結果サマリ。null のときは表示しない。
  const [bulkDeleteResult, setBulkDeleteResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; address: string; reason: string }>;
  } | null>(null);

  const fetchProperties = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params: Record<string, string> = { page: String(page), limit: "50" };
    if (searchText) params.keyword = searchText;
    if (typeFilter) params.propertyType = typeFilter;
    if (registryFilter) params.registryStatus = registryFilter;
    if (dmFilter) params.dmStatus = dmFilter;
    if (caseFilter) params.caseStatus = caseFilter;
    if (assigneeFilter) params.assignedTo = assigneeFilter;
    if (updatedFromFilter) params.updatedFrom = updatedFromFilter;
    if (updatedToFilter) params.updatedTo = updatedToFilter;
    if (warningOnly) params.hasWarning = "true";
    const [sortBy, sortOrder] = sort.split(":");
    if (sortBy) params.sortBy = sortBy;
    if (sortOrder) params.sortOrder = sortOrder;

    try {
      const json = await apiFetchProperties(params);
      setProperties(json.data);
      setPagination(json.pagination as Pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "データ取得に失敗しました");
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }, [page, searchText, typeFilter, registryFilter, dmFilter, caseFilter, assigneeFilter, updatedFromFilter, updatedToFilter, warningOnly, sort]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  // 担当者プルダウン用にユーザー一覧を初回のみ取得（失敗時はサイレントに無視）
  useEffect(() => {
    fetchUsers()
      .then((res) => {
        const data = (res as { data?: { id: string; name: string }[] }).data ?? [];
        setUsers(data);
      })
      .catch(() => {});
  }, []);

  // state を URL query params に同期（router.replace なのでページ遷移なし）
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchText) params.set("keyword", searchText);
    if (typeFilter) params.set("propertyType", typeFilter);
    if (registryFilter) params.set("registryStatus", registryFilter);
    if (dmFilter) params.set("dmStatus", dmFilter);
    if (caseFilter) params.set("caseStatus", caseFilter);
    if (assigneeFilter) params.set("assignedTo", assigneeFilter);
    if (updatedFromFilter) params.set("updatedFrom", updatedFromFilter);
    if (updatedToFilter) params.set("updatedTo", updatedToFilter);
    if (warningOnly) params.set("hasWarning", "true");
    if (sort !== "updatedAt:desc") params.set("sort", sort);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchText, typeFilter, registryFilter, dmFilter, caseFilter, assigneeFilter, updatedFromFilter, updatedToFilter, warningOnly, sort, page, pathname, router]);

  // 警告サマリは初回 / 一覧再取得時に best-effort で更新する。
  // 失敗してもバッジが出ないだけで一覧本体は表示できる設計。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchQualityCheck();
        if (cancelled) return;
        const data = (json as {
          data?: Array<{
            propertyId: string;
            severity: "error" | "warning" | "info";
            message: string;
          }>;
        }).data ?? [];
        const next = new Map<
          string,
          { severity: "error" | "warning"; messages: string[] }
        >();
        for (const issue of data) {
          if (issue.severity === "info") continue;
          const cur = next.get(issue.propertyId);
          if (cur) {
            cur.messages.push(issue.message);
            // error が混ざれば error に昇格
            if (issue.severity === "error") cur.severity = "error";
          } else {
            next.set(issue.propertyId, {
              severity: issue.severity,
              messages: [issue.message],
            });
          }
        }
        setWarningsByProperty(next);
      } catch {
        // best-effort: 失敗しても無視
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 入力中候補: searchText に 300ms debounce をかけて suggest API を呼ぶ
  useEffect(() => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (searchText.length < 2) {
      setSuggestResults([]);
      setSuggestOpen(false);
      return;
    }
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetchPropertySuggestions(searchText);
        setSuggestResults(res.data);
        setSuggestOpen(res.data.length > 0);
      } catch {
        setSuggestResults([]);
        setSuggestOpen(false);
      }
    }, 300);
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, [searchText]);

  // Debounce search: reset page on filter change
  const handleFilterChange = (setter: (v: string) => void) => (
    e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>,
  ) => {
    setter(e.target.value);
    setPage(1);
  };

  // 全フィルタを一括リセット（並び順は既定に戻し、page=1）
  const handleResetFilters = () => {
    setSuggestOpen(false);
    setSuggestResults([]);
    setSearchText("");
    setTypeFilter("");
    setRegistryFilter("");
    setDmFilter("");
    setCaseFilter("");
    setAssigneeFilter("");
    setUpdatedFromFilter("");
    setUpdatedToFilter("");
    setWarningOnly(false);
    setSort("updatedAt:desc");
    setPage(1);
  };

  // 何らかのフィルタが効いているか（リセットボタン活性化用）
  const hasActiveFilter =
    !!searchText || !!typeFilter || !!registryFilter || !!dmFilter ||
    !!caseFilter || !!assigneeFilter || !!updatedFromFilter || !!updatedToFilter ||
    warningOnly || sort !== "updatedAt:desc";

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 警告フィルタはサーバ側 (hasWarning=true) で適用する。
  // ここではバッジ表示用に warningsByProperty を併用するだけで、行は filter しない。
  const visibleProperties = properties;

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleProperties.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleProperties.map((p) => p.id)));
    }
  };

  // 物件を一覧から削除する。誤操作防止のため confirm を必須にし、
  // サーバ側の権限制御 + Cascade を踏襲（詳細ページの削除と同じ deleteProperty を再利用）。
  const handleDelete = async (id: string, address: string) => {
    if (deletingId) return;
    if (
      !window.confirm(
        `物件「${address}」を削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      await deleteProperty(id);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await fetchProperties();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeletingId(null);
    }
  };

  // 選択中の物件を一括削除する。既存の単体 deleteProperty を直列ループで再利用し、
  // サーバ側の権限制御 / Cascade をそのまま踏襲する。
  // - 0件選択時はボタン無効
  // - confirm 必須（誤操作防止）
  // - 失敗は ID と住所と日本語メッセージで集計表示
  // - 成功・失敗どちらでも最後に一覧再取得
  const handleBulkDelete = async () => {
    if (bulkDeleting || selectedIds.size === 0) return;
    const targets = properties.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `選択した ${targets.length} 件の物件を削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setError(null);
    setBulkDeleteResult(null);

    let successCount = 0;
    const failures: Array<{ id: string; address: string; reason: string }> = [];

    // 1件ずつ直列で実行（権限・Cascade を個別に評価し、片方の失敗で残りを止めない）
    for (const p of targets) {
      try {
        await deleteProperty(p.id);
        successCount++;
      } catch (err) {
        failures.push({
          id: p.id,
          address: p.address,
          reason: err instanceof Error ? err.message : "削除に失敗しました",
        });
      }
    }

    // 成功した分は選択から外す（失敗したIDだけ残す）
    setSelectedIds(new Set(failures.map((f) => f.id)));
    setBulkDeleteResult({
      successCount,
      failureCount: failures.length,
      failures,
    });

    await fetchProperties();
    setBulkDeleting(false);
  };

  const handleBulkUpdate = async (updates: Record<string, unknown>) => {
    if (selectedIds.size === 0) return;
    setBulkUpdating(true);
    try {
      await bulkUpdateProperties(Array.from(selectedIds), updates);
      setSelectedIds(new Set());
      fetchProperties();
    } catch (err) {
      setError(err instanceof Error ? err.message : "一括更新に失敗しました");
    } finally {
      setBulkUpdating(false);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-800">物件一覧</h2>
      </div>

      {/* Action row */}
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setShowNewModal(true)}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          新規物件登録
        </button>
      </div>

      {showNewModal && (
        <NewPropertyModal onClose={() => setShowNewModal(false)} />
      )}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <select
          value={typeFilter}
          onChange={handleFilterChange(setTypeFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">種別: すべて</option>
          {PROPERTY_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={registryFilter}
          onChange={handleFilterChange(setRegistryFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">登記状況: すべて</option>
          <option value="obtained">取得済</option>
          <option value="unconfirmed">未取得</option>
          <option value="scheduled">取得中</option>
        </select>

        <select
          value={dmFilter}
          onChange={handleFilterChange(setDmFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">DM判断: すべて</option>
          <option value="send">送付可</option>
          <option value="no_send">送付不可</option>
          <option value="hold">未判断</option>
        </select>

        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="住所・地番・所有者名・電話番号で検索"
            value={searchText}
            onChange={handleFilterChange(setSearchText)}
            onBlur={() => setSuggestOpen(false)}
            onFocus={() => { if (suggestResults.length > 0) setSuggestOpen(true); }}
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
          {suggestOpen && suggestResults.length > 0 && (
            <ul className="absolute left-0 top-full z-50 mt-1 w-full min-w-[320px] rounded-md border border-gray-200 bg-white shadow-lg">
              {suggestResults.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSuggestOpen(false);
                      router.push(`/properties/${item.id}`);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-blue-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-medium text-gray-800 truncate">{item.address}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${dmStatusStyles[item.dmStatus] ?? "bg-gray-100 text-gray-600"}`}>
                        {DM_STATUS_LABELS[item.dmStatus] ?? item.dmStatus}
                      </span>
                    </div>
                    {item.importSource && (
                      <span className="font-mono text-[11px] text-gray-400">{item.importSource}</span>
                    )}
                    {item.owners.filter((o) => o.name || o.phone || o.address).map((o, i) => (
                      <div key={i} className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                        {o.name && <span>{o.name}</span>}
                        {o.phone && <span>{o.phone}</span>}
                        {o.address && <span className="truncate">{o.address}</span>}
                      </div>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <input
            type="checkbox"
            checked={warningOnly}
            onChange={(e) => {
              setWarningOnly(e.target.checked);
              setPage(1);
            }}
            className="rounded border-amber-300"
          />
          <AlertTriangle className="h-3.5 w-3.5" />
          警告ありのみ
          {warningsByProperty.size > 0 && (
            <span className="rounded-full bg-amber-200 px-1.5 text-xs font-semibold">
              {warningsByProperty.size}
            </span>
          )}
        </label>

        <select
          value={caseFilter}
          onChange={handleFilterChange(setCaseFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">案件ステータス: すべて</option>
          {Object.entries(CASE_STATUS_LABELS).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          title="並び替え"
        >
          <option value="updatedAt:desc">更新日 新しい順</option>
          <option value="updatedAt:asc">更新日 古い順</option>
          <option value="caseStatus:asc">案件ステータス順</option>
          <option value="address:asc">住所昇順</option>
        </select>

        <select
          value={assigneeFilter}
          onChange={handleFilterChange(setAssigneeFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          title="担当者"
        >
          <option value="">担当者: すべて</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-sm text-gray-600">
          更新日:
          <input
            type="date"
            value={updatedFromFilter}
            onChange={handleFilterChange(setUpdatedFromFilter)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            title="更新日（開始）"
          />
          <span className="text-gray-400">〜</span>
          <input
            type="date"
            value={updatedToFilter}
            onChange={handleFilterChange(setUpdatedToFilter)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            title="更新日（終了）"
          />
        </label>

        <button
          type="button"
          onClick={handleResetFilters}
          disabled={!hasActiveFilter}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="全フィルタをリセット"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          リセット
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button
            onClick={fetchProperties}
            className="ml-2 text-red-800 underline hover:no-underline"
          >
            再試行
          </button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <span className="text-sm font-medium text-blue-800">
            {selectedIds.size} 件選択中
          </span>
          <select
            disabled={bulkUpdating}
            onChange={(e) => {
              if (e.target.value) {
                handleBulkUpdate({ caseStatus: e.target.value });
                e.target.value = "";
              }
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="">案件ステータス変更...</option>
            <option value="new_case">新規</option>
            <option value="site_checked">現地確認済</option>
            <option value="waiting_registry">登記待ち</option>
            <option value="dm_target">DM対象</option>
            <option value="dm_sent">DM送付済</option>
            <option value="hold">保留</option>
            <option value="done">完了</option>
          </select>
          <select
            disabled={bulkUpdating}
            onChange={(e) => {
              if (e.target.value) {
                handleBulkUpdate({ dmStatus: e.target.value });
                e.target.value = "";
              }
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="">DM判断変更...</option>
            <option value="send">送付可</option>
            <option value="no_send">送付不可</option>
            <option value="hold">未判断</option>
          </select>
          <button
            type="button"
            disabled={bulkDeleting || bulkUpdating}
            onClick={handleBulkDelete}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {bulkDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            選択した物件を削除
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkDeleting}
            className="ml-auto text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            選択解除
          </button>
        </div>
      )}

      {/* Bulk delete result */}
      {bulkDeleteResult && (
        <div
          className={`mb-4 rounded-lg border p-3 text-sm ${
            bulkDeleteResult.failureCount === 0
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              一括削除結果: 成功 <b>{bulkDeleteResult.successCount}</b> 件 / 失敗{" "}
              <b>{bulkDeleteResult.failureCount}</b> 件
            </div>
            <button
              onClick={() => setBulkDeleteResult(null)}
              className="text-xs underline hover:no-underline"
            >
              閉じる
            </button>
          </div>
          {bulkDeleteResult.failures.length > 0 && (
            <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-xs">
              {bulkDeleteResult.failures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.address}</span>
                  <span className="ml-2 text-amber-700">{f.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-2 py-3">
                  <input
                    type="checkbox"
                    checked={
                      properties.length > 0 &&
                      selectedIds.size === properties.length
                    }
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  種別
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  住所
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  地番
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  管理ID
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  不動産番号
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  登記状況
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  DM判断
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  案件状況
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  担当者
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600">
                  更新日
                </th>
                <th className="whitespace-nowrap px-2 py-3 font-medium text-gray-600">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleProperties.map((property) => {
                const warning = warningsByProperty.get(property.id);
                return (
                <tr
                  key={property.id}
                  className="transition-colors hover:bg-gray-50"
                >
                  <td className="whitespace-nowrap px-2 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(property.id)}
                      onChange={() => toggleSelect(property.id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link
                      href={`/properties/${property.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {PROPERTY_TYPE_LABELS[property.propertyType] ??
                        property.propertyType}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {warning && (
                      <span
                        title={warning.messages.join("\n")}
                        className={`mr-2 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold align-middle ${
                          warning.severity === "error"
                            ? "bg-red-100 text-red-700"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {warning.severity === "error" ? "要対応" : "警告"}
                        {warning.messages.length > 1 && (
                          <span>×{warning.messages.length}</span>
                        )}
                      </span>
                    )}
                    <Link
                      href={`/properties/${property.id}`}
                      className="hover:text-blue-600"
                    >
                      {property.address}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {property.lotNumber ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-500">
                    {property.importSource ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                    {property.realEstateNumber ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        registryStatusStyles[property.registryStatus] ?? ""
                      }`}
                    >
                      {REGISTRY_STATUS_LABELS[property.registryStatus] ??
                        property.registryStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        dmStatusStyles[property.dmStatus] ?? ""
                      }`}
                    >
                      {DM_STATUS_LABELS[property.dmStatus] ??
                        property.dmStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="text-xs text-gray-600">
                      {CASE_STATUS_LABELS[property.caseStatus] ??
                        property.caseStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {property.assignee?.name ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                    {new Date(property.updatedAt).toLocaleDateString("ja-JP")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <button
                      type="button"
                      title="この物件を削除"
                      disabled={deletingId === property.id}
                      onClick={() => handleDelete(property.id, property.address)}
                      className="inline-flex items-center justify-center rounded-md p-1.5 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingId === property.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                </tr>
                );
              })}
              {visibleProperties.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    {warningOnly
                      ? "警告ありの物件はありません"
                      : "該当する物件が見つかりません"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {pagination.total} 件中{" "}
          {pagination.total > 0
            ? `${(pagination.page - 1) * pagination.limit + 1}〜${Math.min(pagination.page * pagination.limit, pagination.total)}`
            : "0"}{" "}
          件表示
        </p>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className={`flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm ${
              page <= 1
                ? "text-gray-400 cursor-not-allowed"
                : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            <ChevronLeft className="h-4 w-4" />
            前へ
          </button>
          <span className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white">
            {page}
          </span>
          {pagination.totalPages > 1 && (
            <span className="text-sm text-gray-500">
              / {pagination.totalPages}
            </span>
          )}
          <button
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className={`flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm ${
              page >= pagination.totalPages
                ? "text-gray-400 cursor-not-allowed"
                : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            次へ
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
