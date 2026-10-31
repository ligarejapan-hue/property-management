"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { propertySideRows, type PropertySideSource } from "@/lib/deals/property-side";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; property: PropertySideSource };

/** 読み込みが済んだあとの中身(見るだけ)。編集は物件の画面で行う。 */
export function DealPropertySideBody({ state }: { state: LoadState }) {
  if (state.kind === "loading") {
    return <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400" role="alert">物件の情報を読み込めませんでした。</p>;
  }
  return (
    <dl className="space-y-2.5 text-sm">
      {propertySideRows(state.property).map((row) => (
        <div key={row.label}>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{row.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 取引の画面の横に並べる物件の基本情報。広い画面は右に並び、狭い画面は上に重なる。
 * key に取引の状態を入れて開き直す=連動で変わった案件ステータスを読み直す。
 */
export default function DealPropertySide({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    fetch(`/api/properties/${propertyId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as PropertySideSource;
      })
      .then((property) => { if (alive) setState({ kind: "ok", property }); })
      .catch(() => { if (alive) setState({ kind: "error" }); });
    return () => { alive = false; };
  }, [propertyId]);

  return (
    <aside
      aria-label="物件の基本情報"
      className="space-y-3 overflow-y-auto border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:pt-16 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:rounded-lg lg:border"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">物件の基本情報</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="物件の基本情報を閉じる">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <a
        href={`/properties/${propertyId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-indigo-700 hover:underline dark:text-indigo-400"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        物件の画面を別のタブで開く
      </a>
      <DealPropertySideBody state={state} />
    </aside>
  );
}
