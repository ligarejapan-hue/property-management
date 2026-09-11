"use client";

import { useEffect, useState } from "react";
import { Loader2, Copy, Image as ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchSaleDmLpMedia, saveSaleDmLpMedia, fetchSaleDmLpImagePrompt, fetchSaleDmLpAssets, LP_ASSET_URL,
  type SaleDmLpAsset, type SaleDmLpMediaPlan, type SaleDmLpMediaResponse,
} from "@/lib/api-client";
import { FIGURE_KINDS, FIGURE_LABELS, isFigureKind } from "@/lib/sale-dm-letter/lp-figures";
import { LP_MEDIA_MAX_ASSETS } from "@/lib/sale-dm-letter/lp-media";
import { choiceFromMedia, setSectionChoice, setHero, assetCountOf, figureDataUrl, isPlanDirty, type SlotChoice } from "./lp-media-panel-model";
import LpAssetLibrary from "./lp-asset-library";

type Style = "photo" | "illustration" | "flat";
type Slot = { kind: "hero" } | { kind: "section"; heading: string };

/** LP型1件の「写真と図」(設計 §2.3)。ヒーロー1枠+小見出しごとの枠。凍結中は読むだけ。 */
export default function LpMediaPanel({ campaignId, lpId, label, onClose }: { campaignId: string; lpId: string; label: string; onClose: () => void }) {
  const [data, setData] = useState<SaleDmLpMediaResponse | null>(null);
  const [plan, setPlan] = useState<SaleDmLpMediaPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<Slot | null>(null);
  const [style, setStyle] = useState<Style>("photo");

  useEffect(() => {
    let alive = true;
    setData(null);
    setPlan(null);
    setNotice(null);
    setError(null);
    setPicking(null);
    fetchSaleDmLpMedia(campaignId, lpId)
      .then((d) => { if (alive) { setData(d); setPlan(d.plan); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "読み込みに失敗しました"); });
    return () => { alive = false; };
  }, [campaignId, lpId]);

  const reload = async () => {
    const d = await fetchSaleDmLpMedia(campaignId, lpId);
    setData(d);
    setPlan(d.plan);
  };
  const assetById = (id: string): SaleDmLpAsset | undefined => data?.assets.find((a) => a.id === id);
  const refreshAssets = async () => {
    try {
      const r = await fetchSaleDmLpAssets();
      setData((d) => (d ? { ...d, assets: r.assets } : d));
    } catch {
      setError("写真の一覧を更新できませんでした");
    }
  };
  const pick = (a: SaleDmLpAsset) => {
    if (!plan || !picking) return;
    const next = picking.kind === "hero" ? setHero(plan, a.id) : setSectionChoice(plan, picking.heading, { kind: "asset", assetId: a.id });
    if (assetCountOf(next) > LP_MEDIA_MAX_ASSETS) { setError(`写真は ${LP_MEDIA_MAX_ASSETS} 枚までです`); setNotice(null); setPicking(null); return; }
    setPlan(next);
    setPicking(null);
  };
  const save = async () => {
    if (!plan || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await saveSaleDmLpMedia(campaignId, lpId, plan);
      setNotice(`保存しました(写真 ${r.assetCount} 枚・図 ${r.figureCount} 点)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
      setBusy(false);
      return;
    }
    setData((d) => (d ? { ...d, plan } : d));
    try {
      await reload();
    } catch {
      setError("保存はできましたが、最新の状態を読み込めませんでした。パネルを開き直してください");
    } finally { setBusy(false); }
  };
  const copyPrompt = async (slot: Slot) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await fetchSaleDmLpImagePrompt(campaignId, lpId, { slot: slot.kind, heading: slot.kind === "section" ? slot.heading : undefined, style });
      await navigator.clipboard.writeText(r.prompt);
      setNotice("画像の指示文をコピーしました。お手元の画像生成AIに貼り付け、できた画像をこの画面の「写真を選ぶ…」で貼り付け(Ctrl+V)てください");
    } catch (e) {
      setError(e instanceof Error ? e.message : "指示文を取得できませんでした");
    } finally { setBusy(false); }
  };

  const thumb = (assetId: string) => {
    const a = assetById(assetId);
    if (!a) return <span className="text-red-600">(削除された写真)</span>;
    if (!a.referenced) return <span className="inline-flex h-16 w-28 items-center justify-center rounded bg-gray-100 text-center text-[10px] text-gray-500">{a.label ?? "写真"}(保存後に見本)</span>;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="h-16 w-28 rounded object-cover" />
    );
  };
  const clearSection = (heading: string) => { if (!plan) return; setPlan(setSectionChoice(plan, heading, { kind: "none" })); };
  const sectionChoice = (heading: string, choice: SlotChoice) => (
    <div className="flex flex-wrap items-center gap-2">
      <select value={choice.kind === "figure" ? `figure:${choice.figureKind}` : choice.kind} disabled={!!data?.frozen || busy}
        onChange={(e) => {
          if (!plan) return;
          const v = e.target.value;
          if (v === "none") setPlan(setSectionChoice(plan, heading, { kind: "none" }));
          else if (v === "asset") setPicking({ kind: "section", heading });
          else if (v.startsWith("figure:") && isFigureKind(v.slice(7))) setPlan(setSectionChoice(plan, heading, { kind: "figure", figureKind: v.slice(7) }));
        }}
        className="rounded border border-gray-300 px-2 py-1 text-xs">
        <option value="none">なし</option>
        <option value="asset">{choice.kind === "asset" ? "写真" : "写真を選ぶ…"}</option>
        {FIGURE_KINDS.map((k) => <option key={k} value={`figure:${k}`}>図: {FIGURE_LABELS[k]}</option>)}
      </select>
      {choice.kind === "asset" && thumb(choice.assetId)}
      {choice.kind === "figure" && isFigureKind(choice.figureKind) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={figureDataUrl(choice.figureKind)} alt={FIGURE_LABELS[choice.figureKind]} width={640} height={360} className="h-16 w-28 rounded border border-gray-200 object-contain" />
      )}
      {!data?.frozen && choice.kind === "asset" && (
        <>
          <button type="button" onClick={() => setPicking({ kind: "section", heading })} disabled={busy} className="text-indigo-700 hover:underline disabled:opacity-50">写真を選ぶ…</button>
          <button type="button" onClick={() => clearSection(heading)} disabled={busy} className="text-gray-600 hover:underline">外す</button>
        </>
      )}
      {!data?.frozen && <button type="button" onClick={() => void copyPrompt({ kind: "section", heading })} disabled={busy} className="inline-flex items-center gap-1 text-indigo-700 hover:underline disabled:opacity-50"><Copy className="h-3 w-3" />画像の指示文</button>}
    </div>
  );

  return (
    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-700"><ImageIcon className="mr-1 inline h-3.5 w-3.5" />「{label}」の写真と図</span>
        <button type="button" onClick={onClose} className="text-gray-500 hover:underline"><X className="inline h-3 w-3" /> 閉じる</button>
      </div>
      {!data || !plan ? (
        error ? <p className="mt-2 text-red-600">{error}</p> : <p className="mt-2 text-gray-500"><Loader2 className="inline h-3 w-3 animate-spin" /> 読み込み中</p>
      ) : (
        <>
          {data.frozen && <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型はすでに送付の実績があるため、写真と図は変更できません。変えるときは新しいLP型を追加してください。</p>}
          {data.headings.length === 0 && <p className="mt-2 text-gray-600">先に文章を保存してください(写真や図は本文の小見出しに付けます)。</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-gray-600">画像の指示文の画風:</span>
            {(["photo", "illustration", "flat"] as const).map((s) => (
              <label key={s} className="inline-flex items-center gap-1"><input type="radio" name="lp-style" checked={style === s} onChange={() => setStyle(s)} />{s === "photo" ? "写真風" : s === "illustration" ? "イラスト風" : "図解"}</label>
            ))}
          </div>
          <div className="mt-2 rounded border border-gray-200 bg-white p-2">
            <div className="font-medium text-gray-700">一番上の写真(ヒーロー)</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {plan.hero ? thumb(plan.hero.assetId) : <span className="text-gray-500">なし</span>}
              {!data.frozen && (
                <>
                  <button type="button" onClick={() => setPicking({ kind: "hero" })} disabled={busy} className="text-indigo-700 hover:underline disabled:opacity-50">写真を選ぶ…</button>
                  {plan.hero && <button type="button" onClick={() => setPlan(setHero(plan, null))} disabled={busy} className="text-gray-600 hover:underline">外す</button>}
                  <button type="button" onClick={() => void copyPrompt({ kind: "hero" })} disabled={busy} className="inline-flex items-center gap-1 text-indigo-700 hover:underline disabled:opacity-50"><Copy className="h-3 w-3" />画像の指示文</button>
                </>
              )}
            </div>
          </div>
          {plan.sections.map((s) => (
            <div key={s.heading} className="mt-2 rounded border border-gray-200 bg-white p-2">
              <div className="font-medium text-gray-700">■ {s.heading}</div>
              <div className="mt-1">{sectionChoice(s.heading, choiceFromMedia(s.media))}</div>
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-gray-500">写真 {assetCountOf(plan)} / {LP_MEDIA_MAX_ASSETS} 枚</span>
            {!data.frozen && (
              <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !isPlanDirty(data.plan, plan)}>
                {busy && <Loader2 className="h-3 w-3 animate-spin" />} 写真と図を保存
              </Button>
            )}
          </div>
          {notice && <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700">{notice}</p>}
          {error && <p className="mt-2 text-red-600">{error}</p>}
          <LpAssetLibrary open={picking !== null} onClose={() => setPicking(null)} onPick={pick} assets={data.assets} onAssetsChanged={() => void refreshAssets()} />
        </>
      )}
    </div>
  );
}
