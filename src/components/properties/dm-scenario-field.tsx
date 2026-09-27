"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchSaleDmScenarioOptions, type SaleDmScenarioOption } from "@/lib/api-client";
import { runNoLockPropertyPatch } from "@/app/(dashboard)/properties/[id]/page";
import { dmScenarioFieldView, DM_SCENARIO_UNAVAILABLE_LABEL } from "./dm-scenario-field-model";

/**
 * 物件の「DMの種類」欄(設計 2026-09-27 §3.6)。導入ルートの欄(IntroductionRouteField)と同じ形。
 * 空欄=「自動」(受付帳取込→相続・現地調査→空き家。決まらなければ発送のときに選ぶ既定の種類)。
 * 選択肢は選択肢の口(id・名前だけ)から取る。台帳の中身(文面・設定)は読まない。
 * 保存は案件ステータス・導入ルートと同じ鍵なし保存(runNoLockPropertyPatch)を通す。
 * 保存の直前に管理者が種類を「使わない」/削除していたら、サーバーが 409 で断る
 * (「選んだDMの種類は使えなくなりました」)。その後は選択肢を読み直す。
 */
export default function DmScenarioField({
  property,
  onRefresh,
  canWrite,
  editLockHeld,
}: {
  property: { id: string; version: number; dmScenarioId: string | null; introductionRoute: string | null };
  onRefresh: () => void;
  canWrite: boolean;
  /** 見ている側。物件が他の人の鍵ならプルダウンを止める。 */
  editLockHeld: boolean;
}) {
  const [options, setOptions] = useState<SaleDmScenarioOption[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 呼び出し元が持つ世代(案件ステータス・導入ルートの欄と同じ)。
  const saveSeqRef = useRef(0);

  const loadOptions = useCallback(
    () =>
      fetchSaleDmScenarioOptions()
        .then((next) => { setOptions(next); setLoadFailed(false); })
        .catch(() => setLoadFailed(true)),
    [],
  );
  useEffect(() => { void loadOptions(); }, [loadOptions]);

  const handleChange = async (value: string) => {
    await runNoLockPropertyPatch(
      property.id,
      property.version,
      { dmScenarioId: value || null },
      setSaving,
      setError,
      onRefresh,
      saveSeqRef,
    );
    // 断られた(使えなくなった種類を選んでいた等)ときに、いまの選択肢へ揃える。
    void loadOptions();
  };

  const view = options ? dmScenarioFieldView(property, options) : null;
  const heading = (
    <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">DMの種類</dt>
  );

  if (!canWrite) {
    const text = view ? view.label : property.dmScenarioId ? "設定あり" : "自動";
    return (
      <div>
        {heading}
        <dd className="text-sm text-gray-900 dark:text-gray-100">{text}</dd>
      </div>
    );
  }

  return (
    <div>
      {heading}
      <dd>
        {!options ? (
          loadFailed ? (
            <span className="text-xs text-red-600 dark:text-red-400">DMの種類の選択肢を読み込めませんでした</span>
          ) : (
            <Loader2 className="inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />
          )
        ) : (
          <>
            <select
              value={property.dmScenarioId ?? ""}
              onChange={(e) => void handleChange(e.target.value)}
              disabled={saving || editLockHeld}
              aria-label="DMの種類"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">{view!.autoLabel}</option>
              {view!.unavailable && property.dmScenarioId && (
                <option value={property.dmScenarioId} disabled>(使えなくなった種類)</option>
              )}
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            {saving && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />}
            {view!.unavailable && !error && (
              <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">{DM_SCENARIO_UNAVAILABLE_LABEL}</span>
            )}
          </>
        )}
        {error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
      </dd>
    </div>
  );
}
