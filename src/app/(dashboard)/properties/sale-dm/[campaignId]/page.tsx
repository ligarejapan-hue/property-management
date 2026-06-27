"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, CheckCircle2, Printer, Download, Send } from "lucide-react";
import {
  fetchSaleDmCampaign,
  confirmSaleDmDrafts,
  markSaleDmDraftSent,
  saleDmPrintUrl,
  saleDmExportUrl,
  type SaleDmCampaign,
  type SaleDmDraft,
} from "@/lib/api-client";
import { renderLetterHtml } from "@/lib/sale-dm-letter/templates";
import SaleDmAdjustPanel from "@/components/sale-dm/adjust-panel";
import SaleDmRecipientList from "@/components/sale-dm/recipient-list";
import SaleDmAggregateView from "@/components/sale-dm/aggregate-view";

export default function SaleDmWorkspacePage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId;

  const [campaign, setCampaign] = useState<SaleDmCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { campaign } = await fetchSaleDmCampaign(campaignId);
      setCampaign(campaign);
      setSelectedId((prev) => prev ?? campaign.recipients[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "キャンペーンの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  const selected: SaleDmDraft | null = useMemo(
    () => campaign?.recipients.find((r) => r.id === selectedId) ?? null,
    [campaign, selectedId],
  );
  const selectedVariant = useMemo(
    () => campaign?.variants.find((v) => v.id === selected?.variantId) ?? campaign?.variants[0] ?? null,
    [campaign, selected],
  );

  // プレビュー: 確定済み本文 + 宛名を Plan 2 レンダラ(全動的値を escape)で組む。
  // 差出人/追跡QR は印刷時に env/トークンから補完するため、プレビューでは空にする。
  const previewHtml = useMemo(() => {
    if (!selected || !selectedVariant) return "";
    return renderLetterHtml({
      designTemplate: selectedVariant.designTemplate,
      body: selected.body,
      addresseeName: selected.recipientName,
      honorific: selected.honorific,
      recipientZip: selected.recipientZip,
      recipientAddress: selected.recipientAddress,
      senderName: "",
      senderContact: "",
      trackingToken: selected.id,
    });
  }, [selected, selectedVariant]);

  // 送付フローの対象件数: draft=確定対象 / confirmed=送付済みにする対象。
  const draftIds = useMemo(
    () => (campaign?.recipients ?? []).filter((r) => r.status === "draft").map((r) => r.id),
    [campaign],
  );
  const confirmedIds = useMemo(
    () => (campaign?.recipients ?? []).filter((r) => r.status === "confirmed").map((r) => r.id),
    [campaign],
  );

  // 操作を実行 → 再取得(状態を最新化)。失敗はエラー表示。
  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作に失敗しました");
      } finally {
        setActionBusy(false);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error ?? "キャンペーンが見つかりません"}
        <button onClick={load} className="ml-2 underline hover:no-underline">再試行</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">{campaign.name}</h2>
        <span className="text-sm text-gray-500">{campaign.recipients.length} 通</span>
      </div>

      {/* 送付フロー: 確定(draft→confirmed)→ 印刷/CSV → 送付済み(confirmed→sent・反響入力解禁) */}
      <div className="flex flex-wrap items-center gap-2">
        {draftIds.length > 0 && (
          <button
            type="button"
            onClick={() => runAction(() => confirmSaleDmDrafts(draftIds))}
            disabled={actionBusy}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            title="下書きを確定する(印刷対象は確定済みのみ)"
          >
            <CheckCircle2 className="h-4 w-4" />
            確定({draftIds.length})
          </button>
        )}
        <button
          type="button"
          onClick={() => window.open(saleDmPrintUrl(campaignId), "_blank", "noopener")}
          disabled={actionBusy}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          title="確定済みの手紙を別タブで開いて印刷"
        >
          <Printer className="h-4 w-4" />
          印刷
        </button>
        <button
          type="button"
          onClick={() => window.open(saleDmExportUrl(campaignId), "_blank", "noopener")}
          disabled={actionBusy}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          title="差込用 CSV をダウンロード"
        >
          <Download className="h-4 w-4" />
          CSV出力
        </button>
        {confirmedIds.length > 0 && (
          <button
            type="button"
            onClick={() => runAction(() => Promise.all(confirmedIds.map((id) => markSaleDmDraftSent(id))))}
            disabled={actionBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
            title="確定済みを送付済みにする(配達結果・反響の入力が解禁)"
          >
            <Send className="h-4 w-4" />
            確定分を送付済みに({confirmedIds.length})
          </button>
        )}
        {actionBusy && <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />}
      </div>

      <SaleDmAggregateView campaign={campaign} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
        {/* 左: 調整パネル */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <SaleDmAdjustPanel campaign={campaign} selected={selected} onChanged={load} />
        </div>

        {/* 中央: 手紙プレビュー */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          {selected ? (
            <div
              data-pii-protected
              data-pii-surface="owner"
              className="sale-dm-preview mx-auto max-w-[640px]"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <p className="py-12 text-center text-sm text-gray-500">宛先を選択してください</p>
          )}
        </div>

        {/* 右: 宛先リスト */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <SaleDmRecipientList
            campaign={campaign}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChanged={load}
          />
        </div>
      </div>
    </div>
  );
}
