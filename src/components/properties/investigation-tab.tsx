"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  RefreshCw,
  Edit,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  Save,
  X,
} from "lucide-react";
import {
  fetchPropertyInvestigation,
  triggerPropertyInvestigation,
  patchPropertyInvestigation,
  confirmPropertyInvestigation,
  type PropertyInvestigationData,
} from "@/lib/api-client";

// ---------- Props ----------

interface InvestigationTabProps {
  propertyId: string;
}

// ---------- Status helpers ----------

const STATUS_CONFIG: Record<
  string,
  { label: string; badge: string; icon: React.ElementType }
> = {
  draft: {
    label: "未取得",
    badge: "bg-gray-100 text-gray-600",
    icon: Clock,
  },
  fetching: {
    label: "取得中",
    badge: "bg-blue-100 text-blue-800",
    icon: Loader2,
  },
  needs_review: {
    label: "要確認",
    badge: "bg-amber-100 text-amber-800",
    icon: AlertTriangle,
  },
  confirmed: {
    label: "確認済み",
    badge: "bg-green-100 text-green-800",
    icon: CheckCircle2,
  },
  failed: {
    label: "取得失敗",
    badge: "bg-red-100 text-red-800",
    icon: AlertTriangle,
  },
};

// ---------- Field definitions ----------

interface FieldDef {
  key: keyof Omit<
    PropertyInvestigationData,
    "id" | "propertyId" | "status" | "fetchedAt" | "confirmedAt" | "confirmedBy" | "version" | "createdAt" | "updatedAt" | "auditLogs" | "sourceAddress"
  >;
  label: string;
  type: "text" | "number" | "textarea";
  format?: (v: string | number | null | undefined) => string;
}

const FIELDS: FieldDef[] = [
  { key: "zoningDistrict", label: "用途地域", type: "text" },
  {
    key: "buildingCoverageRatio",
    label: "建蔽率",
    type: "number",
    format: (v) => (v != null ? `${v}%` : "-"),
  },
  {
    key: "floorAreaRatio",
    label: "容積率",
    type: "number",
    format: (v) => (v != null ? `${v}%` : "-"),
  },
  { key: "hazardSummary", label: "ハザード概要", type: "textarea" },
  { key: "roadSummary", label: "道路概要", type: "textarea" },
  { key: "infrastructureSummary", label: "インフラ概要", type: "textarea" },
  { key: "sourceSummary", label: "出典", type: "text" },
  { key: "normalizedAddress", label: "正規化住所", type: "text" },
  { key: "landLotNumber", label: "地番", type: "text" },
  {
    key: "latitude",
    label: "緯度",
    type: "number",
    format: (v) => (v != null ? String(v) : "-"),
  },
  {
    key: "longitude",
    label: "経度",
    type: "number",
    format: (v) => (v != null ? String(v) : "-"),
  },
];

const ACTION_LABELS: Record<string, string> = {
  // 旧アクション名（既存レコード互換）
  fetch: "自動取得",
  edit: "手動編集",
  confirm: "確認済み設定",
  // 新アクション名
  fetch_requested: "取得開始",
  fetch_succeeded: "取得成功",
  fetch_failed: "取得失敗",
  updated: "手動編集",
  confirmed: "確認済み設定",
  reopened: "再オープン",
};

// ---------- Component ----------

