"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, CheckCircle2, Printer, Download, Send } from "lucide-react";
import {
  fetchSaleDmCampaign,
  confirmSaleDmDrafts,
  markSaleDmDraftSent,
  apiErrorCode,
  saleDmPrintUrl,
  saleDmExportUrl,
  type SaleDmCampaign,
  type SaleDmDraft,
} from "@/lib/api-client";
import { renderLetterHtml } from "@/lib/sale-dm-letter/templates";
import { composeAddresseeHonorific } from "@/lib/sale-dm-letter/addressee";
import SaleDmAdjustPanel from "@/components/sale-dm/adjust-panel";
import SaleDmVariantManager from "@/components/sale-dm/variant-manager";
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
      // 印刷/CSV と同じ合成: 複数共有者なら「他共有者様」を付す。承認プレビューと郵送物の宛名を一致させ、
      // 代表者のみ宛ての見た目で承認 → 実際は「他共有者様」で郵送、という食い違いを防ぐ。
      honorific: composeAddresseeHonorific(selected.honorific, selected.coOwnerCount),
      recipientZip: selected.recipientZip,
      recipientAddress: selected.recipientAddress,
      senderName: "",
      senderContact: "",
      trackingToken: selected.id,
    });
  }, [selected, selectedVariant]);

  // 送付フローの対象件数: draft=確定対象 / confirmed=送付済みにする対象。
  // 本文が空(生成失敗 or 型変更で要再生成)の下書きは confirm route が確定対象から除外するため、
  // 「確定(N)」の件数も本文ありに限定し、ボタン件数と実際に確定される件数を一致させる。
  const draftIds = useMemo(
    () => (campaign?.recipients ?? []).filter((r) => r.status === "draft" && r.body !== "").map((r) => r.id),
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

  // 「確定分を送付済みに」の一括実行(@codex #384 R4 P2)。Promise.all だと、印刷から
  // 除外された terminal(拒否/宛先不明)の1件が 409 で全体を reject し、**先に成功した
  // 遷移が画面に反映されない**(runAction が reload を飛ばす)。allSettled で全件を
  // 走らせ、terminal はエラーでなく「スキップ N 件」として通知し、他の失敗だけを
  // エラーにする(いずれの場合も runAction 側で reload される)。
  const markConfirmedSentBulk = useCallback(async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map((id) => markSaleDmDraftSent(id)));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const terminalSkipped = rejected.filter((r) => apiErrorCode(r.reason) === "TERMINAL_RECIPIENT");
    const otherFailed = rejected.filter((r) => apiErrorCode(r.reason) !== "TERMINAL_RECIPIENT");
    if (terminalSkipped.length > 0) {
      window.alert(
        `${terminalSkipped.length} 件は拒否・宛先不明が記録されているため、送付済みにしませんでした(印刷からも除外されています)。`,
      );
    }
    if (otherFailed.length > 0) {
      // 成功分の reload を殺さないよう、まず載せ替えを終えてから最初の実エラーを投げる…
      // のではなく、ここで throw すると runAction が reload を飛ばす。エラー表示は
      // runAction の catch に任せつつ reload も走るよう、先に load 相当を挟まず
      // 「成功あり+失敗あり」でも必ず reload されるように throw は**しない**で
      // メッセージ表示だけ行う(次の操作/手動更新で残りは再試行できる)。
      const first = otherFailed[0].reason;
      window.alert(first instanceof Error ? first.message : "一部の宛先を送付済みにできませんでした");
    }
  }, []);

  // 全画面スピナーは初回ロード(まだ campaign が無い)時だけ。再取得(onChanged→load)では workspace を
  // アンマウントせず据え置き、操作中パネルのエラー握り潰し/入力中フォーム消失を防ぐ(更新はツールバーの
  // スピナー、一時エラーは下の非破壊バナーで示す)。
  if (loading && !campaign) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  // campaign が無い(初回ロード失敗等)ときだけ全画面エラー。読み込み済みなら再取得/操作の一時エラーで
  // workspace を消さず、下の非破壊バナー(role=alert)で表示する。
  if (!campaign) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
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

      {/* 再取得/操作の一時エラーは workspace を消さず非破壊的に表示(初回ロード失敗は上の全画面分岐)。
          パネルが据え置かれるので、操作中パネル自身のエラーはパネル内に出る。ここはページ全体(load/送付フロー)用。 */}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

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
            onClick={() => runAction(() => markConfirmedSentBulk(confirmedIds))}
            disabled={actionBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
            title="確定済みを送付済みにする(配達結果・反響の入力が解禁)"
          >
            <Send className="h-4 w-4" />
            確定分を送付済みに({confirmedIds.length})
          </button>
        )}
        {(actionBusy || loading) && <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />}
      </div>

      <SaleDmAggregateView campaign={campaign} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
        {/* 左: 調整パネル + A/B型管理 */}
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <SaleDmAdjustPanel campaign={campaign} selected={selected} onChanged={load} />
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <SaleDmVariantManager campaign={campaign} onChanged={load} />
          </div>
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
