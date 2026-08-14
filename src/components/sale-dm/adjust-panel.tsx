"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { Loader2 } from "lucide-react";
import type { SaleDmCampaign, SaleDmDraft } from "@/lib/api-client";
import { patchSaleDmDraft } from "@/lib/api-client";
import {
  resolveAdjustTarget,
  buildDraftPatch,
  DESIGN_OPTIONS,
  TONE_OPTIONS,
  LENGTH_OPTIONS,
  APPEAL_OPTIONS,
  STRENGTH_OPTIONS,
  type AdjustTab,
} from "@/lib/sale-dm-letter/adjust-model";

const labelOf = (opts: readonly { value: string; label: string }[], value: string) =>
  opts.find((o) => o.value === value)?.label ?? value;

export default function SaleDmAdjustPanel({
  campaign,
  selected,
  onChanged,
}: {
  campaign: SaleDmCampaign;
  selected: SaleDmDraft | null;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<AdjustTab>("campaign");
  const [bodyDraft, setBodyDraft] = useState(selected?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBodyDraft(selected?.body ?? "");
    // 宛先を切り替えたら前の宛先で出たエラー表示を消す(別宛先に古いエラーが残らないように)。
    setError(null);
  }, [selected?.id, selected?.body]);

  const variant =
    campaign.variants.find((v) => v.id === selected?.variantId) ?? campaign.variants[0] ?? null;
  const target = resolveAdjustTarget(tab, selected);

  const saveBody = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await patchSaleDmDraft(selected.id, buildDraftPatch({ body: bodyDraft }));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  // この宛先の型(variant)を手動で付け替える。型が変わると本文はクリアされ作り直しが必要(サーバー側 R14-2)。
  const changeVariant = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!selected) return;
    const variantId = e.target.value;
    if (variantId === selected.variantId) return;
    if (!window.confirm("この宛先の型を変えると、手紙の本文はクリアされ作り直し(再生成)が必要になります。続けますか？")) return;
    setBusy(true);
    setError(null);
    try {
      await patchSaleDmDraft(selected.id, buildDraftPatch({ variantId }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "型の変更に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  // ⚠AI直結の再生成は廃止した(設計 §2.1)。押しても必ずエラーになる導線を残さないため、
  //   ボタンごと外す。文面は「型」の管理パネルから、プロンプトを表示 → 手元のAIで作成 →
  //   貼り付け → その型の全宛先へ適用、の流れで入れる。

  return (
    <div className="space-y-3">
      <div className="flex rounded-md border border-gray-200 p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setTab("campaign")}
          className={`flex-1 rounded px-2 py-1 ${tab === "campaign" ? "bg-indigo-600 text-white" : "text-gray-600"}`}
        >
          全体
        </button>
        <button
          type="button"
          onClick={() => setTab("draft")}
          className={`flex-1 rounded px-2 py-1 ${tab === "draft" ? "bg-indigo-600 text-white" : "text-gray-600"}`}
        >
          この通
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {variant && (
        <dl className="space-y-1 text-xs text-gray-600">
          <Row k="デザイン" v={labelOf(DESIGN_OPTIONS, variant.designTemplate)} />
          <Row k="トーン" v={labelOf(TONE_OPTIONS, variant.tone)} />
          <Row k="長さ" v={labelOf(LENGTH_OPTIONS, variant.length)} />
          <Row k="訴求" v={labelOf(APPEAL_OPTIONS, variant.appeal)} />
          <Row k="強さ" v={labelOf(STRENGTH_OPTIONS, variant.strength)} />
          <Row k="型" v={variant.label} />
        </dl>
      )}

      {target.scope === "draft" && selected ? (
        <div className="space-y-2">
          {campaign.variants.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-gray-500">
              この宛先の型
              <select
                value={selected.variantId}
                onChange={changeVariant}
                disabled={busy}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 disabled:opacity-50"
              >
                {campaign.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <textarea
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            data-pii-protected
            data-pii-surface="owner"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveBody}
              disabled={busy || bodyDraft === selected.body}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              この通を保存
            </button>
            <span className="text-[11px] text-gray-500">
              文面を作り直すときは、型の管理から「文面」を開いてください
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          全体の型(デザイン・トーン等)はキャンペーン作成時の設定です。個別調整は「この通」タブで行います。
        </p>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-400">{k}</dt>
      <dd className="font-medium text-gray-700">{v}</dd>
    </div>
  );
}
