"use client";

import { useState } from "react";
import { Copy, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { BANK_ACCOUNT_TYPE_LABELS } from "@/lib/deals/constants";
import { yenText } from "@/lib/deals/money-forms";
import {
  PAYMENT_METHOD_LABELS, effectiveAccount, formatBankAccount, normalizeAccountNumber, paymentRows, paymentsForSave, type PaymentRow,
} from "@/lib/deals/payments";
import { EMPTY_BANK_ACCOUNT, type BankAccount, type PaymentEntry, type PaymentMethod } from "@/lib/deals/schemas";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";

type AccountText = Record<keyof BankAccount, string>;
type Draft = { method: PaymentMethod; account: AccountText };
const toText = (b: BankAccount): AccountText => ({
  bankName: b.bankName ?? "", branchName: b.branchName ?? "", accountType: b.accountType ?? "", accountNumber: b.accountNumber ?? "", accountHolder: b.accountHolder ?? "",
});
const ACCOUNT_FIELDS: [Exclude<keyof BankAccount, "accountType">, string, number][] = [
  ["bankName", "銀行名", 100], ["branchName", "支店名", 100], ["accountNumber", "口座番号(7桁まで)", 12], ["accountHolder", "名義", 100],
];
const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

/**
 * お金の受け渡し(2026-11-16 発注者)。お金ごとに払い方(振込・現金・未定・精算金だけ残金と一緒に)と振込先の口座を入れる。
 * 金額・払う人・受け取る人は取引の入力と決済の計算から出す(ここでは直さない)。決まりは src/lib/deals/payments.ts。
 * 入れた内容は、残金決済のご案内と書類確認書(契約時・決済時)の払い方の初期値に入る(書類の画面で直せる)。
 */
export default function DealPaymentsPanel({
  deal, calc, selfAccount, onSaved,
}: {
  deal: DealView;
  calc: DealCalc | null;
  /** 取引の設定の自社の口座(自社が受け取るお金の初期値)。 */
  selfAccount: BankAccount;
  onSaved: () => Promise<void>;
}) {
  const rows = paymentRows(deal, calc);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(rows.map((r) => [r.key, { method: r.entry.method, account: toText(r.entry.account) }])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selfText = formatBankAccount(selfAccount);

  const draftOf = (r: PaymentRow): Draft => drafts[r.key] ?? { method: r.entry.method, account: toText(r.entry.account) };
  const update = (key: string, fn: (d: Draft) => Draft) => {
    setSaved(false);
    setDrafts((ds) => {
      const r = rows.find((x) => x.key === key)!;
      return { ...ds, [key]: fn(ds[key] ?? { method: r.entry.method, account: toText(r.entry.account) }) };
    });
  };

  /** 下書き → 保存する形。口座番号が読めない行があれば、その行の名前を返す。 */
  const build = (): { entries: Record<string, PaymentEntry>; bad: string[] } => {
    const entries: Record<string, PaymentEntry> = {};
    const bad: string[] = [];
    for (const r of rows) {
      const d = draftOf(r);
      // 口座番号を確かめるのは振込の行だけ(現金に替えたあと、隠れた欄の打ち間違いで保存を止めない・内部レビュー P3)。
      const num = d.method === "transfer" ? normalizeAccountNumber(d.account.accountNumber) : "";
      if (num === null) bad.push(r.label);
      const t = (v: string) => (v.trim() === "" ? null : v.trim());
      entries[r.key] = {
        method: d.method,
        account: d.method === "transfer"
          ? {
            bankName: t(d.account.bankName), branchName: t(d.account.branchName),
            accountType: d.account.accountType === "ordinary" || d.account.accountType === "current" ? d.account.accountType : null,
            accountNumber: num ? num : null, accountHolder: t(d.account.accountHolder),
          }
          : EMPTY_BANK_ACCOUNT,
      };
    }
    return { entries, bad };
  };

  const save = async () => {
    const { entries, bad } = build();
    if (bad.length > 0) {
      setError(`${bad.join("・")}の口座番号は7桁までの数字で入れてください。保存していません。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, payments: paymentsForSave(deal.payments ?? {}, rows, entries) });
      setSaved(true);
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  // 「残金と一緒に」の行に出す、残金の今の口座(下書きの値で)。
  const { entries: current } = build();
  const liveRows = rows.map((r) => ({ ...r, entry: current[r.key] ?? r.entry }));
  const copySources = (key: string) => liveRows.filter((r) => r.key !== key && r.entry.method === "transfer" && formatBankAccount(r.entry.account));

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        お金ごとに、現金か振込かを選び、振込なら振込先の口座を入れます。金額は「金額・費用」「精算」タブの入力から自動で出します。
        入れた内容は、残金決済のご案内と書類確認書の払い方に最初から入ります(書類を出すときに直せます)。
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {liveRows.map((r) => {
          const d = draftOf(r);
          const methods: PaymentMethod[] = r.allowWithBalance ? ["transfer", "cash", "with_balance", "undecided"] : ["transfer", "cash", "undecided"];
          const fallbackSelf = d.method === "transfer" && r.toSelf && !formatBankAccount(r.entry.account) && selfText;
          const withBalance = d.method === "with_balance" ? effectiveAccount(r, liveRows, selfAccount) : null;
          const sources = copySources(r.key);
          return (
            <li key={r.key} className="space-y-3 p-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-medium">{r.label}</span>
                <span className="text-xs text-gray-500">{r.from} → {r.to}</span>
                <span className="ml-auto tabular-nums text-sm">{r.amount === null ? "—" : `${yenText(r.amount)}円`}</span>
              </div>
              <div role="radiogroup" aria-label={`${r.label}の払い方`} className="flex flex-wrap gap-2">
                {methods.map((m) => (
                  <label key={m} className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${d.method === m ? "border-blue-600 bg-blue-50 font-semibold text-blue-700 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-200" : "border-gray-300 dark:border-gray-700"}`}>
                    <input type="radio" className="sr-only" name={`pay-${r.key}`} checked={d.method === m} onChange={() => update(r.key, (x) => ({ ...x, method: m }))} />
                    {PAYMENT_METHOD_LABELS[m]}
                  </label>
                ))}
              </div>
              {d.method === "with_balance" && (
                <p className="text-xs text-gray-500">
                  残金と同じ払い方・口座です{withBalance && formatBankAccount(withBalance) ? `(${formatBankAccount(withBalance)})` : ""}。
                  {calc?.settlement.net.direction === "sellerToBuyer" ? "売主から買主へのお金なので、残金から差し引きます。" : ""}
                </p>
              )}
              {d.method === "transfer" && (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem_9rem_1fr]">
                    {ACCOUNT_FIELDS.slice(0, 2).map(([k, label, max]) => (
                      <input key={k} aria-label={`${r.label}の${label}`} placeholder={label} maxLength={max} value={d.account[k]}
                        onChange={(e) => update(r.key, (x) => ({ ...x, account: { ...x.account, [k]: e.target.value } }))} className={inputCls} />
                    ))}
                    <select aria-label={`${r.label}の口座の種別`} value={d.account.accountType}
                      onChange={(e) => update(r.key, (x) => ({ ...x, account: { ...x.account, accountType: e.target.value } }))} className={inputCls}>
                      <option value="">種別</option>
                      {Object.entries(BANK_ACCOUNT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {ACCOUNT_FIELDS.slice(2).map(([k, label, max]) => (
                      <input key={k} aria-label={`${r.label}の${label}`} placeholder={label} maxLength={max} value={d.account[k]} inputMode={k === "accountNumber" ? "numeric" : undefined}
                        onChange={(e) => update(r.key, (x) => ({ ...x, account: { ...x.account, [k]: e.target.value } }))} className={inputCls} />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selfText && (
                      <Button variant="ghost" size="sm" onClick={() => update(r.key, (x) => ({ ...x, account: toText(selfAccount) }))}>
                        <Copy className="h-4 w-4" />
                        自社の口座を入れる
                      </Button>
                    )}
                    {sources.map((s) => (
                      <Button key={s.key} variant="ghost" size="sm" onClick={() => update(r.key, (x) => ({ ...x, account: toText(s.entry.account) }))}>
                        <Copy className="h-4 w-4" />
                        {s.label}と同じ口座にする
                      </Button>
                    ))}
                    {fallbackSelf && <span className="text-xs text-gray-500">空欄のときは自社の口座({selfText})を使います</span>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
          <Save className="h-4 w-4" />
          保存
        </Button>
        {saved && <span className="text-sm text-green-700 dark:text-green-400">保存しました</span>}
      </div>
    </div>
  );
}
