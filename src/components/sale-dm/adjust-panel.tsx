"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import type { SaleDmCampaign, SaleDmDraft, SaleDmScenarioOption } from "@/lib/api-client";
import {
  patchSaleDmDraft,
  changeSaleDmPropertyScenario,
  fetchSaleDmScenarioOptions,
  apiErrorCode,
  USE_MOCK,
} from "@/lib/api-client";
import {
  isScenarioCampaignView,
  scenarioChangeConfirmText,
  scenarioFixLinkFor,
} from "@/lib/sale-dm-letter/scenario-campaign-ui";
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
  scenarioChangeReady = false,
}: {
  campaign: SaleDmCampaign;
  selected: SaleDmDraft | null;
  onChanged: () => void;
  /** 画面の合言葉の複製タブ確認が済んだか(useEditScreenToken の tokenReady)。済むまで「種類を変える」を押させない。 */
  scenarioChangeReady?: boolean;
}) {
  const [tab, setTab] = useState<AdjustTab>("campaign");
  const [bodyDraft, setBodyDraft] = useState(selected?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 種類つきの発送(DMの種類 PR-S2): 宛先ごとの「型」の選択の代わりに、物件ごとの「種類を変える」を出す。
  const scenario = isScenarioCampaignView(campaign);
  const { data: session } = useSession();
  const isAdmin = USE_MOCK || (session?.user as { role?: string } | undefined)?.role === "admin";
  const [scenarioOptions, setScenarioOptions] = useState<SaleDmScenarioOption[] | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // 選択肢の口(有効な種類・ready だけ)。変える操作のあとは必ず取り直す(まだ使える前提にしない)。
  const loadScenarioOptions = useCallback(async () => {
    try {
      setScenarioOptions(await fetchSaleDmScenarioOptions());
    } catch {
      setScenarioOptions([]);
    }
  }, []);
  useEffect(() => {
    if (scenario) loadScenarioOptions();
  }, [scenario, loadScenarioOptions]);

  useEffect(() => {
    setBodyDraft(selected?.body ?? "");
    // 宛先を切り替えたら前の宛先で出たエラー表示を消す(別宛先に古いエラーが残らないように)。
    setError(null);
    setErrorCode(null);
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

  // 「種類を変える」(物件単位): この発送のこの物件の宛先を全員まとめて、選んだ種類の手紙とLPへ切り替える。
  // 物件の「DMの種類」欄も変わる。409/423 はサーバーのメッセージをそのまま出す。
  const propertyRecipients = selected ? campaign.recipients.filter((r) => r.propertyId === selected.propertyId) : [];
  const propertyHasSent = propertyRecipients.some((r) => r.status === "sent");
  const changeScenario = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!selected || !scenarioChangeReady) return;
    const scenarioId = e.target.value;
    if (!scenarioId || scenarioId === (variant?.scenarioId ?? null)) return;
    if (!window.confirm(scenarioChangeConfirmText(propertyRecipients.length))) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      await changeSaleDmPropertyScenario(campaign.id, selected.propertyId, scenarioId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "種類の変更に失敗しました");
      setErrorCode(apiErrorCode(err));
    } finally {
      setBusy(false);
      // 成功でも失敗でも選択肢を取り直す(選んだ種類が使えなくなっていても 200 のことがある)。
      loadScenarioOptions();
    }
  };
  const fixLink = scenarioFixLinkFor(errorCode);

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

      {error && (
        <div role="alert" className="text-xs text-red-600">
          <p>{error}</p>
          {isAdmin && fixLink && (
            <Link href={fixLink.href} className="font-semibold underline underline-offset-2">
              {fixLink.label}
            </Link>
          )}
        </div>
      )}

      {variant && (
        <dl className="space-y-1 text-xs text-gray-600">
          <Row k="デザイン" v={labelOf(DESIGN_OPTIONS, variant.designTemplate)} />
          <Row k="トーン" v={labelOf(TONE_OPTIONS, variant.tone)} />
          <Row k="長さ" v={labelOf(LENGTH_OPTIONS, variant.length)} />
          <Row k="訴求" v={labelOf(APPEAL_OPTIONS, variant.appeal)} />
          <Row k="強さ" v={labelOf(STRENGTH_OPTIONS, variant.strength)} />
          <Row k={scenario ? "DMの種類" : "型"} v={variant.label} />
        </dl>
      )}

      {target.scope === "draft" && selected ? (
        <div className="space-y-2">
          {scenario && (
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              <span>種類を変える(この物件の宛先 {propertyRecipients.length} 人をまとめて)</span>
              <select
                value={variant?.scenarioId ?? ""}
                onChange={changeScenario}
                disabled={busy || propertyHasSent || scenarioOptions === null || !scenarioChangeReady}
                title={propertyHasSent ? "送付済みの宛先がいる物件は、種類を変えられません" : undefined}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 disabled:opacity-50"
              >
                {/* 今の種類が使えなくなっていても、今の値として見せる(選び直しは可) */}
                {variant?.scenarioId && !(scenarioOptions ?? []).some((o) => o.id === variant.scenarioId) && (
                  <option value={variant.scenarioId} disabled>
                    {variant.label}
                  </option>
                )}
                {(scenarioOptions ?? []).map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.ready}>
                    {o.name}
                    {o.ready ? "" : "(手紙が未登録)"}
                  </option>
                ))}
              </select>
              {propertyHasSent && <span className="text-amber-700">送付済みの宛先がいる物件は、種類を変えられません。</span>}
            </label>
          )}
          {!scenario && campaign.variants.length > 1 && (
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
