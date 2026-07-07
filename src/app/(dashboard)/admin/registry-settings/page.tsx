"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, ShieldAlert } from "lucide-react";
import {
  fetchRegistrySettings,
  updateRegistrySettings,
  type RegistrySettings,
} from "@/lib/api-client";

// 謄本取得の資格情報(登記情報提供サービス・管理者のみ)。利用者識別番号/パスワードは
// 「設定済/未設定」のみ表示し、値は決して表示しない。保存は暗号化(サーバーのマスターキー)前提。
// 未設定だと資格情報の保存は 503。実際の自動取得はフェーズ3(利用約款の確認後)で有効化する。
export default function RegistrySettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [s, setS] = useState<RegistrySettings | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [clearLoginId, setClearLoginId] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);

  const applySettings = (data: RegistrySettings) => {
    setS(data);
    setBaseUrl(data.baseUrl ?? "");
    setLoginId("");
    setPassword("");
    setClearLoginId(false);
    setClearPassword(false);
  };

  useEffect(() => {
    (async () => {
      try {
        applySettings(await fetchRegistrySettings());
      } catch (e) {
        setMessage({ kind: "err", text: e instanceof Error ? e.message : "設定の取得に失敗しました" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const body: Parameters<typeof updateRegistrySettings>[0] = { baseUrl };
      // 資格情報は「クリア指定なら空文字」「入力があればその値をそのまま(trim しない=前後空白を保持)」
      // 「どちらも無ければ送らない=現状維持」。値の trim は正当な資格情報を壊し得る(@codex 指摘対応)。
      if (clearLoginId) body.loginId = "";
      else if (loginId !== "") body.loginId = loginId;
      if (clearPassword) body.password = "";
      else if (password !== "") body.password = password;

      await updateRegistrySettings(body);
      applySettings(await fetchRegistrySettings());
      setMessage({ kind: "ok", text: "設定を保存しました" });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "保存に失敗しました" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
    );
  }

  const secretStatus = (has: boolean, cleared: boolean, typed: string) =>
    cleared ? "クリアして保存" : typed.trim() !== "" ? "新しい値を保存" : has ? "設定済み" : "未設定";

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">謄本取得の資格情報</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          登記情報提供サービスのログイン情報(利用者識別番号・パスワード)を設定します。値は暗号化して保存され、画面には表示されません(設定済/未設定のみ)。実際の自動取得はフェーズ3(利用約款の確認後)で有効化されます。
        </p>
      </div>

      {!s?.encryptionConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300" role="alert">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>暗号化キー(サーバーの内部設定 REGISTRY_SETTINGS_ENC_KEY)が未設定のため、資格情報は保存できません。サーバー管理者に設定を依頼してください(ベースURLは保存できます)。</span>
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">
          {message.text}
        </p>
      )}

      <div className="space-y-4">
        <SecretField
          label="利用者識別番号(ログインID)"
          status={secretStatus(!!s?.hasLoginId, clearLoginId, loginId)}
          value={loginId}
          onChange={(v) => { setLoginId(v); if (v) setClearLoginId(false); }}
          hasExisting={!!s?.hasLoginId}
          cleared={clearLoginId}
          onClear={() => { setClearLoginId((c) => !c); setLoginId(""); }}
          disabled={!s?.encryptionConfigured}
        />
        <SecretField
          label="パスワード"
          status={secretStatus(!!s?.hasPassword, clearPassword, password)}
          value={password}
          onChange={(v) => { setPassword(v); if (v) setClearPassword(false); }}
          hasExisting={!!s?.hasPassword}
          cleared={clearPassword}
          onClear={() => { setClearPassword((c) => !c); setPassword(""); }}
          disabled={!s?.encryptionConfigured}
        />
        <Field label="ベースURL(任意・空欄で既定)">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="例: https://www1.touki.or.jp" maxLength={500} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
      </div>

      <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        保存
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function SecretField({
  label, status, value, onChange, hasExisting, cleared, onClear, disabled,
}: {
  label: string; status: string; value: string; onChange: (v: string) => void;
  hasExisting: boolean; cleared: boolean; onClear: () => void; disabled: boolean;
}) {
  return (
    <div className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <span className="text-[11px] text-gray-400">{status}</span>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        disabled={disabled}
        autoComplete="off"
        placeholder={hasExisting ? "設定済み(変更する場合のみ入力)" : "未設定(入力して保存)"}
        maxLength={500}
        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      />
      {hasExisting && (
        <button type="button" onClick={onClear} className="mt-1 text-[11px] text-red-500 hover:underline">
          {cleared ? "クリアを取り消す" : "保存済みの値をクリアする"}
        </button>
      )}
    </div>
  );
}
