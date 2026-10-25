"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { dealsApi, errorText } from "@/lib/deals/client";
import type { RegistryRightsView } from "@/lib/deals/registry-rights";

const dateJa = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });

/**
 * 物件の謄本(全部事項の最新の1件)の登記の現況(設計 §4.6.1)。確認用で、取引のデータには書き込まない。
 * 物件の無い取引・全部事項の添付が無い取引では何も出さない。権利者名は「所有者の閲覧」もある人だけ(サーバーで伏せる)。
 */
export function DealRegistryRights({ dealId, propertyId }: { dealId: string; propertyId: string | null }) {
  const [rights, setRights] = useState<RegistryRightsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    let alive = true;
    dealsApi.registryRights(dealId)
      .then((r) => { if (alive) { setRights(r.rights); setError(null); } })
      .catch((e) => { if (alive) setError(`謄本の登記の現況を読み込めませんでした: ${errorText(e)}`); });
    return () => { alive = false; };
  }, [dealId, propertyId]);

  if (!propertyId) return null;
  if (error) return <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>;
  if (!rights || rights.status === "none") return null;
  if (rights.status === "unreadable") {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        謄本を確認してください(添付の全部事項から登記の現況を判定できませんでした)。
      </p>
    );
  }
  const from = `謄本(全部事項・${dateJa(rights.attachmentCreatedAt)} 添付)`;
  if (!rights.activeRights.length && !rights.cautions.length && !rights.notes.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        {from}では、抵当権などは残っていません。
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
      {rights.activeRights.length > 0 && (
        <>
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            抵当権などが残っています({rights.activeRights.length}件・{from})
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left"><th className="py-1 pr-2">順位</th><th className="py-1 pr-2">目的</th><th className="py-1 pr-2">債権額・極度額</th><th className="py-1">権利者</th></tr>
            </thead>
            <tbody>
              {rights.activeRights.map((r) => (
                <tr key={`${r.rank}-${r.purpose}`} className="border-t border-amber-200 dark:border-amber-900">
                  <td className="py-1 pr-2 tabular-nums">{r.rank}番</td>
                  <td className="py-1 pr-2">{r.purpose}</td>
                  <td className="py-1 pr-2">{r.amount ?? "—"}</td>
                  <td className="py-1">{r.holder ?? "(所有者の閲覧の権限がある人だけに表示)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs">決済時の書類確認書に、抹消の依頼・抹消費用・抹消書類の受け取りを自動で足します。</p>
        </>
      )}
      {rights.cautions.length > 0 && (
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          注意: {rights.cautions.map((c) => `${c.section} ${c.rank}番 ${c.purpose}`).join("・")}が残っています。
        </p>
      )}
      {rights.notes.length > 0 && <ul className="list-disc pl-5 text-xs">{rights.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}
