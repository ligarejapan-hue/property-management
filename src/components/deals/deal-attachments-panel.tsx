"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import AttachmentTab from "@/components/properties/attachment-tab";
import { splitDealsOf, type ScopeDeal } from "@/lib/attachments/deal-scope";

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
 * revision(取引の版・当事者)が変わったら読み直す=当事者に自社を足して仕入/売却が分かるようになったら、その取引に付ける(@codex P2)。
 */
export default function DealAttachmentsPanel({
  dealId, propertyId, active, revision,
}: { dealId: string; propertyId: string; active: boolean; revision: string }) {
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
      // 読み直しの失敗で、見えている一覧を消さない。
      .catch(() => { if (alive) setState((s) => (s?.kind === "ok" ? s : { kind: "error" })); });
    return () => { alive = false; };
  }, [requested, propertyId, attempt, revision]);

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
  // この取引が仕入/売却に分けられるようになった(なくなった)ら作り直す=最初の絞り込みをこの取引にする。
  const splittable = splitDealsOf(property.deals ?? []).some((d) => d.id === dealId);
  return (
    <AttachmentTab
      key={splittable ? "split" : "plain"}
      propertyId={propertyId}
      deals={property.deals ?? null}
      fixedDealId={dealId}
      caseStatus={property.caseStatus ?? null}
      occupancyStatus={property.occupancyStatus ?? null}
    />
  );
}
