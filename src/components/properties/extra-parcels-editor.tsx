"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeRandomId } from "@/lib/random-id";
import { PARCEL_KINDS, type ParcelKind } from "@/lib/property-parcels";

/** 編集画面の1行(欄は文字のまま持つ・面積も文字=打ちかけの「61.」を消さない)。 */
export interface ParcelRow { id: string; kind: ParcelKind; location: string; number: string; realEstateNumber: string; area: string }

const inputCls =
  "w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
const LINK_CLS = "inline-flex items-center gap-1 text-xs font-medium text-blue-700 underline hover:no-underline dark:text-blue-300";

/** 編集の欄の文字(JSON) → 行。空・読めないときは空の一覧。 */
export function parcelRowsOf(value: string | undefined): ParcelRow[] {
  if (!value) return [];
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r) => (r && typeof r === "object" && typeof (r as ParcelRow).id === "string" ? [{
      id: (r as ParcelRow).id,
      kind: (r as ParcelRow).kind === "building" ? "building" : "land",
      location: String((r as ParcelRow).location ?? ""),
      number: String((r as ParcelRow).number ?? ""),
      realEstateNumber: String((r as ParcelRow).realEstateNumber ?? ""),
      area: String((r as ParcelRow).area ?? ""),
    } as ParcelRow] : []));
  } catch {
    return [];
  }
}

/** 行 → 編集の欄の文字。行が無ければ空文字(開いた時点の「足していない」と同じに比べる)。 */
export const parcelRowsValue = (rows: ParcelRow[]): string => (rows.length ? JSON.stringify(rows) : "");

/** 足した行の面積の合計(㎡・小数2桁)。その種類の行が無い・どれか読めなければ null。 */
export function rowsAreaTotal(rows: ParcelRow[], kind: ParcelKind): number | null {
  const of = rows.filter((r) => r.kind === kind).map((r) => r.area.normalize("NFKC").replace(/,/g, "").trim());
  if (!of.length || of.some((s) => !/^\d+(\.\d{1,2})?$/.test(s))) return null;
  return of.reduce((n, s) => n + Math.round(Number(s) * 100), 0) / 100;
}

/**
 * 2筆目以降の土地・2棟目以降の建物(2026-11-05 案A 1回目)。足していない物件は「土地・建物を足す」のリンクだけ。
 * 1筆目・1棟目は上の地番・家屋番号の欄のまま。土地面積・建物面積の欄は今までどおり物件全体の値(足した行の合計は知らせるだけ)。
 */
export function ExtraParcelsEditor({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const rows = parcelRowsOf(value);
  const set = (next: ParcelRow[]) => onChange(parcelRowsValue(next));
  const patch = (id: string, p: Partial<ParcelRow>) => set(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const add = () => set([...rows, { id: safeRandomId(), kind: "land", location: "", number: "", realEstateNumber: "", area: "" }]);

  if (!rows.length) {
    return (
      <Button variant="ghost" size="sm" onClick={add} className={LINK_CLS}>
        <Plus className="h-3.5 w-3.5" />
        土地・建物を足す(2筆目・2棟目がある物件)
      </Button>
    );
  }
  const totals = ([["land", "土地", "土地面積"], ["building", "建物", "建物面積(延べ)"]] as const)
    .map(([kind, name, field]) => ({ kind, name, field, total: rowsAreaTotal(rows, kind) }))
    .filter((t) => t.total !== null);
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">ほかの土地・建物(1筆目・1棟目は上の地番・家屋番号の欄)</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="w-20 pb-1 font-medium">種類</th><th className="pb-1 font-medium">所在</th><th className="w-28 pb-1 font-medium">地番・家屋番号</th>
              <th className="w-32 pb-1 font-medium">不動産番号</th><th className="w-24 pb-1 font-medium">面積(㎡)</th><th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="align-top">
                <td className="pr-1 pb-1">
                  <select value={r.kind} onChange={(e) => patch(r.id, { kind: e.target.value === "building" ? "building" : "land" })} aria-label={`${i + 2}件目の種類`} className={inputCls}>
                    {(Object.keys(PARCEL_KINDS) as ParcelKind[]).map((k) => <option key={k} value={k}>{PARCEL_KINDS[k]}</option>)}
                  </select>
                </td>
                <td className="pr-1 pb-1"><input value={r.location} onChange={(e) => patch(r.id, { location: e.target.value })} placeholder="空なら物件の住所と同じ" aria-label={`${i + 2}件目の所在`} className={inputCls} /></td>
                <td className="pr-1 pb-1"><input value={r.number} onChange={(e) => patch(r.id, { number: e.target.value })} aria-label={`${i + 2}件目の地番・家屋番号`} className={inputCls} /></td>
                <td className="pr-1 pb-1"><input value={r.realEstateNumber} onChange={(e) => patch(r.id, { realEstateNumber: e.target.value })} inputMode="numeric" aria-label={`${i + 2}件目の不動産番号`} className={inputCls} /></td>
                <td className="pr-1 pb-1"><input value={r.area} onChange={(e) => patch(r.id, { area: e.target.value })} inputMode="decimal" aria-label={`${i + 2}件目の面積`} className={inputCls} /></td>
                <td className="pb-1">
                  <Button variant="ghost" size="sm" onClick={() => set(rows.filter((x) => x.id !== r.id))} aria-label={`${i + 2}件目を消す`} className="text-gray-400 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button variant="ghost" size="sm" onClick={add} className={LINK_CLS}><Plus className="h-3.5 w-3.5" />行を足す</Button>
      {totals.map((t) => (
        <p key={t.kind} className="text-xs text-gray-600 dark:text-gray-400">
          ここで足した{t.name}の面積の合計 {t.total}㎡(「{t.field}」の欄には、1{t.kind === "land" ? "筆" : "棟"}目と合わせた物件全体の面積を入れてください)
        </p>
      ))}
    </div>
  );
}
