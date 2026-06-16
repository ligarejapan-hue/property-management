"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, Wand2, ExternalLink } from "lucide-react";

// route（text-hygiene-candidates）の応答に対応するクライアント表示用の型。
type IssueCode =
  | "control_chars"
  | "zero_width"
  | "bidi"
  | "replacement_char"
  | "mojibake";
type FieldKey = "name" | "nameKana" | "address" | "note";
type Severity = "error" | "warning" | "info";
type RecommendedAction = "review" | "sanitize_candidate";

interface FieldReport {
  field: FieldKey;
  valueMasked: string | null;
  issues: IssueCode[];
  severity: Severity | null;
  removable: boolean;
  auditOnly: boolean;
  recommendedAction: RecommendedAction;
}
interface Candidate {
  ownerId: string;
  version: number;
  fields: FieldReport[];
  detailUrl: string;
}
interface Summary {
  controlChars: number;
  zeroWidth: number;
  bidi: number;
  replacementChar: number;
  mojibake: number;
  removableCandidates: number;
  auditOnlyCandidates: number;
  totalCandidates: number;
}
interface ApiResponse {
  type: string;
  candidates: Candidate[];
  summary: Summary;
  hasNextPage: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

const TYPE_OPTIONS: { value: string; summaryKey: keyof Summary }[] = [
  { value: "all", summaryKey: "totalCandidates" },
  { value: "control_chars", summaryKey: "controlChars" },
  { value: "zero_width", summaryKey: "zeroWidth" },
  { value: "bidi", summaryKey: "bidi" },
  { value: "replacement_char", summaryKey: "replacementChar" },
  { value: "mojibake", summaryKey: "mojibake" },
];

const TYPE_LABEL: Record<string, string> = {
  all: "すべて",
  control_chars: "制御文字",
  zero_width: "ゼロ幅",
  bidi: "双方向制御",
  replacement_char: "文字化け(U+FFFD)",
  mojibake: "文字化け(mojibake)",
};
const ISSUE_LABEL: Record<IssueCode, string> = {
  control_chars: "制御文字",
  zero_width: "ゼロ幅",
  bidi: "双方向制御",
  replacement_char: "文字化け(U+FFFD)",
  mojibake: "文字化け(mojibake)",
};
const FIELD_LABEL: Record<FieldKey, string> = {
  name: "氏名",
  nameKana: "氏名カナ",
  address: "住所",
  note: "備考",
};

const SEVERITY_CLASS: Record<Severity, string> = {
  error: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-gray-100 text-gray-600",
};

export default function TextHygieneAuditPage() {
  const [type, setType] = useState("all");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [meta, setMeta] = useState<{
    hasNextPage: boolean;
    nextCursor: string | null;
    truncated: boolean;
  }>({ hasNextPage: false, nextCursor: null, truncated: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 二段階のインライン確認（${ownerId}:${field}）。誤クリックでの自動補正を避ける。
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(
    async (t: string, cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const qs = new URLSearchParams({ type: t, limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(
          `/api/admin/owners/text-hygiene-candidates?${qs.toString()}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.error?.message ?? `取得に失敗しました (${res.status})`,
          );
        }
        const json: ApiResponse = await res.json();
        setCandidates((prev) =>
          append ? [...prev, ...json.candidates] : json.candidates,
        );
        // summary はスキャン窓全体の集計。append（同一窓の続き/次窓）では初回値を保つ。
        if (!append) setSummary(json.summary);
        setMeta({
          hasNextPage: json.hasNextPage,
          nextCursor: json.nextCursor,
          truncated: json.truncated,
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "テキスト衛生監査の取得に失敗しました",
        );
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(type, null, false);
  }, [type, load]);

  async function handleSanitize(
    ownerId: string,
    field: FieldKey,
    version: number,
  ) {
    const key = `${ownerId}:${field}`;
    setBusyKey(key);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/admin/owners/${ownerId}/correction/text-fix`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version, field, mode: "sanitize", dryRun: false }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `補正に失敗しました (${res.status})`,
        );
      }
      setConfirmKey(null);
      await load(type, null, false); // version 変化・行消失を反映するため再取得
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "補正に失敗しました");
    } finally {
      setBusyKey(null);
    }
  }

  // owner×field をフラットな行に展開する（issue を持つフィールドのみ）。
  const rows = candidates.flatMap((c) =>
    c.fields.map((f) => ({ owner: c, report: f })),
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-gray-700">
          管理
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">テキスト衛生監査</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        テキスト衛生監査（制御文字・文字化け）
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        所有者の氏名・氏名カナ・住所・備考に紛れた制御文字・ゼロ幅・双方向制御・文字化け（U+FFFD /
        mojibake）を検出します。
        <span className="font-medium">不可視の制御文字のみ</span>
        が自動除去可（情報を失いません）。
        <span className="font-medium">文字化け（U+FFFD / mojibake）</span>
        は原本の取り直しが必要なため自動除去せず、確認のみです。備考は絵文字保護のため確認のみ（自動除去しません）。
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* 種別フィルタ（件数は最新スキャン窓の集計） */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-gray-200 pb-2">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setType(opt.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              type === opt.value
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            {TYPE_LABEL[opt.value]}
            {summary ? `（${summary[opt.summaryKey]}）` : ""}
          </button>
        ))}
      </div>

      {meta.truncated && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            走査が上限に達したため、全件は確認できていません（「もっと読み込む」で続きを取得できます）。
          </span>
        </div>
      )}

      <div
        className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
        data-pii-protected
        data-pii-surface="owner"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            対象の制御文字・文字化けは見つかりませんでした（権限により一部のフィールドは監査対象外の場合があります）。
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  所有者
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  フィールド
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  値
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  検出
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {rows.map(({ owner, report }) => {
                const key = `${owner.ownerId}:${report.field}`;
                const canSanitize =
                  report.recommendedAction === "sanitize_candidate";
                return (
                  <tr key={key} className="align-top hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm">
                      <Link
                        href={owner.detailUrl}
                        className="font-mono text-indigo-600 hover:text-indigo-800"
                      >
                        {owner.ownerId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {FIELD_LABEL[report.field]}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-900 break-all">
                      {report.valueMasked ?? (
                        <span className="text-gray-400">（非表示）</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-1">
                        {report.issues.map((code) => (
                          <span
                            key={code}
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              report.severity
                                ? SEVERITY_CLASS[report.severity]
                                : SEVERITY_CLASS.info
                            }`}
                          >
                            {ISSUE_LABEL[code]}
                          </span>
                        ))}
                        <span className="ml-1 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                          {canSanitize ? "自動除去可" : "要確認"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        {canSanitize &&
                          (confirmKey === key ? (
                            <span className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busyKey === key}
                                onClick={() =>
                                  handleSanitize(
                                    owner.ownerId,
                                    report.field,
                                    owner.version,
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                {busyKey === key && (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                )}
                                実行する
                              </button>
                              <button
                                type="button"
                                disabled={busyKey === key}
                                onClick={() => setConfirmKey(null)}
                                className="text-xs text-gray-500 hover:text-gray-700"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmKey(key)}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <Wand2 className="h-3 w-3" />
                              不可視文字を除去
                            </button>
                          ))}
                        <Link
                          href={owner.detailUrl}
                          className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
                        >
                          <ExternalLink className="h-3 w-3" />
                          詳細
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {meta.hasNextPage && !loading && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => load(type, meta.nextCursor, true)}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            もっと読み込む
          </button>
        </div>
      )}
    </div>
  );
}
