"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { CampaignListView } from "@/components/sale-dm/campaign-list-view";
import type { CampaignListItem } from "@/lib/sale-dm-letter/campaign-list";

// 売却DMの発送一覧(画面すっきり化 第1回・2026-10-15)。
// 作った発送をあとで開き直す入口が無かった(作成直後の画面遷移だけ)。自分が作った発送を新しい順に並べ、
// 押すとその発送の画面を開く。認可はサーバー(requireSaleDmAccess+作成者本人のみ)が持つ。
export default function SaleDmCampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignListItem[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/properties/sale-dm/campaigns", { signal: ac.signal, cache: "no-store" });
        if (res.status === 403) {
          setState("forbidden");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { campaigns: CampaignListItem[] };
        setCampaigns(body.campaigns);
        setState("ok");
      } catch {
        if (!ac.signal.aborted) setState("error");
      }
    })();
    return () => ac.abort();
  }, [reloadKey]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <PageHeader
        title="売却DMの発送一覧"
        description="自分が作った売却DMの発送です。押すと、その発送の画面(文面・印刷・送付の記録)を開きます。"
      />
      {state === "loading" && <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>}
      {state === "forbidden" && (
        <p className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
          売却DMを使う権限がありません。管理者にお問い合わせください。
        </p>
      )}
      {state === "error" && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">
          <span>読み込めませんでした。</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setState("loading");
              setReloadKey((k) => k + 1);
            }}
          >
            もう一度読む
          </Button>
        </div>
      )}
      {state === "ok" && campaigns && <CampaignListView campaigns={campaigns} />}
    </div>
  );
}
