"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  REACTION_STATUSES,
  REACTION_LABELS,
  type ReactionStatus,
} from "@/lib/dm-reaction/core";
import { dmMethodLabel } from "@/lib/dm-method-labels";

// 孤児DM記録の訂正(admin・設計§2.4)。物件を削除すると、その物件の送付記録は
// 所有者側に残る(拒否・宛先不明の履歴を道連れにしないため)。ここは物件ページから
// 辿れなくなった記録の「反響の訂正」「記録の取消」を行う唯一の入口。

interface OrphanLog {
  id: string;
  sentAt: string;
  method: string | null;
  reactionStatus: string;
  reactedAt: string | null;
  reactionNote: string | null;
  reactionSource: string | null;
  owner: { id: string; name: string | null } | null;
  coOwners: Array<{ id: string; name: string | null }>;
}

const REACTION_COLORS: Record<string, string> = {
  replied: "bg-green-100 text-green-800 dark:bg-green-500/10 dark:text-green-300",
  refused: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
  undeliverable: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
  no_response: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export default function OrphanDmLogsPage() {
  const [logs, setLogs] = useState<OrphanLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const limit = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/admin/orphan-dm-logs?${params}`);
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      setLogs(json.data);
      setTotal(json.pagination.total);
    } catch {
      setMessage("一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const saveReaction = async (
    id: string,
    status: ReactionStatus,
    reactedAt: string,
    note: string,
    clearNote: boolean,
  ) => {
    // note: 省略=変更なし / null=消す / 文字列=上書き(サーバ仕様と対・マスク値を往復させない)。
    const res = await fetch(`/api/admin/orphan-dm-logs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status,
        ...(reactedAt ? { reactedAt } : {}),
        ...(clearNote
          ? { note: null }
          : note.trim()
            ? { note: note.trim() }
            : {}),
      }),
    });
    if (res.ok) {
      setMessage("反響を保存しました");
      setEditingId(null);
      fetchLogs();
    } else {
      const body = await res.json().catch(() => null);
      setMessage(body?.error?.message ?? "保存に失敗しました");
    }
  };

  const deleteLog = async (id: string) => {
    // 孤児記録の取消は復元できないため必ず confirm を挟む
    if (!window.confirm("この送付記録を取り消します。よろしいですか?")) return;
    const res = await fetch(`/api/admin/orphan-dm-logs/${id}`, { method: "DELETE" });
    if (res.ok) {
      setMessage("記録を取り消しました");
      fetchLogs();
    } else {
      const body = await res.json().catch(() => null);
      setMessage(body?.error?.message ?? "取消に失敗しました");
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    // 所有者名(PII)を表示するため画面保護の対象にする(コピー・右クリック・印刷ガード=#366 R9)
    <div
      data-pii-protected
      data-pii-surface="owner"
      className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6"
    >
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-300">管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">孤児DM記録の訂正</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">孤児DM記録の訂正</h1>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        物件を削除しても、DMの送付記録は所有者に引き継がれます(拒否・宛先不明の履歴を守るため)。
        ここでは物件ページから辿れなくなった記録の反響の訂正・記録の取消ができます。
        誤った「拒否・宛先不明」が残っていると、その所有者へのDMがずっと止まったままになります。
      </p>

      {message && (
        <div className="mb-4 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-500/10 px-4 py-2 text-sm text-blue-800 dark:text-blue-200">
          {message}
        </div>
      )}

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(searchInput);
        }}
      >
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="所有者名で検索"
          className="w-64 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          検索
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">投函日</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">宛先(所有者)</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">方法</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">反響</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800 bg-white dark:bg-gray-900">
                {logs.map((log) => (
                  <OrphanRow
                    key={log.id}
                    log={log}
                    editing={editingId === log.id}
                    onEdit={() => setEditingId(log.id)}
                    onCancel={() => setEditingId(null)}
                    onSave={saveReaction}
                    onDelete={deleteLog}
                  />
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                      孤児になった送付記録はありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">全 {total} 件</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            前へ
          </button>
          <span className="flex items-center px-2 text-sm text-gray-500 dark:text-gray-400">
            {page} / {totalPages || 1}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}

/** 反響の編集フォーム。編集開始時にマウントされ、log の最新値で初期化される
 *  (行コンポーネントに state を持つと保存後の再取得が反映されない=#366 R3)。 */
function OrphanReactionEditor({
  log,
  onSave,
  onCancel,
}: {
  log: OrphanLog;
  onSave: (
    status: ReactionStatus,
    reactedAt: string,
    note: string,
    clearNote: boolean,
  ) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<ReactionStatus>(
    (REACTION_STATUSES as readonly string[]).includes(log.reactionStatus)
      ? (log.reactionStatus as ReactionStatus)
      : "no_response",
  );
  const [reactedAt, setReactedAt] = useState(
    log.reactedAt ? log.reactedAt.slice(0, 10) : "",
  );
  // メモは常に空で開始(一覧の値はマスク済みのことがある=往復で実メモを潰さない・#366 R2)。
  // 未入力なら送らない=「省略=変更なし」。消すときは「メモを消す」を明示チェック(note:null)。
  const [note, setNote] = useState("");
  const [clearNote, setClearNote] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as ReactionStatus)}
        className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
      >
        {REACTION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {REACTION_LABELS[s]}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={reactedAt}
        onChange={(e) => setReactedAt(e.target.value)}
        className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
      />
      <input
        type="text"
        value={note}
        disabled={clearNote}
        onChange={(e) => setNote(e.target.value)}
        placeholder={log.reactionNote ? "メモあり(入力すると上書き)" : "メモ(任意)"}
        maxLength={500}
        className="w-40 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 disabled:opacity-50 dark:text-gray-100"
      />
      {log.reactionNote && (
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={clearNote}
            onChange={(e) => {
              setClearNote(e.target.checked);
              if (e.target.checked) setNote("");
            }}
          />
          メモを消す
        </label>
      )}
      <button
        type="button"
        onClick={() => onSave(status, reactedAt, note, clearNote)}
        className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
      >
        保存
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200"
      >
        やめる
      </button>
    </div>
  );
}

function OrphanRow({
  log,
  editing,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}: {
  log: OrphanLog;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (
    id: string,
    status: ReactionStatus,
    reactedAt: string,
    note: string,
    clearNote: boolean,
  ) => void;
  onDelete: (id: string) => void;
}) {
  const { data: authSession } = useSession();
  const isAdmin =
    (authSession?.user as { role?: string } | undefined)?.role === "admin";
  const names = [
    log.owner?.name ?? null,
    ...log.coOwners
      .filter((co) => co.id !== log.owner?.id)
      .map((co) => co.name),
  ].filter((n): n is string => n != null && n !== "");

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800 align-top">
      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono">
        {log.sentAt}
      </td>
      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
        {names.length > 0 ? names.join("、") : "(所有者情報なし)"}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {dmMethodLabel(log.method)}
      </td>
      <td className="px-4 py-3 text-sm">
        {editing ? (
          // 編集中だけマウント=開くたびに最新の log で初期化される(#366 R3)
          <OrphanReactionEditor
            log={log}
            onSave={(status, reactedAt, note, clearNote) =>
              onSave(log.id, status, reactedAt, note, clearNote)
            }
            onCancel={onCancel}
          />
        ) : (
          <span
            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
              REACTION_COLORS[log.reactionStatus] ?? REACTION_COLORS.no_response
            }`}
          >
            {REACTION_LABELS[log.reactionStatus as ReactionStatus] ?? log.reactionStatus}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm">
        {/* 拒否の変更・取消は管理者のみ(発注者指示 2026-08-17)。この画面の入口は
            権限ベースで admin 以外も通り得るため、サーバ403と対で施錠表示にする。 */}
        {!editing && log.reactionStatus === "refused" && !isAdmin && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            「拒否」の変更・取消は管理者のみです
          </span>
        )}
        {!editing && !(log.reactionStatus === "refused" && !isAdmin) && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              反響を訂正
            </button>
            <button
              type="button"
              onClick={() => onDelete(log.id)}
              className="rounded-md border border-red-300 dark:border-red-800 px-3 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              記録を取消
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
