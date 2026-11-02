"use client";

import { type ComponentProps, useEffect, useState } from "react";
import { Edit, ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BuildingLinkNotice } from "@/components/buildings/building-link-notice";
import PropertyEditForm from "@/components/properties/property-edit-form";
import type { BuildingLinkOutcome } from "@/lib/building-link/apply";
import { ownerSideView, propertySideRows, type PropertySideSource, type SideOwnerLink } from "@/lib/deals/property-side";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; property: PropertySideSource };

/** 読み込みが済んだあとの中身(見るだけ)。編集は「編集」を押してから。 */
export function DealPropertySideBody({ state }: { state: LoadState }) {
  if (state.kind === "loading") {
    return <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400" role="alert">物件の情報を読み込めませんでした。</p>;
  }
  return <SideRows rows={propertySideRows(state.property)} />;
}

function SideRows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="space-y-2.5 text-sm">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{row.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 所有者情報(見るだけ)。値はサーバーが表示レベルで伏せたものをそのまま出す。 */
export function DealOwnerSideBody({ links }: { links: SideOwnerLink[] | undefined }) {
  const view = ownerSideView(links);
  if (view.kind === "forbidden") return <p className="text-sm text-gray-500 dark:text-gray-400">所有者情報を見る権限がありません。</p>;
  if (view.kind === "none") return <p className="text-sm text-gray-500 dark:text-gray-400">この物件に所有者は登録されていません。</p>;
  return (
    <ul className="space-y-4 divide-y divide-gray-100 dark:divide-gray-800">
      {view.owners.map((o) => <li key={o.key} className="pt-4 first:pt-0"><SideRows rows={o.rows} /></li>)}
    </ul>
  );
}

type EditTarget = ComponentProps<typeof PropertyEditForm>["property"];

/**
 * 取引の画面の横に並べる物件の基本情報。当事者タブの間は所有者情報を出す。広い画面は右に並び、狭い画面は上に重なる。
 * revision(取引の状態)が変わったら読み直す=連動で変わった案件ステータスを出す。編集中の入力は消さない。
 * 編集は物件の画面と同じ部品(編集中の鍵・版の番号の決まりもそのまま)。
 */
export default function DealPropertySide({
  propertyId, revision, mode = "property", canEdit = false, canEditInquirer = false, onEditingChange, onSaved, onClose,
}: {
  propertyId: string; revision?: string; mode?: "property" | "owners"; canEdit?: boolean; canEditInquirer?: boolean;
  onEditingChange?: (editing: boolean) => void; onSaved?: () => void; onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [savedTick, setSavedTick] = useState(0);
  // 開いた時点の物件で編集する(読み直しで入力中の部品へ別の版を渡さない)。
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [buildingNotice, setBuildingNotice] = useState<BuildingLinkOutcome | null>(null);
  const title = mode === "owners" ? "所有者情報" : "物件の基本情報";

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
  }, [propertyId, revision, savedTick]);

  // 欄ごと消えたときに「編集中」を残さない(開閉のボタンが押せないままになる)。
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);

  const startEdit = (property: PropertySideSource) => {
    setEditing(property as unknown as EditTarget);
    onEditingChange?.(true);
  };
  const stopEdit = () => {
    setEditing(null);
    onEditingChange?.(false);
  };

  return (
    <aside
      aria-label={editing ? "物件の編集" : title}
      className="space-y-3 overflow-y-auto border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:pt-16 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:rounded-lg lg:border"
    >
      {editing ? (
        <PropertyEditForm
          embedded property={editing} canEditInquirer={canEditInquirer && editing.inquirerName !== undefined}
          onClose={stopEdit}
          onSaved={(r) => { stopEdit(); setBuildingNotice(r?.buildingLink ?? null); setSavedTick((t) => t + 1); onSaved?.(); }}
        />
      ) : (
        <>
          <BuildingLinkNotice outcome={buildingNotice} onClose={() => setBuildingNotice(null)} />
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={`${title}を閉じる`}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/properties/${propertyId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-indigo-700 hover:underline dark:text-indigo-400"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              物件の画面を別のタブで開く
            </a>
            {canEdit && mode === "property" && state.kind === "ok" && (
              <Button variant="secondary" size="sm" onClick={() => startEdit(state.property)}>
                <Edit className="h-4 w-4" />
                編集
              </Button>
            )}
          </div>
          {mode === "owners" && state.kind === "ok"
            ? <DealOwnerSideBody links={state.property.propertyOwners} />
            : <DealPropertySideBody state={state} />}
        </>
      )}
    </aside>
  );
}
