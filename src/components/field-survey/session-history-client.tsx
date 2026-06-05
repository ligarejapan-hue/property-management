"use client";

/**
 * Phase 1-J: 巡回セッション一覧 (client)。
 *
 * - GET /api/field-survey/sessions?scope=&status=&page= を呼ぶ。
 * - scope=all は read_all/manage を持つ場合のみ選択肢を出す (server で canSeeAll 判定)。
 * - 各行から /field-survey/map?sessionId={id} へ遷移して過去ルートを閲覧する。
 * - 座標 / memo / 写真情報 / storageKey / PII は表示しない (API も返さない)。
 * - localStorage / sessionStorage / IndexedDB は使わない。
 * - console に session 情報 / PII を出さない。エラーは汎用文言のみ。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Scope = "mine" | "all";
type StatusFilter = "ended" | "active" | "cancelled" | "all";

interface SessionRow {
  id: string;
  staffUserId: string;
  staffName: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  pointCount: number;
  pinCount: number;
}

const STATUS_LABEL: Record<string, string> = {
  active: "記録中",
  ended: "終了",
  cancelled: "中止",
};

const PAGE_LIMIT = 20;

export default function SessionHistoryClient({
  canSeeAll,
}: {
  canSeeAll: boolean;
}) {
  const [scope, setScope] = useState<Scope>("mine");
  const [status, setStatus] = useState<StatusFilter>("ended");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const qs = new URLSearchParams({
        scope,
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      if (status !== "all") qs.set("status", status);
      const res = await fetch(`/api/field-survey/sessions?${qs.toString()}`, {
        credentials: "same-origin",
        signal: ac.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setRows([]);
        setError(
          res.status === 403
            ? "閲覧権限がありません。"
            : "巡回履歴の取得に失敗しました。",
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { data?: SessionRow[]; pagination?: { totalPages?: number } }
        | null;
      if (!mountedRef.current) return;
      setRows(Array.isArray(body?.data) ? body!.data! : []);
      setTotalPages(body?.pagination?.totalPages ?? 1);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (!mountedRef.current) return;
      setRows([]);
      setError("巡回履歴の取得に失敗しました。");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [scope, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // フィルタ変更時は 1 ページ目へ戻す。
  const onScopeChange = (v: Scope) => {
    setScope(v);
    setPage(1);
  };
  const onStatusChange = (v: StatusFilter) => {
    setStatus(v);
    setPage(1);
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        {canSeeAll && (
          <label className="flex items-center gap-1">
            <span className="text-gray-600">範囲</span>
            <select
              data-testid="session-history-scope"
              value={scope}
              onChange={(e) => onScopeChange(e.target.value as Scope)}
              className="rounded border border-gray-300 px-2 py-1"
            >
              <option value="mine">自分</option>
              <option value="all">全員</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-1">
          <span className="text-gray-600">状態</span>
          <select
            data-testid="session-history-status"
            value={status}
            onChange={(e) => onStatusChange(e.target.value as StatusFilter)}
            className="rounded border border-gray-300 px-2 py-1"
          >
            <option value="ended">終了</option>
            <option value="active">記録中</option>
            <option value="cancelled">中止</option>
            <option value="all">すべて</option>
          </select>
        </label>
      </div>

      {error && (
        <p
          role="status"
          className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
        >
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-2 text-left">開始</th>
              <th className="px-2 py-2 text-left">終了</th>
              <th className="px-2 py-2 text-left">所要時間</th>
              <th className="px-2 py-2 text-left">状態</th>
              <th className="px-2 py-2 text-left">スタッフ</th>
              <th className="px-2 py-2 text-right">記録点</th>
              <th className="px-2 py-2 text-right">ピン</th>
              <th className="px-2 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rows.map((r) => (
              <tr key={r.id} data-testid="session-history-row">
                <td className="px-2 py-2">{formatDateTime(r.startedAt)}</td>
                <td className="px-2 py-2">{formatDateTime(r.endedAt)}</td>
                <td className="px-2 py-2">
                  {formatDuration(r.startedAt, r.endedAt)}
                </td>
                <td className="px-2 py-2">
                  {STATUS_LABEL[r.status] ?? r.status}
                </td>
                <td className="px-2 py-2">{r.staffName ?? "—"}</td>
                <td className="px-2 py-2 text-right">{r.pointCount}</td>
                <td className="px-2 py-2 text-right">{r.pinCount}</td>
                <td className="px-2 py-2">
                  <Link
                    href={`/field-survey/map?sessionId=${encodeURIComponent(r.id)}`}
                    data-testid="session-history-view-map"
                    className="text-indigo-600 hover:underline"
                  >
                    地図で見る
                  </Link>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-gray-500">
                  巡回履歴がありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-gray-500">
          {loading ? "読み込み中…" : `ページ ${page} / ${totalPages}`}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={loading || page <= 1}
            className="rounded border border-gray-300 bg-white px-3 py-1 disabled:opacity-50"
          >
            前へ
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={loading || page >= totalPages}
            className="rounded border border-gray-300 bg-white px-3 py-1 disabled:opacity-50"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return "—";
  const sec = Math.floor((e - s) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}
