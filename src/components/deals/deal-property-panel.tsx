"use client";

import { useState } from "react";
import Link from "next/link";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { snapshotFormFromDeal, snapshotFromForm, type SnapshotForm } from "@/lib/deals/forms";
import type { DealView } from "@/lib/deals/view";
import { LAND_RIGHT_LABELS } from "@/lib/deals/constants";
import { AssessmentsEditor } from "./assessments-editor";
import type { Assessments } from "@/lib/deals/schemas";

const TEXT_FIELDS: [keyof SnapshotForm, string, number][] = [
  ["buildingName", "物件名", 200], ["roomNo", "号室", 50], ["address", "住居表示", 300], ["lotNumber", "所在・地番", 300],
  ["buildingNumber", "家屋番号", 100], ["propertyTypeLabel", "種類", 50], ["structure", "構造", 100],
  ["access", "交通", 500], ["layout", "間取り", 50],
];
const NUMBER_FIELDS: [keyof SnapshotForm, string][] = [
  ["builtYear", "築年(西暦)"], ["builtMonth", "築月"], ["floorArea", "延床面積(区分は専有面積)㎡"], ["landArea", "土地面積㎡"],
];

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

export default function DealPropertyPanel({
  deal, canOpenProperty, onSaved,
}: { deal: DealView; canOpenProperty: boolean; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<SnapshotForm>(() => snapshotFormFromDeal(deal));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assessments, setAssessments] = useState<Assessments>(deal.assessments);
  const set = (k: keyof SnapshotForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty =
    JSON.stringify(snapshotFromForm(form)) !== JSON.stringify(deal.propertySnapshot) ||
    JSON.stringify(assessments) !== JSON.stringify(deal.assessments);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {deal.propertyId ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 dark:text-gray-400">登録済みの物件から写しています。</span>
          {canOpenProperty && (
            <>
              <Link href={`/properties/${deal.propertyId}`} className="text-indigo-700 hover:underline dark:text-indigo-400">物件を開く</Link>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                <RefreshCw className="h-4 w-4" />
                物件から取り直す
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-400">手入力の物件です(物件の一覧には登録しません)。</p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {TEXT_FIELDS.map(([k, label, max]) => (
          <Field key={k} label={label}>
            <input value={form[k]} onChange={(e) => set(k, e.target.value)} maxLength={max} aria-label={label} className={inputCls} />
          </Field>
        ))}
        {NUMBER_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <input inputMode="decimal" value={form[k]} onChange={(e) => set(k, e.target.value)} aria-label={label} className={inputCls} />
          </Field>
        ))}
        <Field label="土地の権利">
          <SelectBox label="土地の権利" value={form.landRight} onChange={(v) => set("landRight", v)} options={optionsOf(LAND_RIGHT_LABELS)} allowEmpty />
        </Field>
      </div>

      <AssessmentsEditor value={assessments} onChange={setAssessments} />

      <Button
        onClick={() => run(() => dealsApi.update(deal.id, { version: deal.version, propertySnapshot: snapshotFromForm(form), assessments, }))}
        disabled={busy || !dirty} loading={busy} loadingLabel="保存中"
      >
        <Save className="h-4 w-4" />
        保存
      </Button>

      {confirming && (
        <ConfirmDialog
          title="物件から取り直しますか？"
          message="物件の今の情報で、この画面の項目を上書きします。ここで手直しした内容は消えます。"
          confirmLabel="取り直す"
          onConfirm={() => { setConfirming(false); void run(() => dealsApi.refreshProperty(deal.id, deal.version)); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
