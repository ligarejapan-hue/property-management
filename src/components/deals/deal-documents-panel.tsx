"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calculator, FileSpreadsheet, FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dealsApi, dealDocumentFileUrl, errorText, type DealDocumentView } from "@/lib/deals/client";
import { formatJaDateTime } from "@/lib/format-datetime";

const LINK_CLS =
  "inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";

/**
 * 書類タブ(設計 §5)。発行した書類の履歴と、書類を作る画面への入口。
 * 履歴はタブを開いたときに読み直す(資金計画表の画面で発行して戻ってきたときも新しいものが出る)。
 */
export default function DealDocumentsPanel({ dealId, active }: { dealId: string; active: boolean }) {
  const [docs, setDocs] = useState<DealDocumentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    dealsApi.documents(dealId)
      .then((r) => { if (alive) { setDocs(r.documents); setError(null); } })
      .catch((e) => { if (alive) setError(`発行の履歴を読み込めませんでした: ${errorText(e)}`); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dealId, active, tick]);

  const reload = () => {
    setLoading(true);
    setTick((t) => t + 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/deals/${dealId}/funding-plan`} className={LINK_CLS}>
          <Calculator className="h-4 w-4" />
          資金計画表を作る・発行する
        </Link>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          読み込み直す
        </Button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {docs === null && !error && (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
      )}
      {docs !== null && docs.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">発行した書類はまだありません。資金計画表の画面の「保存して発行」で作れます。</p>
      )}
      {docs !== null && docs.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{d.title}</span>
                <span className="ml-2 text-xs text-gray-500">第{d.version}版</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {formatJaDateTime(d.issuedAt)} ・ {d.issuedByName}
                </span>
              </span>
              {d.hasPdf && (
                <a href={dealDocumentFileUrl(dealId, d.id, "pdf")} target="_blank" rel="noopener noreferrer" className={LINK_CLS}>
                  <FileText className="h-4 w-4" />
                  PDF
                </a>
              )}
              {d.hasXlsx && (
                <a href={dealDocumentFileUrl(dealId, d.id, "xlsx")} className={LINK_CLS}>
                  <FileSpreadsheet className="h-4 w-4" />
                  Excel
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
