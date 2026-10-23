"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { SearchField } from "@/components/ui/search-field";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { formatJaDateTime } from "@/lib/format-datetime";
import {
  Plus,
  Loader2,
  Shield,
  UserCheck,
  UserX,
  KeyRound,
  LockOpen,
  ChevronRight,
  Pencil,
  Mail,
} from "lucide-react";
import StatusBadge, { USER_ROLE_INTENT } from "@/components/ui/status-badge";
import { ROLE_LABELS } from "@/lib/role-labels";
import { InquiryNotifyDialog } from "@/components/admin/inquiry-notify-dialog";
import { apiErrorMessage } from "@/lib/admin-user-rules";

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

export default function UsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [actionUser, setActionUser] = useState<UserItem | null>(null);
  const [actionType, setActionType] = useState<
    "deactivate" | "activate" | "resetPw" | "unlock" | null
  >(null);
  const [notifyUser, setNotifyUser] = useState<UserItem | null>(null);
  const [editUser, setEditUser] = useState<UserItem | null>(null);
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
    // 失敗の理由は読み切れるよう長めに出す
    setTimeout(() => setMessage(null), type === "err" ? 8000 : 3000);
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
          const e = await res.json().catch(() => null);
          throw new Error(apiErrorMessage(e, actionType === "activate" ? "有効化に失敗しました" : "無効化に失敗しました"));
        }
        flash("ok", actionType === "activate" ? "有効化しました" : "無効化しました");
      } else if (actionType === "unlock") {
        const res = await fetch(`/api/admin/users/${actionUser.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unlock: true }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => null);
          throw new Error(apiErrorMessage(e, "ロック解除に失敗しました"));
        }
        flash("ok", "ロック解除しました");
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
        if (!res.ok) {
          const e = await res.json().catch(() => null);
          throw new Error(apiErrorMessage(e, "パスワードのリセットに失敗しました"));
        }
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
      <PageHeader
        title="ユーザー管理"
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            新規ユーザー作成
          </Button>
        }
      />

      {message && (
        <div
          className={`mb-4 rounded-md border p-3 text-sm ${message.type === "ok" ? "border-green-200 bg-green-50 text-green-700 dark:bg-green-500/15 dark:border-green-500/30 dark:text-green-300" : "border-red-200 bg-red-50 text-red-700 dark:bg-red-500/15 dark:border-red-500/30 dark:text-red-300"}`}
        >
          {message.text}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        {/* 第2弾②: 検索窓は SearchField(左端・最初) */}
        <SearchField
          className="flex-1"
          width="full"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="名前・メールで検索..."
        />
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
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
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
                        ? formatJaDateTime(u.lastLoginAt)
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
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditUser(u)}
                          className="text-gray-600 dark:text-gray-300"
                          title="編集"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span className="text-xs">編集</span>
                        </Button>
                        <Link
                          href={`/admin/users/${u.id}/permissions`}
                          className="flex items-center gap-0.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                          title="権限編集"
                        >
                          <Shield className="h-3.5 w-3.5" />
                          <span className="text-xs">権限</span>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setNotifyUser(u)}
                          className="text-gray-600 dark:text-gray-300"
                          title="査定申込の通知設定"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          <span className="text-xs">通知</span>
                        </Button>
                        {u.isActive ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setActionUser(u);
                              setActionType("deactivate");
                            }}
                            className="text-amber-600 dark:text-amber-400"
                            title="無効化"
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span className="text-xs">無効化</span>
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setActionUser(u);
                              setActionType("activate");
                            }}
                            className="text-emerald-600 dark:text-emerald-400"
                            title="有効化"
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                            <span className="text-xs">有効化</span>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setActionUser(u);
                            setActionType("resetPw");
                          }}
                          className="text-gray-600 dark:text-gray-300"
                          title="パスワードリセット"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          <span className="text-xs">PW</span>
                        </Button>
                        {isLocked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setActionUser(u);
                              setActionType("unlock");
                            }}
                            className="text-red-600 dark:text-red-400"
                            title="ロック解除"
                          >
                            <LockOpen className="h-3.5 w-3.5" />
                            <span className="text-xs">解除</span>
                          </Button>
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
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setActionUser(null);
                  setActionType(null);
                }}
              >
                キャンセル
              </Button>
              <Button
                variant={actionType === "deactivate" ? "danger" : "primary"}
                onClick={handleAction}
              >
                実行
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create user modal */}
      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={(text) => {
            setShowCreate(false);
            flash("ok", text);
            load();
          }}
        />
      )}

      {/* Edit user modal(名前・メール・役割) */}
      {editUser && (
        <EditUserModal
          user={editUser}
          isSelf={selfId === editUser.id}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null);
            flash("ok", "ユーザーを更新しました");
            load();
          }}
        />
      )}

      {/* 通知設定ダイアログ */}
      {notifyUser && (
        <InquiryNotifyDialog
          userId={notifyUser.id}
          userName={notifyUser.name}
          onClose={() => setNotifyUser(null)}
          onSaved={() => flash("ok", "通知設定を保存しました")}
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
  onCreated: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "field_staff",
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 無効にした人と同じメールだったとき、その人(有効に戻す相手)
  // email=見つけたときに入っていたメール(欄を変えたら別の人の可能性があるので忘れる・@codex #554 P2)
  const [inactive, setInactive] = useState<{ id: string; name: string; email: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setInactive(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.error?.code === "INACTIVE_USER_EXISTS" && data.error.user) {
          setInactive({ ...data.error.user, email: form.email.trim() });
        }
        throw new Error(apiErrorMessage(data, "作成に失敗しました"));
      }
      onCreated("ユーザーを作成しました");
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラー");
    } finally {
      setSaving(false);
    }
  };

  // 無効にした人を、いま入力した名前・ロール・初期パスワードで有効に戻す(過去の記録もつながったまま)
  const handleReactivate = async () => {
    if (!inactive) return;
    if (form.email.trim() !== inactive.email) {
      // 念のため(欄を変えると setField で忘れる)。違う人を戻さない
      setInactive(null);
      setError("メールアドレスが変わったため、もう一度「作成」を押してください");
      return;
    }
    if (form.name.trim() === "" || form.password.length < 8) {
      setError("名前と初期パスワード(8文字以上)を入れてから押してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${inactive.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // 有効化と初期パスワードは1回の書き込み(古いパスワードで入れる間を作らない)
        body: JSON.stringify({ isActive: true, name: form.name, role: form.role, newPassword: form.password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(data, "有効に戻せませんでした"));
      }
      onCreated(`「${form.name.trim()}」を有効に戻しました(初回ログインでパスワードの変更を求められます)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラー");
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string) => {
    // メールを変えたら、さっき見つけた「無効にした人」とは別の人かもしれない=有効に戻すボタンを消す
    if (key === "email") setInactive(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-bold text-gray-800 dark:text-gray-100">
          新規ユーザー作成
        </h3>
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
            {error}
            {inactive && (
              <div className="mt-2">
                <p className="mb-2 text-xs text-gray-600 dark:text-gray-300">
                  有効に戻すと、いま入力した名前・ロール・初期パスワードになります。これまでの記録はそのままつながります。
                </p>
                <Button size="sm" onClick={handleReactivate} disabled={saving} loading={saving} loadingLabel="戻しています">
                  「{inactive.name}」を有効に戻す
                </Button>
              </div>
            )}
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
            <Button variant="secondary" onClick={onClose}>
              キャンセル
            </Button>
            <Button
              type="submit"
              disabled={saving}
              loading={saving}
              loadingLabel="作成中"
            >
              作成
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Edit user modal(名前・メール・ロール)
// 2026-10-23: 削除の代わりに、打ち間違い・役割の変更をここで直す。
// ============================================================

function EditUserModal({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: UserItem;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    role: user.role,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(data, "保存に失敗しました"));
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラー");
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const inputClass =
    "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-bold text-gray-800 dark:text-gray-100">
          ユーザーを編集
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
              className={inputClass}
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
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              変えると、次からは新しいメールアドレスでログインします
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              ロール <span className="text-red-500">*</span>
            </label>
            <select
              value={form.role}
              onChange={(e) => setField("role", e.target.value)}
              disabled={isSelf}
              className={inputClass}
            >
              <option value="field_staff">現地担当</option>
              <option value="office_staff">事務担当</option>
              <option value="admin">管理者</option>
            </select>
            {isSelf && (
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                自分のロールは変えられません（ほかの管理者に頼んでください）
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>
              キャンセル
            </Button>
            <Button
              type="submit"
              disabled={saving}
              loading={saving}
              loadingLabel="保存中"
            >
              保存
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
