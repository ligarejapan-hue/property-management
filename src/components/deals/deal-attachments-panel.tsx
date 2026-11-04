"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import AttachmentTab from "@/components/properties/attachment-tab";
import type { ScopeDeal } from "@/lib/attachments/deal-scope";

interface PropertyForAttachments {
  caseStatus?: string | null;
  occupancyStatus?: string | null;
  /** 取引を見る権限が無い人は返らない。 */
  deals?: ScopeDeal[] | null;
}

type LoadState = { kind: "error" } | { kind: "ok"; property: PropertyForAttachments };

/**
 * 取引の画面の「添付」タブ(買取再販の仕入/売却を分ける 2回目・2026-11-04 発注者 案A)。
 * 物件の添付タブの部品をそのまま使い、最初はこの取引の書類だけを出す。ここから入れた書類はこの取引の書類になる。
 * 初めて開いたときに物件を読む(開かない人には読みに行かない)。
 */
export default function DealAttachmentsPanel({ dealId, propertyId, active }: { dealId: string; propertyId: string; active: boolean }) {
  const [state, setState] = useState<LoadState | null>(null);
  // 読み込みに失敗したら「もう一度読む」で数を増やして読み直す。
  const [attempt, setAttempt] = useState(0);
  const requested = active || state !== null;

  useEffect(() => {
    if (!requested) return;
    let alive = true;
    fetch(`/api/properties/${propertyId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const property = (await res.json()) as PropertyForAttachments;
        if (alive) setState({ kind: "ok", property });
      })
      .catch(() => { if (alive) setState({ kind: "error" }); });
    return () => { alive = false; };
  }, [requested, propertyId, attempt]);

  if (!state) {
    return <div className="flex items-center gap-2 py-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3 py-6">
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">物件の添付を読み込めませんでした</p>
        <Button variant="secondary" size="sm" onClick={() => { setState(null); setAttempt((n) => n + 1); }}>もう一度読む</Button>
      </div>
    );
  }
  const { property } = state;
  return (
    <AttachmentTab
      propertyId={propertyId}
      deals={property.deals ?? null}
      fixedDealId={dealId}
      caseStatus={property.caseStatus ?? null}
      occupancyStatus={property.occupancyStatus ?? null}
    />
  );
}
