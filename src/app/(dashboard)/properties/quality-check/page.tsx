"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  RefreshCw,
} from "lucide-react";
import { fetchQualityCheck } from "@/lib/api-client";

interface QualityIssue {
  propertyId: string;
  address: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

interface Summary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  propertiesChecked: number;
}

const severityConfig = {
  error: {
    icon: AlertCircle,
    bg: "bg-red-50 border-red-200",
    text: "text-red-700",
    badge: "bg-red-100 text-red-800",
    label: "エラー",
  },
  warning: {
    icon: AlertTriangle,
    bg: "bg-amber-50 border-amber-200",
    text: "text-amber-700",
    badge: "bg-amber-100 text-amber-800",
    label: "警告",
  },
  info: {
    icon: Info,
    bg: "bg-blue-50 border-blue-200",
    text: "text-blue-700",
    badge: "bg-blue-100 text-blue-800",
    label: "情報",
  },
};

export default function QualityCheckPage() {
  const [issues, setIssues] = useState<QualityIssue[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string>("");

  const runCheck = async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchQualityCheck();
      setIssues(json.data as QualityIssue[]);
      setSummary(json.summary as Summary);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "品質チェックに失敗しました",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runCheck();
  }, []);

  const filteredIssues = filterSeverity
    ? issues.filter((i) => i.severity === filterSeverity)
    : issues;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">データ品質チェック</h2>
        <button
          onClick={runCheck}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          再チェック
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard
            label="チェック物件数"
            count={summary.propertiesChecked}
            color="text-gray-800"
          />
          <SummaryCard
            label="エラー"
            count={summary.errors}
            color="text-red-600"
          />
          <SummaryCard
            label="警告"
            count={summary.warnings}
            color="text-amber-600"
          />
          <SummaryCard
            label="情報"
            count={summary.info}
            color="text-blue-600"
          />
        </div>
      )}

      {/* Filter */}
      <div className="mb-4">
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">すべての重要度</option>
          <option value="error">エラーのみ</option>
          <option value="warning">警告のみ</option>
          <option value="info">情報のみ</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">チェック中...</span>
        </div>
      ) : filteredIssues.length === 0 ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-8 text-center">
          <p className="text-sm text-green-700">
            問題は検出されませんでした
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredIssues.map((issue, i) => {
            const config = severityConfig[issue.severity];
            const Icon = config.icon;
            return (
              <div
                key={`${issue.propertyId}-${issue.code}-${i}`}
                className={`flex items-start gap-3 rounded-md border p-3 ${config.bg}`}
              >
                <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${config.text}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${config.badge}`}
                    >
                      {config.label}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">
                      {issue.code}
                    </span>
                  </div>
                  <p className={`text-sm ${config.text}`}>{issue.message}</p>
                  <Link
                    href={`/properties/${issue.propertyId}`}
                    className="mt-1 inline-block text-xs text-blue-600 hover:underline"
                  >
                    {issue.address}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
      <p className={`text-2xl font-bold ${color}`}>{count}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}
