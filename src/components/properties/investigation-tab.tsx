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

// ---------- reinfolib meta helpers ----------

/**
 * rawPayloadJson.providers[] から name === "reinfolib" のプロバイダ meta を安全に取得する。
 * 存在しない場合は null を返す。
 */
function getReinfolibProviderMeta(
  rawPayloadJson: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!rawPayloadJson) return null;
  const providers = rawPayloadJson.providers;
  if (!Array.isArray(providers)) return null;
  const reinfolib = providers.find(
    (p): p is Record<string, unknown> =>
      typeof p === "object" && p !== null && (p as Record<string, unknown>).name === "reinfolib",
  );
  if (!reinfolib) return null;
  const meta = reinfolib.meta;
  if (typeof meta !== "object" || meta === null) return null;
  return meta as Record<string, unknown>;
}

/**
 * エンドポイント別メタから selectionReason 文字列を安全に取得する。
 * endpointKey 例: "flood" | "stormSurge" | "tsunami" | "sediment"
 *              | "firezone" | "zoning" | "road"
 */
function getEndpointSelectionReason(
  providerMeta: Record<string, unknown> | null,
  endpointKey: string,
): string | null {
  if (!providerMeta) return null;
  const endpoint = providerMeta[endpointKey];
  if (typeof endpoint !== "object" || endpoint === null) return null;
  const reason = (endpoint as Record<string, unknown>).selectionReason;
  return typeof reason === "string" ? reason : null;
}

/** selectionReason が「判定競合」系かどうかを判定するセット */
const CONFLICTING_REASONS = new Set([
  "conflicting candidates",
  "conflicting zoning candidates",
  "conflicting ratio candidates",
  "insufficient candidate attributes",
]);

type FieldDisplayVariant = "value" | "absent" | "caution" | "default";

/**
 * フィールド値 + selectionReason から表示文字列とスタイル種別を決定する。
 *
 * | value    | selectionReason                    | 表示                    | variant  |
 * |----------|------------------------------------|-------------------------|----------|
 * | 非 null  | any                                | 値をそのまま表示         | value    |
 * | null     | "no features returned"             | 該当なし                 | absent   |
 * | null     | "no spatial match"                 | 該当なし                 | absent   |
 * | null     | "explicit value not resolved"      | 要確認（属性未解決）     | caution  |
 * | null     | 競合系いずれか                     | 要確認（判定競合）       | caution  |
 * | null     | その他 / meta なし                 | format(null) or "-"      | default  |
 */
function resolveFieldDisplay(
  value: unknown,
  selectionReason: string | null,
  format?: (v: string | number | null | undefined) => string,
): { text: string; variant: FieldDisplayVariant } {
  if (value != null) {
    return {
      text: format ? format(value as string | number) : String(value),
      variant: "value",
    };
  }
  if (selectionReason === "no features returned" || selectionReason === "no spatial match") {
    return { text: "該当なし", variant: "absent" };
  }
  if (selectionReason === "explicit value not resolved") {
    return { text: "要確認（属性未解決）", variant: "caution" };
  }
  if (selectionReason !== null && CONFLICTING_REASONS.has(selectionReason)) {
    return { text: "要確認（判定競合）", variant: "caution" };
  }
  return { text: format ? format(null) : "-", variant: "default" };
}

// ---------- Field definitions ----------

interface FieldDef {
  key: keyof Omit<
    PropertyInvestigationData,
    | "id" | "propertyId" | "status" | "fetchedAt" | "confirmedAt" | "confirmedBy"
    | "version" | "createdAt" | "updatedAt" | "auditLogs" | "sourceAddress"
    | "autoFetchSummary" | "fieldSourcesJson" | "rawPayloadJson"
    | "lastFetchError" | "fetchVersion"
    | "postalCode" | "municipalityCode" | "geocodePrecision"
    | "heightDistrict" | "facilitySummary"
  >;
  label: string;
  type: "text" | "number" | "textarea";
  format?: (v: string | number | null | undefined) => string;
  /** セクション区切り見出し。このフィールドの直前に見出し行を挿入する */
  sectionLabel?: string;
  /**
   * reinfolib エンドポイント meta キー。
   * 設定されている場合、値が null のときに selectionReason に応じた表示に切り替える。
   * 例: "flood" | "stormSurge" | "tsunami" | "sediment"
   *   | "firezone" | "zoning" | "road"
   */
  endpointMetaKey?: string;
}

