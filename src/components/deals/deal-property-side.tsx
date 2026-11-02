"use client";

import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { ExternalLink, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import PropertyEditForm from "@/components/properties/property-edit-form";
import { ownerSideRows, propertySideRows, type OwnerSideSource, type PropertySideSource } from "@/lib/deals/property-side";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; property: PropertySideSource };

const Rows = ({ rows }: { rows: { label: string; value: string }[] }) => (
  <dl className="space-y-2.5 text-sm">
    {rows.map((row) => (
      <div key={row.label}>
        <dt className="text-xs text-gray-500 dark:text-gray-400">{row.label}</dt>
        <dd className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{row.value}</dd>
      </div>
    ))}
  </dl>
);

function Loading({ state }: { state: Exclude<LoadState, { kind: "ok" }> }) {
  if (state.kind === "loading") {
    return <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</p>;
  }
  return <p className="text-sm text-red-600 dark:text-red-400" role="alert">物件の情報を読み込めませんでした。</p>;
}

/** 読み込みが済んだあとの中身(見るだけ)。 */
export function DealPropertySideBody({ state }: { state: LoadState }) {
  if (state.kind !== "ok") return <Loading state={state} />;
  return <Rows rows={propertySideRows(state.property)} />;
}

/** 物件の所有者(見るだけ)。当事者タブの横に出す。⚠値は API が権限で伏せたまま。 */
export function DealOwnerSideBody({ state }: { state: LoadState }) {
  if (state.kind !== "ok") return <Loading state={state} />;
  const owners: OwnerSideSource[] = state.property.propertyOwners ?? [];
  if (owners.length === 0) return <p className="text-sm text-gray-500">この物件に所有者は登録されていません。</p>;
  const people = owners.map((po) => ({ id: po.owner.id, isPrimary: po.isPrimary === true, rows: ownerSideRows(po) }));
  // 所有者を読めない人には id しか届かない。
  if (people.every((p) => p.rows.length === 0)) return <p className="text-sm text-gray-500">所有者情報を見る権限がありません。</p>;
  return (
    <ul className="space-y-4">
      {people.map((p, i) => (
        <li key={p.id} className="space-y-2 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0 dark:border-gray-800">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-400">所有者{people.length > 1 ? ` ${i + 1}` : ""}{p.isPrimary && people.length > 1 ? "(主)" : ""}</p>
          <Rows rows={p.rows} />
        </li>
      ))}
    </ul>
  );
}

/**
 * 取引の画面の横に並べる物件の情報。広い画面は右に並び、狭い画面は上に重なる。
 * 当事者タブでは所有者を出す。編集できる人には基本情報の編集を出す(鍵・下書きは物件の画面と同じ部品)。
 * key に取引の状態を入れて開き直す=連動で変わった案件ステータスを読み直す。
 */
export default function DealPropertySide({
  propertyId, view = "property", canEdit = false, onEditingChange, onClose,
}: {
  propertyId: string;
  view?: "property" | "owners";
  canEdit?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/properties/${propertyId}`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as PropertySideSource;
  }, [propertyId]);

  useEffect(() => {
    let alive = true;
    load()
      .then((property) => { if (alive) setState({ kind: "ok", property }); })
      .catch(() => { if (alive) setState({ kind: "error" }); });
    return () => { alive = false; };
  }, [load]);

  const changeEditing = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };
  const title = editing || view === "property" ? "物件の基本情報" : "物件の所有者";

  return (
    <aside
      aria-label={title}
      className="space-y-3 overflow-y-auto border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:pt-16 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:rounded-lg lg:border"
    >
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
        {canEdit && !editing && view === "property" && state.kind === "ok" && (
          <Button variant="secondary" size="sm" onClick={() => { setSaved(false); changeEditing(true); }}>
            <Pencil className="h-4 w-4" />
            編集
          </Button>
        )}
      </div>
      {saved && !editing && (
        <p className="text-xs text-gray-600 dark:text-gray-400" role="status">
          物件を保存しました。取引の「物件」タブへ入れるときは「物件から取り直す」を押してください。
        </p>
      )}
      {editing && state.kind === "ok" ? (
        <PropertyEditForm
          embedded
          // 物件の画面と同じ API の返事。編集の部品は必要な項目をこの中から読む。
          property={state.property as unknown as ComponentProps<typeof PropertyEditForm>["property"]}
          onClose={() => changeEditing(false)}
          onSaved={() => {
            changeEditing(false);
            setSaved(true);
            setState({ kind: "loading" });
            void load()
              .then((property) => setState({ kind: "ok", property }))
              .catch(() => setState({ kind: "error" }));
          }}
        />
      ) : view === "owners" ? (
        <DealOwnerSideBody state={state} />
      ) : (
        <DealPropertySideBody state={state} />
      )}
    </aside>
  );
}
