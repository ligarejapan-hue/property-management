"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import {
  fetchCompanySettings,
  updateCompanySettings,
  type CompanyProfileSettings,
} from "@/lib/api-client";

const inputCls =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

// 会社情報(会社帯・管理者のみ)。販売図面(マイソク)の下部に表示される自社情報。
// 空欄の項目は既定値(サーバー内蔵)が使われる。値は非秘匿・平文で保存される。
export default function CompanySettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [nameJa, setNameJa] = useState("");
  const [license, setLicense] = useState("");
  const [tel, setTel] = useState("");
  const [fax, setFax] = useState("");
  const [email, setEmail] = useState("");
  const [hp, setHp] = useState("");
  const [address, setAddress] = useState("");

  const applySettings = (d: CompanyProfileSettings) => {
    setNameJa(d.nameJa ?? "");
    setLicense(d.license ?? "");
    setTel(d.tel ?? "");
    setFax(d.fax ?? "");
    setEmail(d.email ?? "");
    setHp(d.hp ?? "");
    setAddress(d.address ?? "");
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchCompanySettings();
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
      const res = await updateCompanySettings({ nameJa, license, tel, fax, email, hp, address });
      applySettings(res.data);
      setMessage({ kind: "ok", text: "会社情報を保存しました" });
    } catch (e) {
      setMessage({
        kind: "err",
        text: e instanceof Error ? e.message : "保存に失敗しました(会社情報の編集は管理者のみ可能です)",
      });
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

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">会社情報</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          販売図面(マイソク)の下部に表示される自社情報です。空欄の項目は初期値が使われます。
        </p>
      </div>

      {message && (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
          role="alert"
        >
          {message.text}
        </p>
      )}

      <div className="space-y-4">
        <Field label="会社名" hint="長すぎると図面上で切れる場合があります">
          <input value={nameJa} onChange={(e) => setNameJa(e.target.value)} maxLength={200} aria-label="会社名" className={inputCls} />
        </Field>
        <Field label="宅建免許番号">
          <input value={license} onChange={(e) => setLicense(e.target.value)} maxLength={200} aria-label="宅建免許番号" className={inputCls} />
        </Field>
        <Field label="電話番号">
          <input value={tel} onChange={(e) => setTel(e.target.value)} maxLength={50} aria-label="電話番号" className={inputCls} />
        </Field>
        <Field label="FAX番号">
          <input value={fax} onChange={(e) => setFax(e.target.value)} maxLength={50} aria-label="FAX番号" className={inputCls} />
        </Field>
        <Field label="メールアドレス">
          <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} aria-label="メールアドレス" className={inputCls} />
        </Field>
        <Field label="ホームページURL">
          <input value={hp} onChange={(e) => setHp(e.target.value)} maxLength={2000} aria-label="ホームページURL" className={inputCls} />
        </Field>
        <Field label="所在地" hint="郵便番号＋住所">
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} aria-label="所在地" className={inputCls} />
        </Field>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        保存
      </button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {hint && <span className="ml-1 font-normal text-gray-400">（{hint}）</span>}
      </span>
      {children}
    </label>
  );
}
