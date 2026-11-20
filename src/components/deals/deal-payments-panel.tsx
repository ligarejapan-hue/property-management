"use client";

import { useState } from "react";
import { Copy, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { BANK_ACCOUNT_TYPE_LABELS } from "@/lib/deals/constants";
import { yenText } from "@/lib/deals/money-forms";
import {
  PAYMENT_METHOD_LABELS, PAYMENT_PARTY_LABELS, effectiveAccount, formatBankAccount, normalizeAccountNumber, paymentRows, paymentsForSave,
  paymentTotals, withParties, type PaymentRow,
} from "@/lib/deals/payments";
import {
  EMPTY_BANK_ACCOUNT, PAYMENT_PARTY_KINDS, type BankAccount, type OtherPaymentEntry, type PaymentMethod, type PaymentParty, type PaymentPartyKind,
} from "@/lib/deals/schemas";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import { pickBank, pickBranch, typeBank, typeBranch } from "@/lib/bank-directory/account-fields";
import DirectoryCombobox, { BRANCH_NEEDS_BANK_TEXT, bankSearchUrl, branchSearchUrl } from "./bank-directory-combobox";

type AccountText = Record<keyof BankAccount, string>;
/** from/to は払う人・受け取る人を選べる行(費用のその他)だけ。 */
type Draft = { method: PaymentMethod; account: AccountText; from?: PaymentParty; to?: PaymentParty };
const toText = (b: BankAccount): AccountText => ({
  bankName: b.bankName ?? "", branchName: b.branchName ?? "", accountType: b.accountType ?? "", accountNumber: b.accountNumber ?? "", accountHolder: b.accountHolder ?? "",
  bankCode: b.bankCode ?? "", branchCode: b.branchCode ?? "",
});
const draftFromRow = (r: PaymentRow): Draft => ({
  method: r.entry.method, account: toText(r.entry.account), ...(r.parties ? { from: r.parties.from, to: r.parties.to } : {}),
});
const PARTY_SIDES = [["from", "払う人"], ["to", "受け取る人"]] as const;
// 銀行名・支店名は候補つきの欄(DirectoryCombobox)で別に出す。
const ACCOUNT_FIELDS: [Exclude<keyof BankAccount, "accountType" | "bankName" | "branchName" | "bankCode" | "branchCode">, string, number][] = [
  ["accountNumber", "口座番号(7桁まで)", 12], ["accountHolder", "名義", 100],
];
const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

/**
 * お金の受け渡し(2026-11-16 発注者)。お金ごとに払い方(振込・現金・未定・精算金だけ残金と一緒に)と振込先の口座を入れる。
 * 金額は取引の入力と決済の計算から出す(ここでは直さない)。払う人・受け取る人も決まった形で出すが、
 * 費用のその他の行だけは選べる(2026-11-18 発注者「業務委託費が売主→支払先に固定。選択式に」)。決まりは src/lib/deals/payments.ts。
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
    Object.fromEntries(rows.map((r) => [r.key, draftFromRow(r)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selfText = formatBankAccount(selfAccount);

  const draftOf = (r: PaymentRow): Draft => drafts[r.key] ?? draftFromRow(r);
  const update = (key: string, fn: (d: Draft) => Draft) => {
    setSaved(false);
    setDrafts((ds) => {
      const r = rows.find((x) => x.key === key)!;
      return { ...ds, [key]: fn(ds[key] ?? draftFromRow(r)) };
    });
  };

  /** 下書き → 保存する形。口座番号が読めない行があれば、その行の名前を返す。 */
  const build = (): { entries: Record<string, OtherPaymentEntry>; bad: string[] } => {
    const entries: Record<string, OtherPaymentEntry> = {};
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
            bankCode: t(d.account.bankCode), branchCode: t(d.account.branchCode),
            accountType: d.account.accountType === "ordinary" || d.account.accountType === "current" ? d.account.accountType : null,
            accountNumber: num ? num : null, accountHolder: t(d.account.accountHolder),
          }
          : EMPTY_BANK_ACCOUNT,
        // 払う人は保存の形では payer(前の形 from は読むだけ)。
        ...(r.parties && d.from && d.to ? { payer: d.from, to: d.to } : {}),
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
  // 払う人・受け取る人を選べる行は、選び直した相手で出し直す(当社を選べば自社の口座の案内も出る)。
  const liveRows = rows.map((r) => {
    const e = current[r.key];
    const live: PaymentRow = { ...r, entry: e ? { method: e.method, account: e.account } : r.entry };
    return e?.payer && e.to ? withParties(deal, live, e.payer, e.to) : live;
  });
  const copySources = (key: string) => liveRows.filter((r) => r.key !== key && r.entry.method === "transfer" && formatBankAccount(r.entry.account));

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        お金ごとに、現金か振込かを選び、振込なら振込先の口座を入れます。金額は「金額・費用」「精算」タブの入力から自動で出します。
        入れた内容は、残金決済のご案内と書類確認書の払い方に最初から入ります(書類を出すときに直せます)。
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <PaymentTotalsTable rows={liveRows} />
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
              {r.parties && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {PARTY_SIDES.map(([side, sideLabel]) => {
                    const p = d[side] ?? r.parties![side];
                    const setParty = (next: PaymentParty) => update(r.key, (x) => ({ ...x, [side]: next }));
                    return (
                      <div key={side} className="space-y-1">
                        <span className="block text-xs text-gray-500">{sideLabel}</span>
                        <select aria-label={`${r.label}の${sideLabel}`} value={p.kind} className={inputCls}
                          onChange={(e) => setParty({ kind: e.target.value as PaymentPartyKind, name: p.name })}>
                          {PAYMENT_PARTY_KINDS.map((k) => <option key={k} value={k}>{PAYMENT_PARTY_LABELS[k]}</option>)}
                        </select>
                        {p.kind === "other" && (
                          <input aria-label={`${r.label}の${sideLabel}の名前`} placeholder="名前(空なら「支払先」)" maxLength={50} value={p.name ?? ""}
                            onChange={(e) => setParty({ kind: "other", name: e.target.value })} className={inputCls} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div role="radiogroup" aria-label={`${r.label}の払い方`} className="flex flex-wrap gap-2">
                {methods.map((m) => (
                  <label key={m} className={`relative cursor-pointer rounded-full border px-3 py-1 text-sm ${d.method === m ? "border-blue-600 bg-blue-50 font-semibold text-blue-700 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-200" : "border-gray-300 dark:border-gray-700"}`}>
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
                    <DirectoryCombobox id={`pay-${r.key}-bank`} ariaLabel={`${r.label}の銀行名`} placeholder="銀行名" maxLength={100} className={inputCls} showCode
                      value={d.account.bankName} searchUrl={bankSearchUrl}
                      onType={(text) => update(r.key, (x) => ({ ...x, account: typeBank(x.account, text) }))}
                      onPick={(c) => update(r.key, (x) => ({ ...x, account: pickBank(x.account, c) }))} />
                    <DirectoryCombobox id={`pay-${r.key}-branch`} ariaLabel={`${r.label}の支店名`} placeholder="支店名" maxLength={100} className={inputCls}
                      value={d.account.branchName} searchUrl={branchSearchUrl(d.account.bankCode)} noUrlText={BRANCH_NEEDS_BANK_TEXT}
                      onType={(text) => update(r.key, (x) => ({ ...x, account: typeBranch(x.account, text) }))}
                      onPick={(c) => update(r.key, (x) => ({ ...x, account: pickBranch(x.account, c) }))} />
                    <select aria-label={`${r.label}の口座の種別`} value={d.account.accountType}
                      onChange={(e) => update(r.key, (x) => ({ ...x, account: { ...x.account, accountType: e.target.value } }))} className={inputCls}>
                      <option value="">種別</option>
                      {Object.entries(BANK_ACCOUNT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {ACCOUNT_FIELDS.map(([k, label, max]) => (
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

/**
 * 払う人ごとの合計(2026-11-20 発注者「送金合計額・現金用意の金額が一目で分からない」)。
 * 画面の下書き(保存前)の払い方で出す。精算金の「残金と一緒に」は残金の側に入る(lib の paymentTotals)。
 */
function PaymentTotalsTable({ rows }: { rows: PaymentRow[] }) {
  const totals = paymentTotals(rows);
  const cell = (n: number) => (n === 0 ? "—" : `${yenText(n)}円`);
  const sum = (k: "transfer" | "cash" | "undecided") => totals.reduce((a, g) => a + g[k], 0);
  const missing = totals.reduce((a, g) => a + g.missing, 0);
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">払う人ごとの合計</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-gray-800">
              <th className="px-2 py-1 font-medium">払う人</th>
              <th className="px-2 py-1 text-right font-medium">振込</th>
              <th className="px-2 py-1 text-right font-medium">現金で用意</th>
              <th className="px-2 py-1 text-right font-medium">払い方が未定</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((g) => (
              <tr key={g.payer} className="border-b border-gray-100 dark:border-gray-900">
                <td className="px-2 py-1">{g.payer}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cell(g.transfer)}</td>
                <td className="px-2 py-1 text-right font-semibold tabular-nums">{cell(g.cash)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-gray-500">{cell(g.undecided)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="px-2 py-1">合計</td>
              <td className="px-2 py-1 text-right tabular-nums">{cell(sum("transfer"))}</td>
              <td className="px-2 py-1 text-right tabular-nums">{cell(sum("cash"))}</td>
              <td className="px-2 py-1 text-right tabular-nums text-gray-500">{cell(sum("undecided"))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">
        保存前の選び方で出します。精算金を残金とまとめて払うときは、残金の側に足します(売主から買主へのお金なら残金から差し引きます)。
        {missing > 0 ? `金額がまだ出ていない行が${missing}件あり、合計に入っていません。` : ""}
      </p>
    </section>
  );
}