const FIELDS: FieldDef[] = [
  // ── 法規制情報 ─────────────────────────────────────────────────────
  { key: "zoningDistrict",        label: "用途地域",            type: "text",     sectionLabel: "法規制情報", endpointMetaKey: "zoning" },
  { key: "buildingCoverageRatio", label: "建蔽率",              type: "number",   format: (v) => (v != null ? `${v}%` : "-"), endpointMetaKey: "zoning" },
  { key: "floorAreaRatio",        label: "容積率",              type: "number",   format: (v) => (v != null ? `${v}%` : "-"), endpointMetaKey: "zoning" },
  { key: "firePreventionArea",    label: "防火地域/準防火地域", type: "text",     endpointMetaKey: "firezone" },
  // ── ハザード詳細 ──────────────────────────────────────────────────
  { key: "hazardSummary",         label: "ハザード概要（自動）", type: "textarea", sectionLabel: "ハザード詳細" },
  { key: "floodRiskLevel",        label: "洪水",                type: "text",     endpointMetaKey: "flood" },
  { key: "stormSurgeRiskLevel",   label: "高潮",                type: "text",     endpointMetaKey: "stormSurge" },
  { key: "tsunamiRiskLevel",      label: "津波",                type: "text",     endpointMetaKey: "tsunami" },
  { key: "sedimentRiskCategory",  label: "土砂災害",            type: "text",     endpointMetaKey: "sediment" },
  // ── 道路・インフラ ─────────────────────────────────────────────────
  { key: "roadSummary",           label: "道路概要",            type: "textarea", sectionLabel: "道路・インフラ", endpointMetaKey: "road" },
  { key: "infrastructureSummary", label: "インフラ概要",        type: "textarea" },
  // ── 価格参考情報 ──────────────────────────────────────────────────
  { key: "nearbyPriceSummary",    label: "近隣価格参考",        type: "textarea", sectionLabel: "価格参考情報" },
  { key: "landPriceSummary",      label: "公示地価/地価調査参考", type: "textarea" },
  // ── 位置・出典 ───────────────────────────────────────────────────
  { key: "normalizedAddress",     label: "正規化住所",          type: "text",     sectionLabel: "位置・出典" },
  { key: "landLotNumber",         label: "地番",                type: "text" },
  { key: "latitude",              label: "緯度",                type: "number",   format: (v) => (v != null ? String(v) : "-") },
  { key: "longitude",             label: "経度",                type: "number",   format: (v) => (v != null ? String(v) : "-") },
  { key: "sourceSummary",         label: "出典",                type: "text" },
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

  // reinfolib エンドポイント別 meta（selectionReason ベースの表示分岐に使用）
  const reinfolibMeta = getReinfolibProviderMeta(investigation?.rawPayloadJson ?? null);

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

      {/* --- Server-side fetch error (lastFetchError from DB) --- */}
      {investigation?.lastFetchError && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-800">前回の取得エラー</p>
            <p className="mt-0.5 break-all font-mono text-xs text-amber-700">
              {investigation.lastFetchError}
            </p>
          </div>
        </div>
      )}

      {/* --- Data table --- */}
      {investigation && (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-40 px-3 py-2 text-left text-xs font-medium text-gray-500">
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

                // endpointMetaKey が設定されているフィールドは selectionReason ベースの表示に切り替える
                const { text: display, variant } = f.endpointMetaKey
                  ? resolveFieldDisplay(
                      val,
                      getEndpointSelectionReason(reinfolibMeta, f.endpointMetaKey),
                      f.format,
                    )
                  : {
                      text: f.format
                        ? f.format(val as string | number | null)
                        : val != null
                        ? String(val)
                        : "-",
                      variant: "default" as FieldDisplayVariant,
                    };

                // variant に応じてセル文字色を変える
                const cellTextClass =
                  variant === "absent"
                    ? "text-gray-400 italic"         // 該当なし → 薄いグレー
                    : variant === "caution"
                    ? "text-amber-600 font-medium"   // 要確認 → アンバー
                    : "text-gray-700";               // 通常 / default

                return (
                  <React.Fragment key={f.key}>
                    {/* セクション見出し行 */}
                    {f.sectionLabel && (
                      <tr className="border-t-2 border-gray-200 bg-gray-50">
                        <td
                          colSpan={editMode ? 3 : 2}
                          className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500"
                        >
                          {f.sectionLabel}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-gray-600">
                        {f.label}
                      </td>
                      <td className={`px-3 py-2 text-xs ${cellTextClass}`}>
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
                  </React.Fragment>
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

      {/* --- 参考情報・出典表示 --- */}
      {investigation && !editMode && (
        <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700">
          <p className="font-medium">※ 参考情報</p>
          <p className="mt-0.5 text-blue-600">
            この調査情報は自動取得した参考情報です。実際の規制内容は各自治体・法務局等でご確認ください。
          </p>
          {investigation.sourceSummary && (
            <p className="mt-1 text-blue-500">
              出典: {investigation.sourceSummary}（加工して表示）
            </p>
          )}
          {!investigation.sourceSummary && (
            <p className="mt-1 text-blue-500">
              出典: 国土交通省 不動産情報ライブラリ（加工して表示）
            </p>
          )}
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
