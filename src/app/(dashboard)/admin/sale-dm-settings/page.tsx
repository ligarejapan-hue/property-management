"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  isSaleDmPrintReady,
  missingSaleDmPrintRequirements,
} from "@/lib/sale-dm-letter/print-ready";
import {
  fetchSaleDmSettings,
  updateSaleDmSettings,
  type SaleDmSettings,
} from "@/lib/api-client";

// 売却促進DM の設定(管理者のみ)。APIキーは「設定済/未設定」のみ表示し、値は決して表示しない。
// 値の保存は暗号化(サーバーのマスターキー)前提。未設定だと APIキー保存は 503。
export default function SaleDmSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [s, setS] = useState<SaleDmSettings | null>(null);

  // 編集用 state(非秘匿は現在値で初期化・キーは入力欄=新規値のみ)。
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [trackingBaseUrl, setTrackingBaseUrl] = useState("");
  const [lpUrl, setLpUrl] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderContact, setSenderContact] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [clearAnthropic, setClearAnthropic] = useState(false);
  const [clearOpenai, setClearOpenai] = useState(false);

  const applySettings = (data: SaleDmSettings) => {
    setS(data);
    setProvider(data.provider ?? "");
    setModel(data.model ?? "");
    setTrackingBaseUrl(data.trackingBaseUrl ?? "");
    setLpUrl(data.lpUrl ?? "");
    setSenderName(data.senderName ?? "");
    setSenderContact(data.senderContact ?? "");
    setAnthropicKey("");
    setOpenaiKey("");
    setClearAnthropic(false);
    setClearOpenai(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchSaleDmSettings();
        applySettings(res.data);
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
      const body: Parameters<typeof updateSaleDmSettings>[0] = {
        provider: provider === "" ? null : provider,
        model,
        trackingBaseUrl,
        lpUrl,
        senderName,
        senderContact,
      };
      // APIキーは「クリア指定なら空文字」「新規入力があればその値」「どちらも無ければ送らない=現状維持」。
      if (clearAnthropic) body.anthropicApiKey = "";
      else if (anthropicKey.trim() !== "") body.anthropicApiKey = anthropicKey.trim();
      if (clearOpenai) body.openaiApiKey = "";
      else if (openaiKey.trim() !== "") body.openaiApiKey = openaiKey.trim();

      const res = await updateSaleDmSettings(body);
      applySettings(res.data);
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

  const keyStatus = (has: boolean, cleared: boolean, typed: string) =>
    cleared ? "クリアして保存" : typed.trim() !== "" ? "新しいキーを保存" : has ? "設定済み" : "未設定";

  // この設定で売却DMが「使える」状態かどうか。
  // ⚠判定は**サーバーと同じ純関数**を使う（print-ready.ts）。以前はここに条件を書き写して
  //   いたため、AI直結の生成を廃止したあとも画面だけが「AI種別＋APIキー」を要求し続け、
  //   **使えるのに「使えません」**と表示していた（不要な有料API契約に進みかねない）。
  const printReadyInput = { trackingBaseUrl, lpUrl, senderName, senderContact };
  const enabledHint = isSaleDmPrintReady(printReadyInput);
  const missingRequirements = missingSaleDmPrintRequirements(printReadyInput);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">売却促進DM 設定</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          売却DMの追跡URL・既定LP URL・差出人を設定します。⚠**AIの種類とAPIキーは現在の運用では使いません**(文面はお手元のAIで作る方式に変わりました)。
        </p>
      </div>

      {!s?.encryptionConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300" role="alert">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>暗号化キー(サーバーの内部設定)が未設定のため、APIキーは保存できません。サーバー管理者に設定を依頼してください(その他の項目は保存できます)。</span>
        </div>
      )}

      <div className={`flex items-center gap-2 rounded-md border p-3 text-xs ${enabledHint ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"}`}>
        {enabledHint ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        {enabledHint
          ? "売却DMを使う設定が揃っています(利用者には「物件情報の編集」権限が必要です)。"
          : `売却DMを使うには次の設定が必要です: ${missingRequirements.join(" / ")}。⚠URLは http(s) から始まる絶対URLで入力してください。`}
      </div>

      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">
          {message.text}
        </p>
      )}

      <div className="space-y-4">
        {/* ⚠欄自体を消すかは別判断。残す以上「埋めなくてよい」と分かる必要がある
            （分からないと不要な有料API契約に進みかねない＝この画面の誤表示の実害）。 */}
        <p className="rounded-md border border-gray-300 bg-gray-50 p-2 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          ⚠下の「AIの種類」と「APIキー」は<strong>現在の運用では使いません</strong>（空のままで構いません）。
          手紙の文面はお手元のブラウザのAIで作り、貼り付ける方式です。
        </p>
        <Field label="AIの種類(プロバイダ)">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="AIの種類" className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
            <option value="">未設定(サーバー既定に従う)</option>
            <option value="off">停止(生成しない)</option>
            <option value="claude">Claude(Anthropic)</option>
            <option value="openai">ChatGPT(OpenAI)</option>
            <option value="mock">mock(動作確認用)</option>
          </select>
        </Field>

        <KeyField
          label="Anthropic(Claude) APIキー"
          status={keyStatus(!!s?.hasAnthropicKey, clearAnthropic, anthropicKey)}
          value={anthropicKey}
          onChange={(v) => { setAnthropicKey(v); if (v) setClearAnthropic(false); }}
          hasExisting={!!s?.hasAnthropicKey}
          cleared={clearAnthropic}
          onClear={() => { setClearAnthropic((c) => !c); setAnthropicKey(""); }}
          disabled={!s?.encryptionConfigured}
        />
        <KeyField
          label="OpenAI(ChatGPT) APIキー"
          status={keyStatus(!!s?.hasOpenaiKey, clearOpenai, openaiKey)}
          value={openaiKey}
          onChange={(v) => { setOpenaiKey(v); if (v) setClearOpenai(false); }}
          hasExisting={!!s?.hasOpenaiKey}
          cleared={clearOpenai}
          onClear={() => { setClearOpenai((c) => !c); setOpenaiKey(""); }}
          disabled={!s?.encryptionConfigured}
        />

        <Field label="生成モデル(任意・空欄で既定)">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例: gpt-4o / claude-sonnet-4-6" maxLength={100} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="追跡用URL(このシステムの絶対URL)">
          <input value={trackingBaseUrl} onChange={(e) => setTrackingBaseUrl(e.target.value)} placeholder="例: https://app.example.com" maxLength={2000} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="既定LP URL(QRの遷移先・型ごとLP未設定時のフォールバック)">
          <input value={lpUrl} onChange={(e) => setLpUrl(e.target.value)} placeholder="例: https://lp.example.com" maxLength={2000} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="差出人名">
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="例: 株式会社○○不動産" maxLength={100} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </Field>
        <Field label="差出人連絡先">
          <input value={senderContact} onChange={(e) => setSenderContact(e.target.value)} placeholder="例: 03-0000-0000" maxLength={200} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
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

function KeyField({
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
        placeholder={hasExisting ? "設定済み(変更する場合のみ入力)" : "未設定(キーを入力)"}
        maxLength={500}
        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      />
      {hasExisting && (
        <button type="button" onClick={onClear} className="mt-1 text-[11px] text-red-500 hover:underline">
          {cleared ? "クリアを取り消す" : "保存済みのキーをクリアする"}
        </button>
      )}
    </div>
  );
}
