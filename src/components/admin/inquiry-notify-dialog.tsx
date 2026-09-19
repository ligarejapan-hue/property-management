"use client";

/**
 * 査定申込の通知メール(利用者ごと)の設定ダイアログ。
 *
 * 管理者が「この人は通知を受け取る」+ 宛先(空欄=ログインの email)を設定する。
 * 売却DMを使う権限が無い利用者は enabled=true でも実際には通知が届かない
 * (src/lib/sale-dm-letter/inquiry-notify.ts の宛先絞り込みと同じ条件)ため、
 * その旨をここで警告する。
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { getUserInquiryNotify, updateUserInquiryNotify } from "@/lib/api-client";

export interface InquiryNotifyDialogProps {
  userId: string;
  userName: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function InquiryNotifyDialog({
  userId,
  userName,
  onClose,
  onSaved,
}: InquiryNotifyDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [canUseSaleDm, setCanUseSaleDm] = useState(true);
  // 初回読み込みが一度でも成功したか。⚠これが false の間は保存を必ず止める
  // (読み込み失敗のまま既定値 enabled=false・email="" で保存すると、
  //  その利用者の通知を無言で無効化し、宛先も空にしてしまうため)。
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getUserInquiryNotify(userId);
      setEnabled(res.data.enabled);
      setEmail(res.data.email ?? "");
      setLoginEmail(res.data.loginEmail);
      setCanUseSaleDm(res.data.canUseSaleDm);
      setLoaded(true);
    } catch (err) {
      setLoaded(false);
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await updateUserInquiryNotify(userId, {
        enabled,
        email: email.trim(),
      });
      setCanUseSaleDm(res.data.canUseSaleDm);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      size="sm"
      title={`${userName} の通知設定`}
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving || loading || !loaded}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400 dark:text-gray-500" />
        </div>
      ) : (
        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300">
              <p>{error}</p>
              {!loaded && (
                <>
                  <p className="mt-1">設定を読み込めませんでした。再読み込みしてください。保存は行えません。</p>
                  <button
                    type="button"
                    onClick={load}
                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-950"
                  >
                    再読み込み
                  </button>
                </>
              )}
            </div>
          )}
          {!canUseSaleDm && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
              売却DMを使える権限がないため、この人には通知が届きません
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-700"
            />
            査定申込の通知メールを受け取る
          </label>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              通知先メールアドレス(空欄=ログインのメールアドレスに送る)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={loginEmail}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </div>
        </div>
      )}
    </ModalShell>
  );
}
