"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatYenText, manToYen } from "@/lib/yen-man";

interface SaleTaxSource {
  salePrice?: number | null;
  saleTaxType?: string | null;
  saleTaxAmount?: number | null;
}

/** 表示の行(物件の販売価格・消費税・うち消費税)。万円で保存しているので円で出す。 */
export function saleTaxRows(p: SaleTaxSource): { label: string; value: string }[] {
  const yen = (v: number | null | undefined) => (v == null ? "—" : formatYenText(manToYen(v)));
  return [
    { label: "販売価格", value: yen(p.salePrice) },
    { label: "消費税", value: p.saleTaxType || "(未設定)" },
    { label: "うち消費税", value: yen(p.saleTaxAmount) },
  ];
}

/**
 * 金額・費用タブの「物件の販売価格と消費税」(2026-11-04 発注者「この画面でも見れる・編集できるように」)。
 * 物件の値を見せ、「編集」で横に物件の編集を開いて消費税の欄まで送る(編集中の鍵・下書きは物件の編集の部品が持つ)。
 * revision が変わったら読み直す(横の編集を閉じたとき)。
 */
export function DealPropertySaleTax({
  propertyId, revision, canEdit, onEdit,
}: { propertyId: string; revision: string; canEdit: boolean; onEdit: () => void }) {
  const [source, setSource] = useState<SaleTaxSource | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/properties/${propertyId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const p = (await res.json()) as SaleTaxSource;
        if (alive) { setSource(p); setFailed(false); }
      })
      // 読み直しの失敗で、見えている値を消さない。
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [propertyId, revision]);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">物件の販売価格と消費税</h3>
        {canEdit && (
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            編集
          </Button>
        )}
      </div>
      {source ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {saleTaxRows(source).map((r) => (
            <div key={r.label}>
              <dt className="text-xs text-gray-500 dark:text-gray-400">{r.label}</dt>
              <dd className="tabular-nums text-gray-900 dark:text-gray-100">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-gray-500">{failed ? "物件を読み込めませんでした" : "読み込み中…"}</p>
      )}
      <p className="text-xs text-gray-500">物件の値です。「編集」で横に物件の編集を開きます(消費税の課税・不課税もそこで選べます)。</p>
    </section>
  );
}
