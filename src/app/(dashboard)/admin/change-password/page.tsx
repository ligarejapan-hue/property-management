"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2, KeyRound } from "lucide-react";

export default function ChangePasswordPage() {
  const [form, setForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const setField = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (form.newPassword.length < 8) {
      setError("新しいパスワードは8文字以上で入力してください");
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      setError("新しいパスワードと確認用が一致しません");
      return;
    }
    if (form.currentPassword === form.newPassword) {
      setError("現在のパスワードと同じものは指定できません");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/me/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? "変更に失敗しました");
      }
      setSuccess(true);
      // Force re-login: destroy session and redirect to /login
      setTimeout(() => {
        signOut({ callbackUrl: "/login" });
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setSaving(false);
    }
  };

  if (success) {
    return (
      <div className="mx-auto max-w-md">
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
          <h2 className="mb-2 text-lg font-bold text-green-800">
            パスワードを変更しました
          </h2>
          <p className="text-sm text-green-700">
            再ログインが必要です。ログイン画面に移動します...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6 flex items-center gap-2">
        <KeyRound className="h-6 w-6 text-gray-700" />
        <h2 className="text-2xl font-bold text-gray-800">パスワード変更</h2>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              現在のパスワード <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(e) => setField("currentPassword", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              新しいパスワード <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(e) => setField("newPassword", e.target.value)}
              placeholder="8文字以上"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              新しいパスワード（確認） <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={(e) => setField("confirmPassword", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <p className="text-xs text-gray-500">
            変更後は再ログインが必要になります。
          </p>
          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              変更する
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
