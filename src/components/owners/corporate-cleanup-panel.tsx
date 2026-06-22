"use client";
import { useState } from "react";
import {
  fetchCorporateCleanupPreview,
  applyCorporateCleanup,
  type CorporateCleanupPreview,
} from "@/lib/corporate-cleanup-client";

interface Props {
  ownerId: string;
  onApplied: () => void;
}

type Field = "name" | "address" | "note" | "corporateNumber";
const FIELD_LABEL: Record<Field, string> = {
  name: "氏名",
  address: "住所",
  note: "備考",
  corporateNumber: "法人番号(列へ移送)",
};

export default function CorporateCleanupPanel({ ownerId, onApplied }: Props) {
  const [preview, setPreview] = useState<CorporateCleanupPreview | null>(null);
  const [checked, setChecked] = useState<Record<Field, boolean>>({
    name: false,
    address: false,
    note: false,
    corporateNumber: false,
  });
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onCheck() {
    setLoading(true);
    setError(null);
    setDone(false);
    setPreview(null);
    try {
      const p = await fetchCorporateCleanupPreview(ownerId);
      setPreview(p);
      const init: Record<Field, boolean> = {
        name: false,
        address: false,
        note: false,
        corporateNumber: false,
      };
      for (const f of p.changedFields) {
        init[f as Field] = true;
      }
      setChecked(init);
    } catch (e) {
      setError(e instanceof Error ? e.message : "チェックに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function onApply() {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      await applyCorporateCleanup(ownerId, {
        version: preview.version,
        apply: checked,
      });
      setDone(true);
      setPreview(null);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "反映に失敗しました");
    } finally {
      setApplying(false);
    }
  }

  const anyChecked =
    checked.name || checked.address || checked.note || checked.corporateNumber;

  return (
    // プレビューの before/after は raw-visible な owner 氏名/住所/備考(PII)を含み得るため、
    // 既存の screen-protection guard(copy/cut/contextmenu 抑止)が効くよう PII 保護領域にする。
    <div
      className="rounded border border-gray-200 p-3 text-sm dark:border-gray-800 dark:bg-gray-900"
      data-pii-protected
      data-pii-surface="owner"
    >
      <button
        type="button"
        onClick={onCheck}
        disabled={loading}
        className="rounded bg-slate-100 px-3 py-1"
      >
        {loading ? "確認中…" : "法人番号の混入をチェック"}
      </button>

      {done && <p className="mt-2 text-emerald-700">混入を除去しました</p>}
      {error && <p className="mt-2 text-red-600">{error}</p>}

      {preview && preview.action === "none" && (
        <p className="mt-2 text-slate-500 dark:text-slate-400">混入は検出されませんでした</p>
      )}

      {preview && preview.action === "manual" && (
        <p className="mt-2 text-amber-700">
          自動除去できません(手動対応が必要):{" "}
          {preview.manualReason === "multi"
            ? "複数候補"
            : "氏名が空になるため"}
        </p>
      )}

      {preview && preview.action === "cleanup" && (
        <div className="mt-2 space-y-2">
          <div className="text-slate-600 space-y-1 dark:text-gray-300">
            {(["name", "address", "note"] as const)
              .filter((f) => preview.changedFields.includes(f))
              .map((f) => {
                const key = `${f}Masked` as
                  | "nameMasked"
                  | "addressMasked"
                  | "noteMasked";
                return (
                  <div key={f}>
                    {FIELD_LABEL[f]}: {preview.before[key] ?? "(空)"} →{" "}
                    {preview.after[key] ?? "(空)"}
                  </div>
                );
              })}
            {preview.corporateNumberToSetMasked && (
              <div>法人番号 → {preview.corporateNumberToSetMasked}</div>
            )}
          </div>
          {preview.changedFields.map((f) => (
            <label key={f} className="block">
              <input
                type="checkbox"
                checked={checked[f as Field]}
                onChange={() =>
                  setChecked((c) => ({ ...c, [f]: !c[f as Field] }))
                }
              />
              <span className="ml-1">{FIELD_LABEL[f as Field]}</span>
            </label>
          ))}
          <button
            type="button"
            onClick={onApply}
            disabled={applying || !anyChecked}
            className="rounded bg-blue-600 px-3 py-1 text-white"
          >
            {applying ? "反映中…" : "選択した項目を反映"}
          </button>
        </div>
      )}
    </div>
  );
}
