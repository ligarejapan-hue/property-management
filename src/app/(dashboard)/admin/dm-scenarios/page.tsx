"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  fetchSaleDmScenarios,
  createSaleDmScenario,
  updateSaleDmScenario,
  deleteSaleDmScenario,
  type SaleDmScenarioSummary,
} from "@/lib/api-client";

/**
 * DMの種類(台帳)の一覧(管理者・設計 2026-09-27 §3.6)。
 * 種類ごとに手紙とLPの文面を1回だけ作り、物件の「DMの種類」や発送で使い回す。
 * 相続・空き家(autoKey あり)は自動で選ばれる種類なので削除できない(止めるときは「使わない」)。
 */
export default function AdminDmScenariosPage() {
  const [rows, setRows] = useState<SaleDmScenarioSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [target, setTarget] = useState<SaleDmScenarioSummary | null>(null);

  const load = async () => {
    try { setRows(await fetchSaleDmScenarios()); }
    catch (e) { setError(e instanceof Error ? e.message : "読み込みに失敗しました"); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "処理に失敗しました"); }
    finally { setBusy(false); }
  };

  const add = () => run(async () => {
    const name = newName.trim();
    if (!name) return;
    await createSaleDmScenario(name);
    setNewName("");
  });
  const toggleActive = (s: SaleDmScenarioSummary) => run(async () => { await updateSaleDmScenario(s.id, { active: !s.active }); });
  const remove = () => run(async () => {
    if (!target) return;
    try { await deleteSaleDmScenario(target.id); }
    finally { setTarget(null); }
  });

  const tag = (ok: boolean, what: string) => (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs ${ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
      {what} {ok ? "登録済み" : "未登録"}
    </span>
  );

  return (
    <div>
      <PageHeader
        title="DMの種類"
        description="売却DMの手紙とご案内ページ(LP)の文面を、種類ごとに1回だけ作って使い回します。物件ごとの種類は物件の画面の「DMの種類」で選べます(空欄なら導入ルートから自動で決まります)。"
      />
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          maxLength={40}
          placeholder="新しい種類の名前(例: 住み替え)"
          aria-label="新しい種類の名前"
          className="w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <Button onClick={() => void add()} disabled={busy || newName.trim() === ""}>
          <Plus className="h-4 w-4" />種類を追加
        </Button>
      </div>

      {rows === null ? (
        error ? null : <p className="text-sm text-gray-500"><Loader2 className="inline h-4 w-4 animate-spin" /> 読み込み中</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">種類はまだありません。</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">並び</th>
                <th className="px-3 py-2 font-medium">名前</th>
                <th className="px-3 py-2 font-medium">文面</th>
                <th className="px-3 py-2 font-medium">使う/使わない</th>
                <th className="px-3 py-2 font-medium"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((s) => (
                <tr key={s.id} className={s.active ? "" : "bg-gray-50/60 text-gray-500 dark:bg-gray-800/40"}>
                  <td className="px-3 py-2 tabular-nums">{s.sortOrder}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/dm-scenarios/${s.id}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{s.name}</Link>
                    {s.autoKey && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">(自動で選ばれる種類)</span>}
                  </td>
                  <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{tag(s.hasLetter, "手紙")}{tag(s.hasLp, "LP")}</div></td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-1.5">
                      <input type="checkbox" checked={s.active} disabled={busy} onChange={() => void toggleActive(s)} aria-label={`「${s.name}」を使う`} />
                      {s.active ? "使う" : "使わない"}
                    </label>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!s.autoKey && (
                      <button type="button" onClick={() => setTarget(s)} disabled={busy} title="削除" aria-label={`「${s.name}」を削除`} className="text-red-600 disabled:opacity-40">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target && (
        <ConfirmDialog
          title={`「${target.name}」を削除しますか？`}
          message="物件や発送で使われている種類は削除できません(そのときは「使わない」にしてください)。"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}
