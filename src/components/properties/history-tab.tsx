"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, History, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { fetchChangeLogs as apiFetchChangeLogs } from "@/lib/api-client";

interface ChangeLogData {
  id: string;
  targetTable: string;
  targetId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: string;
  changedAt: string;
  changer: { id: string; name: string };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const FIELD_LABELS: Record<string, string> = {
  realEstateNumber: "不動産番号",
  address: "住所",
  lotNumber: "地番",
  buildingNumber: "家屋番号",
  registryStatus: "登記状況",
  dmStatus: "DM判断",
  caseStatus: "案件ステータス",
  propertyType: "種別",
  assignedTo: "担当者",
  zoningDistrict: "用途地域",
  rosenkaValue: "路線価",
  rebuildPermission: "再建築許可",
  roadType: "道路種別",
  setbackRequired: "セットバック",
  name: "氏名",
  nameKana: "氏名カナ",
  phone: "電話番号",
  zip: "郵便番号",
  note: "備考",
  propertyId: "物件ID",
  ownerId: "所有者ID",
  relationship: "関係",
  isPrimary: "主所有者",
  gpsLat: "緯度",
  gpsLng: "経度",
  totalFloors: "階数",
  totalUnits: "総戸数",
  builtYear: "築年",
  structureType: "構造",
  managementCompany: "管理会社",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "手動",
  api: "API",
  csv_import: "CSV取込",
  pdf_import: "PDF取込",
};

export default function HistoryTab({
  propertyId,
}: {
  propertyId: string;
}) {
  const [logs, setLogs] = useState<ChangeLogData[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [fieldNameFilter, setFieldNameFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [fieldNames, setFieldNames] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await apiFetchChangeLogs(propertyId, page, {
        fieldName: fieldNameFilter || undefined,
        source: sourceFilter || undefined,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      });
      setLogs(json.data as ChangeLogData[]);
      setPagination(json.pagination as Pagination);
      if (json.fieldNames) setFieldNames(json.fieldNames);
      if (json.sources) setSources(json.sources);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "変更履歴の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, page, fieldNameFilter, sourceFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
              フィールド
            </label>
            <select
              value={fieldNameFilter}
              onChange={(e) => { setFieldNameFilter(e.target.value); setPage(1); }}
              className="block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {fieldNames.map((f) => (
                <option key={f} value={f}>{FIELD_LABELS[f] ?? f}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
              変更元
            </label>
            <select
              value={sourceFilter}
              onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
              className="block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {sources.map((s) => (
                <option key={s} value={s}>{SOURCE_LABELS[s] ?? s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
              日付（開始）
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              className="block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
              日付（終了）
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              className="block w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setFieldNameFilter("");
                setSourceFilter("");
                setDateFrom("");
                setDateTo("");
                setPage(1);
              }}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              リセット
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <History className="h-8 w-8 mb-2" />
          <p className="text-sm">
            {fieldNameFilter || sourceFilter || dateFrom || dateTo
              ? "条件に一致する変更履歴はありません"
              : "変更履歴はまだありません"}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    日時
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    変更者
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    変更元
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    フィールド
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    変更前
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600">
                    変更後
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500 text-xs">
                      {new Date(log.changedAt).toLocaleString("ja-JP")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.changer.name}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {SOURCE_LABELS[log.source] ?? log.source}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {FIELD_LABELS[log.fieldName] ?? log.fieldName}
                    </td>
                    <td className="px-3 py-2 max-w-[200px] truncate">
                      {log.oldValue != null ? (
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                          {log.oldValue}
                        </span>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[200px] truncate">
                      {log.newValue != null ? (
                        <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">
                          {log.newValue}
                        </span>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-gray-500">
                全 {pagination.total} 件{pagination.total > 0 && `中 ${(page - 1) * 50 + 1}〜${Math.min(page * 50, pagination.total)} 件`}
              </p>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                >
                  <ChevronLeft className="h-3 w-3" />
                  前へ
                </button>
                <span className="text-xs text-gray-600">
                  {page} / {pagination.totalPages}
                </span>
                <button
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                >
                  次へ
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
