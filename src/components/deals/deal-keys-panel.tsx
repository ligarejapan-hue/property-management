"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { DEAL_KEYS_MAX, type DealKeyRow } from "@/lib/deals/deal-keys";
import type { DealView } from "@/lib/deals/view";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

type Row = { label: string; count: string };
const rowsOf = (keys: DealKeyRow[]): Row[] => (keys.length ? keys.map((k) => ({ label: k.label, count: String(k.count) })) : [{ label: "", count: "" }]);
const blank = (r: Row) => r.label.trim() === "" && r.count.trim() === "";
const countOk = (r: Row) => /^\d+$/.test(r.count.trim()) && Number(r.count) >= 1 && Number(r.count) <= 99;
/** 保存する行(番号も本数も空の行は送らない)。 */
const valueOf = (rows: Row[]): DealKeyRow[] => rows.filter((r) => !blank(r)).map((r) => ({ label: r.label.trim(), count: Number(r.count.trim()) }));

/**
 * 鍵の番号・種類と本数の記録(取引の物件タブ・2026-11-26 発注者)。
 * 鍵受領書を出すときの初めの値になる。番号が分からない鍵は番号を空けて本数だけでよい。
 */
export default function DealKeysPanel({ deal, onSaved }: { deal: DealView; onSaved: () => Promise<void> }) {
  const saved = deal.keys ?? [];
  const [rows, setRows] = useState<Row[]>(() => rowsOf(saved));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const incomplete = rows.some((r) => !blank(r) && !countOk(r));
  const dirty = !incomplete && JSON.stringify(valueOf(rows)) !== JSON.stringify(saved);
  const total = saved.reduce((a, k) => a + k.count, 0);
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (busy || incomplete) return;
    setBusy(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, keys: valueOf(rows) });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-gray-200 p-4 dark:border-gray-800" aria-labelledby="deal-keys-title">
      <h3 id="deal-keys-title" className="text-sm font-semibold text-gray-800 dark:text-gray-200">
        鍵{total > 0 && <span className="ml-2 text-xs font-normal text-gray-500">合計 {total}本</span>}
      </h3>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">鍵の番号・種類と本数</p>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} maxLength={50} placeholder="例: 玄関 No.12" aria-label={`鍵の番号・種類 ${i + 1}`} className={inputCls} autoComplete="off" />
            <input value={r.count} onChange={(e) => setRow(i, { count: e.target.value })} inputMode="numeric" aria-label={`本数 ${i + 1}`} className={`${inputCls} w-20`} />
            <span className="text-sm">本</span>
            <Button variant="secondary" size="sm" aria-label={`${i + 1}行目を消す`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {rows.length < DEAL_KEYS_MAX && (
          <Button variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs, { label: "", count: "" }])}>
            <Plus className="h-4 w-4" />
            行を足す
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-500">
        番号が分からない鍵は、番号を空けて本数だけ入れてください。鍵受領書を出すとき、ここの内容を初めから入れます。
      </p>
      {incomplete && <p className="text-sm text-amber-700 dark:text-amber-400">本数は 1〜99 の数で入れてください。</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} loading={busy} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        鍵を保存
      </Button>
    </section>
  );
}
