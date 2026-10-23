"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, errorText } from "@/lib/deals/client";
import type { DealListItem } from "@/lib/deals/view";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { formatJstDateTime } from "@/lib/deals/datetime";

/** 取引の一覧(設計 §5)。新しい順・50件ずつ。 */
export default function DealsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<DealListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await dealsApi.list({ status, businessType, q, page: String(page), ...(mine ? { assignee: "me" } : {}) });
      setRows(res.deals);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [status, businessType, q, page, mine]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastPage = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-5">
      <PageHeader
        title="取引"
        description="仲介・買取再販の取引です。取引ごとに資金計画表・事業計画書・業務書類を出せるようになります。"
        actions={
          <Button onClick={() => router.push("/deals/new")}>
            <Plus className="h-4 w-4" />
            新しい取引
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="状態">
          <SelectBox label="状態" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={optionsOf(DEAL_STATUS_LABELS)} allowEmpty />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={businessType} onChange={(v) => { setBusinessType(v); setPage(1); }} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} allowEmpty />
        </Field>
        <Field label="取引名・取引番号で探す">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} maxLength={100} aria-label="取引名・取引番号で探す" className={inputCls} />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} />
          自分の担当だけ
        </label>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {rows === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">取引はまだありません。「新しい取引」から作れます。</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">取引番号</th>
                <th className="px-3 py-2">取引名</th>
                <th className="px-3 py-2">事業区分</th>
                <th className="px-3 py-2">状態</th>
                <th className="px-3 py-2">契約</th>
                <th className="px-3 py-2">決済</th>
                <th className="px-3 py-2">担当</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 tabular-nums">{r.dealNo}</td>
                  <td className="px-3 py-2">
                    <Link href={`/deals/${r.id}`} className="text-indigo-700 hover:underline dark:text-indigo-400">{r.name}</Link>
                  </td>
                  <td className="px-3 py-2">{DEAL_BUSINESS_TYPE_LABELS[r.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? r.businessType}</td>
                  <td className="px-3 py-2">{DEAL_STATUS_LABELS[r.status as keyof typeof DEAL_STATUS_LABELS] ?? r.status}</td>
                  <td className="px-3 py-2 tabular-nums">{formatJstDateTime(r.contractAt)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatJstDateTime(r.settlementAt)}</td>
                  <td className="px-3 py-2">{r.assigneeName ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>前へ</Button>
          <span className="tabular-nums">{page} / {lastPage}</span>
          <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>次へ</Button>
        </div>
      )}
    </div>
  );
}
