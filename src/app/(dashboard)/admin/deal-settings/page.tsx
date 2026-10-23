"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, DealApiError, errorText, type RateTableView } from "@/lib/deals/client";
import type { DealSettingsView } from "@/lib/deals/settings";
import {
  BANK_ACCOUNT_TYPE_LABELS, BASE_PROPERTY_KINDS, BASE_PROPERTY_KIND_LABELS, type PropertyKindDef,
} from "@/lib/deals/constants";
import { RATE_TABLE_KIND_LABELS } from "@/lib/deals/rate-tables";

type Bank = DealSettingsView["bankAccount"];
const BANK_FIELDS: [Exclude<keyof Bank, "accountType">, string, number][] = [
  ["bankName", "銀行名", 100], ["branchName", "支店名", 100], ["accountNumber", "口座番号(7桁まで)", 7], ["accountHolder", "名義", 100],
];

/** 取引の設定(管理者だけ)。段1は代表者・口座・物件種別。税率・税額の表は見るだけ(編集は段2)。 */
export default function DealSettingsPage() {
  const [settings, setSettings] = useState<DealSettingsView | null>(null);
  const [tables, setTables] = useState<RateTableView[]>([]);
  const [title, setTitle] = useState("");
  const [repName, setRepName] = useState("");
  const [bank, setBank] = useState<Record<keyof Bank, string>>({ bankName: "", branchName: "", accountType: "", accountNumber: "", accountHolder: "" });
  const [kinds, setKinds] = useState<PropertyKindDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = (s: DealSettingsView) => {
    setSettings(s);
    setTitle(s.representativeTitle ?? "");
    setRepName(s.representativeName ?? "");
    setBank({
      bankName: s.bankAccount.bankName ?? "", branchName: s.bankAccount.branchName ?? "", accountType: s.bankAccount.accountType ?? "",
      accountNumber: s.bankAccount.accountNumber ?? "", accountHolder: s.bankAccount.accountHolder ?? "",
    });
    setKinds(s.propertyKinds);
  };

  useEffect(() => {
    dealsApi.getSettings().then((r) => apply(r.settings)).catch((e) => setMessage({ kind: "err", text: errorText(e) }));
    dealsApi.rateTables().then((r) => setTables(r.tables)).catch(() => {});
  }, []);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await dealsApi.saveSettings({
        version: settings.version,
        representativeTitle: title,
        representativeName: repName,
        bankAccount: { ...bank, accountType: bank.accountType || null },
        propertyKinds: kinds,
      });
      apply(res.settings);
      setMessage({ kind: "ok", text: "取引の設定を保存しました" });
    } catch (e) {
      const text = e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "ほかの人が先に保存しました。画面を読み込み直してから、もう一度入力してください。"
        : errorText(e);
      setMessage({ kind: "err", text });
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return message ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{message.text}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }

  const setKind = (i: number, patch: Partial<PropertyKindDef>) => setKinds((ks) => ks.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="取引の設定"
        description={
          <>
            取引の書類に使う情報です。会社名・住所・電話・免許番号は
            <Link href="/admin/company-settings" className="mx-1 text-indigo-700 hover:underline dark:text-indigo-400">会社情報（販売図面の差出人）</Link>
            の値を使います。
          </>
        }
      />
      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">{message.text}</p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">代表者</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="肩書"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={50} aria-label="代表者の肩書" className={inputCls} /></Field>
          <Field label="氏名"><input value={repName} onChange={(e) => setRepName(e.target.value)} maxLength={100} aria-label="代表者の氏名" className={inputCls} /></Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">振込先口座</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {BANK_FIELDS.map(([k, label, max]) => (
            <Field key={k} label={label}>
              <input value={bank[k]} onChange={(e) => setBank((b) => ({ ...b, [k]: e.target.value }))} maxLength={max} aria-label={label} className={inputCls} />
            </Field>
          ))}
          <Field label="種別">
            <SelectBox label="口座の種別" value={bank.accountType} onChange={(v) => setBank((b) => ({ ...b, accountType: v }))} options={optionsOf(BANK_ACCOUNT_TYPE_LABELS)} allowEmpty />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">物件種別</h2>
        <p className="text-xs text-gray-500">足した種別は、書類の出し分けで「元の種別」と同じに扱います。基本の4つは消せません。</p>
        <ul className="space-y-2">
          {kinds.map((k, i) => {
            const isBase = (BASE_PROPERTY_KINDS as readonly string[]).includes(k.key);
            return (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label="鍵(英小文字・数字・_)">
                  <input value={k.key} disabled={isBase} onChange={(e) => setKind(i, { key: e.target.value })} maxLength={30} aria-label="種別の鍵" className={inputCls} />
                </Field>
                <Field label="名前"><input value={k.label} onChange={(e) => setKind(i, { label: e.target.value })} maxLength={30} aria-label="種別の名前" className={inputCls} /></Field>
                <Field label="元の種別">
                  <SelectBox label="元の種別" value={k.base} onChange={(v) => setKind(i, { base: v as PropertyKindDef["base"] })} options={optionsOf(BASE_PROPERTY_KIND_LABELS)} />
                </Field>
                {isBase ? <span /> : (
                  <Button variant="ghost" size="sm" onClick={() => setKinds((ks) => ks.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                    消す
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <Button variant="secondary" size="sm" onClick={() => setKinds((ks) => [...ks, { key: "", label: "", base: "unit" }])} disabled={kinds.length >= 20}>
          <Plus className="h-4 w-4" />
          種別を足す
        </Button>
      </section>

      <Button onClick={save} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">税率・税額の表</h2>
        <p className="text-xs text-gray-500">計算では、契約日(なければ決済日)が期間に入る表を使います。表を直す画面は、計算を入れるときに足します。</p>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr><th className="px-3 py-2">表</th><th className="px-3 py-2">適用開始</th><th className="px-3 py-2">適用終了</th></tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2">{RATE_TABLE_KIND_LABELS[t.kind as keyof typeof RATE_TABLE_KIND_LABELS] ?? t.kind}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validFrom}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validTo ?? "期限なし"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