export default function InvestigationTab({ propertyId }: InvestigationTabProps) {
  const [investigation, setInvestigation] = useState<PropertyInvestigationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchPropertyInvestigation(propertyId);
      setInvestigation(data);
    } catch {
      // ignore – no record yet
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    load();
  }, [load]);

  const showMsg = (text: string, type: "success" | "error" = "success") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      const data = await triggerPropertyInvestigation(propertyId);
      setInvestigation(data);
      showMsg("調査情報を取得しました");
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setFetching(false);
    }
  };

  const handleStartEdit = () => {
    const vals: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = investigation?.[f.key];
      vals[f.key] = v != null ? String(v) : "";
    }
    setEditValues(vals);
    setEditMode(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string | number | null> = {};
      for (const f of FIELDS) {
        const raw = editValues[f.key];
        if (f.type === "number") {
          payload[f.key] = raw !== "" ? Number(raw) : null;
        } else {
          payload[f.key] = raw || null;
        }
      }
      const data = await patchPropertyInvestigation(propertyId, payload);
      setInvestigation(data);
      setEditMode(false);
      showMsg("保存しました");
    } catch (err) {
      showMsg(err instanceof Error ? err.message : "保存に失敗しました", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      const data = await confirmPropertyInvestigation(propertyId);
      setInvestigation(data);
      showMsg("調査情報を確認済みにしました");
      setEditMode(false);
    } catch (err) {
      showMsg(err instanceof Error ? err.message : "確認に失敗しました", "error");
    } finally {
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  const status = investigation?.status ?? "draft";
  const statusCfg = STATUS_CONFIG[status] ?? STATUS_CONFIG["draft"]!;
  const StatusIcon = statusCfg.icon;
  const isConfirmed = status === "confirmed";

  return (
    <div className="space-y-5">
      {/* --- Status bar --- */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${statusCfg.badge}`}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {statusCfg.label}
        </span>

        {investigation?.fetchedAt && (
          <span className="text-xs text-gray-500">
            取得: {new Date(investigation.fetchedAt).toLocaleString("ja-JP")}
          </span>
        )}
        {investigation?.confirmedAt && (
          <span className="text-xs text-gray-500">
            確認: {new Date(investigation.confirmedAt).toLocaleString("ja-JP")}
            {investigation.confirmedBy && ` (${investigation.confirmedBy.name})`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleFetch}
            disabled={fetching}
            className="flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            {fetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {fetching ? "取得中..." : "調査情報を取得"}
          </button>

          {!isConfirmed && !editMode && investigation && (
            <button
              onClick={handleStartEdit}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Edit className="h-3.5 w-3.5" />
              編集
            </button>
          )}
        </div>
      </div>

      {/* --- Error alert --- */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* --- Flash message --- */}
      {message && (
        <div
          className={`rounded-md border p-2.5 text-xs ${
            message.type === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-green-200 bg-green-50 text-green-700"
          }`}
        >
          {message.type === "error" ? (
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          )}
          {message.text}
        </div>
      )}

      {/* --- No record yet --- */}
      {!investigation && (
        <div className="rounded-md border border-dashed border-gray-300 py-10 text-center">
          <p className="text-sm text-gray-500">
            調査情報はまだ取得されていません。
          </p>
          <p className="mt-1 text-xs text-gray-400">
            「調査情報を取得」ボタンを押してデータを取得してください。
          </p>
        </div>
      )}

      {/* --- Data table --- */}
      {investigation && (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-36 px-3 py-2 text-left text-xs font-medium text-gray-500">
                  項目
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  {editMode ? "現在値" : "値"}
                </th>
                {editMode && (
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                    編集値
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {FIELDS.map((f) => {
                const val = investigation[f.key];
                const display = f.format
                  ? f.format(val as string | number | null)
                  : val != null
                  ? String(val)
                  : "-";

                return (
                  <tr key={f.key}>
                    <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-gray-600">
                      {f.label}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {f.type === "textarea" ? (
                        <span className="whitespace-pre-wrap">{display}</span>
                      ) : (
                        display
                      )}
                    </td>
                    {editMode && (
                      <td className="px-3 py-2">
                        {f.type === "textarea" ? (
                          <textarea
                            value={editValues[f.key] ?? ""}
                            onChange={(e) =>
                              setEditValues((prev) => ({
                                ...prev,
                                [f.key]: e.target.value,
                              }))
                            }
                            rows={3}
                            className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
                          />
                        ) : (
                          <input
                            type={f.type}
                            step={f.type === "number" ? "any" : undefined}
                            value={editValues[f.key] ?? ""}
                            onChange={(e) =>
                              setEditValues((prev) => ({
                                ...prev,
                                [f.key]: e.target.value,
                              }))
                            }
                            className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Edit mode action bar --- */}
      {editMode && (
        <div className="flex items-center gap-2 border-t border-gray-200 pt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming || saving}
            className="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {confirming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            確認済みにする
          </button>
          <button
            onClick={() => setEditMode(false)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
        </div>
      )}

      {/* --- Confirm button (display mode, not yet confirmed) --- */}
      {!editMode && !isConfirmed && investigation && (
        <div className="flex justify-end pt-1">
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {confirming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            確認済みにする
          </button>
        </div>
      )}

      {/* --- Source summary + auto fetch info (display mode) --- */}
      {investigation?.autoFetchSummary && !editMode && (
        <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-500">
          <p className="font-medium text-gray-600">プロバイダ実行結果</p>
          <pre className="mt-1 whitespace-pre-wrap">{investigation.autoFetchSummary}</pre>
        </div>
      )}

      {/* --- Audit log --- */}
      {investigation && (investigation.auditLogs?.length ?? 0) > 0 && (
        <div className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setShowAuditLog(!showAuditLog)}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            {showAuditLog ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            操作履歴 ({investigation.auditLogs.length}件)
          </button>

          {showAuditLog && (
            <div className="mt-3 space-y-2">
              {investigation.auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs"
                >
                  <span className="mt-0.5 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                    {ACTION_LABELS[log.action] ?? log.action}
                  </span>
                  <div className="min-w-0 flex-1">
                    {log.note && (
                      <p className="text-gray-700">{log.note}</p>
                    )}
                    <p className="text-gray-400">
                      {log.creator.name} •{" "}
                      {new Date(log.createdAt).toLocaleString("ja-JP")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
