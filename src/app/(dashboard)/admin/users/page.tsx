"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Search,
  Plus,
  Loader2,
  Shield,
  UserCheck,
  UserX,
  KeyRound,
  LockOpen,
  ChevronRight,
  Trash2,
} from "lucide-react";
import StatusBadge, { USER_ROLE_INTENT } from "@/components/ui/status-badge";

interface UserItem {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  loginFailedCount: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  createdAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  office_staff: "事務担当",
  field_staff: "現地担当",
};

export default function UsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [actionUser, setActionUser] = useState<UserItem | null>(null);
  const [actionType, setActionType] = useState<
    "deactivate" | "activate" | "resetPw" | "unlock" | "delete" | null
  >(null);
  const { data: sessionData } = useSession();
  const selfId = (sessionData?.user as { id?: string } | undefined)?.id ?? null;
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (search.length >= 2) qs.set("q", search);
      if (showInactive) qs.set("includeInactive", "true");
      const res = await fetch(`/api/admin/users?${qs}`);
      const json = await res.json();
      setUsers(json.data ?? []);
    } catch {
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [search, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (type: "ok" | "err", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  // ---- action handlers ----
  const handleAction = async () => {
    if (!actionUser || !actionType) return;
    try {
      if (actionType === "deactivate" || actionType === "activate") {
        const res = await fetch(`/api/admin/users/${actionUser.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            isActive: actionType === "activate",
          }),
        });
        if (!res.ok) {
          const e = await res.json();
          throw new Error(e.message ?? "失敗");
        }
        flash("ok", actionType === "activate" ? "有効化しました" : "無効化しました");
      } else if (actionType === "unlock") {
        const res = await fetch(`/api/admin/users/${actionUser.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unlock: true }),
        });
        if (!res.ok) throw new Error("失敗");
        flash("ok", "ロック解除しました");
      } else if (actionType === "delete") {
        const res = await fetch(`/api/admin/users/${actionUser.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.message ?? "削除に失敗しました");
        }
        flash("ok", "ユーザーを削除しました");
      } else if (actionType === "resetPw") {
        const pw = prompt("新しいパスワードを入力 (8文字以上):");
        if (!pw || pw.length < 8) {
          flash("err", "パスワードは8文字以上です");
          setActionUser(null);
          setActionType(null);
          return;
        }
        const res = await fetch(
          `/api/admin/users/${actionUser.id}/reset-password`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newPassword: pw }),
          },
        );
        if (!res.ok) throw new Error("失敗");
        flash("ok", "パスワードをリセットしました");
      }
      setActionUser(null);
      setActionType(null);
      load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "エラーが発生しました");
      setActionUser(null);
      setActionType(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">ユーザー管理</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          新規ユーザー作成
        </button>
      </div>

      {message && (
        <div
          className={`mb-4 rounded-md border p-3 text-sm ${message.type === "ok" ? "border-green-200 bg-green-50 text-green-700 dark:bg-green-500/15 dark:border-green-500/30 dark:text-green-300" : "border-red-200 bg-red-50 text-red-700 dark:bg-red-500/15 dark:border-red-500/30 dark:text-red-300"}`}
        >
          {message.text}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="名前・メールで検索..."
            className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-700"
          />
          無効ユーザーも表示
        </label>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  名前
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  メール
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  ロール
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  最終ログイン
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  状態
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {users.map((u) => {
                const isLocked =
                  u.lockedUntil && new Date(u.lockedUntil) > new Date();
                return (
                  <tr
                    key={u.id}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${!u.isActive ? "opacity-50" : ""}`}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {u.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {u.email}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <StatusBadge intent={USER_ROLE_INTENT[u.role] ?? "neutral"}>
                        {ROLE_LABELS[u.role] ?? u.role}
                      </StatusBadge>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {u.lastLoginAt
                        ? new Date(u.lastLoginAt).toLocaleString("ja-JP")
                        : "-"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <div className="flex items-center gap-1.5">
                        {u.isActive ? (
                          <StatusBadge intent="success">有効</StatusBadge>
                        ) : (
                          <StatusBadge intent="neutral">無効</StatusBadge>
                        )}
                        {isLocked && (
                          <StatusBadge intent="error">ロック中</StatusBadge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/admin/users/${u.id}/permissions`}
                          className="flex items-center gap-0.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                          title="権限編集"
                        >
                          <Shield className="h-3.5 w-3.5" />
                          <span className="text-xs">権限</span>
                        </Link>
                        {u.isActive ? (
                          <button
                            onClick={() => {
                              setActionUser(u);
                              setActionType("deactivate");
                            }}
                            className="flex items-center gap-0.5 text-amber-600 hover:text-amber-800"
                            title="無効化"
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span className="text-xs">無効化</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setActionUser(u);
                              setActionType("activate");
                            }}
                            className="flex items-center gap-0.5 text-emerald-600 hover:text-emerald-800"
                            title="有効化"
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                            <span className="text-xs">有効化</span>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setActionUser(u);
                            setActionType("resetPw");
                          }}
                          className="flex items-center gap-0.5 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
                          title="パスワードリセット"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          <span className="text-xs">PW</span>
                        </button>
                        {isLocked && (
                          <button
                            onClick={() => {
                              setActionUser(u);
                              setActionType("unlock");
                            }}
                            className="flex items-center gap-0.5 text-red-600 hover:text-red-800"
                            title="ロック解除"
                          >
                            <LockOpen className="h-3.5 w-3.5" />
                            <span className="text-xs">解除</span>
                          </button>
                        )}
                        {selfId === u.id ? (
                          <span
                            className="flex items-center gap-0.5 text-gray-300 dark:text-gray-600"
                            title="自分自身は削除できません"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="text-xs">削除不可</span>
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              setActionUser(u);
                              setActionType("delete");
                            }}
                            className="flex items-center gap-0.5 text-red-600 hover:text-red-800"
                            title="削除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="text-xs">削除</span>
                          </button>
                        )}
                        <Link
                          href={`/admin/users/${u.id}/permissions`}
                          className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-12 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    ユーザーが見つかりません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirm dialog */}
      {actionUser && actionType && actionType !== "resetPw" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900">
            <h3 className="mb-2 text-lg font-bold text-gray-800 dark:text-gray-100">確認</h3>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
              {actionType === "deactivate" &&
                `${actionUser.name} を無効化しますか？ログインできなくなります。`}
              {actionType === "activate" &&
                `${actionUser.name} を有効化しますか？`}
              {actionType === "unlock" &&
                `${actionUser.name} のアカウントロックを解除しますか？`}
              {actionType === "delete" &&
                `${actionUser.name} を削除しますか？この操作は取り消せません。参照中のデータがある場合は削除できません。`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setActionUser(null);
                  setActionType(null);
                }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                キャンセル
              </button>
              <button
                onClick={handleAction}
                className={`rounded-md px-4 py-2 text-sm font-medium text-white ${
                  actionType === "delete"
                    ? "bg-red-600 hover:bg-red-700"
                    : actionType === "deactivate"
                      ? "bg-amber-600 hover:bg-amber-700"
                      : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                実行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create user modal */}
      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            flash("ok", "ユーザーを作成しました");
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Create user modal
// ============================================================

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "field_staff",
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? "作成に失敗しました");
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラー");
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-bold text-gray-800 dark:text-gray-100">
          新規ユーザー作成
        </h3>
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              名前 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              メールアドレス <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setField("email", e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              ロール <span className="text-red-500">*</span>
            </label>
            <select
              value={form.role}
              onChange={(e) => setField("role", e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="field_staff">現地担当</option>
              <option value="office_staff">事務担当</option>
              <option value="admin">管理者</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              初期パスワード <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setField("password", e.target.value)}
              placeholder="8文字以上"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              初回ログイン時にパスワード変更を要求されます
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              作成
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
