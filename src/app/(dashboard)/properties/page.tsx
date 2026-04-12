"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { fetchProperties as apiFetchProperties, bulkUpdateProperties } from "@/lib/api-client";

// ---------- Label maps ----------

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  land: "土地",
  building: "建物",
  unit: "区分",
  unknown: "不明",
};

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
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------- Component ----------

export default function PropertiesPage() {
  const [properties, setProperties] = useState<ApiProperty[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchText, setSearchText] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [registryFilter, setRegistryFilter] = useState("");
  const [dmFilter, setDmFilter] = useState("");
  const [page, setPage] = useState(1);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const fetchProperties = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params: Record<string, string> = { page: String(page), limit: "50" };
    if (searchText) params.keyword = searchText;
    if (typeFilter) params.propertyType = typeFilter;
    if (registryFilter) params.registryStatus = registryFilter;
    if (dmFilter) params.dmStatus = dmFilter;

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
  }, [page, searchText, typeFilter, registryFilter, dmFilter]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  // Debounce search: reset page on filter change
  const handleFilterChange = (setter: (v: string) => void) => (
    e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>,
  ) => {
    setter(e.target.value);
    setPage(1);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === properties.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(properties.map((p) => p.id)));
    }
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
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">物件一覧</h2>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <select
          value={typeFilter}
          onChange={handleFilterChange(setTypeFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">種別: すべて</option>
          <option value="land">土地</option>
          <option value="building">建物</option>
          <option value="unit">区分</option>
          <option value="unknown">不明</option>
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
            placeholder="住所・地番・不動産番号で検索"
            value={searchText}
            onChange={handleFilterChange(setSearchText)}
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
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
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-gray-500 hover:text-gray-700"
          >
            選択解除
          </button>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {properties.map((property) => (
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
                </tr>
              ))}
              {properties.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    該当する物件が見つかりません
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
