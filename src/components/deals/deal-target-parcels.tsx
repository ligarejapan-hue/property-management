"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DealParcelOption } from "@/lib/deals/target-parcels";

/** 初めに印を付けるもの。保存してある選びのうち今も物件にあるもの。無ければ全部(サーバーの読み方と同じ)。 */
export function initialParcelSelection(options: readonly DealParcelOption[], target: readonly string[] | null): string[] {
  const kept = target ? options.filter((o) => target.includes(o.key)).map((o) => o.key) : [];
  return kept.length ? kept : options.map((o) => o.key);
}

/**
 * この取引の土地・建物(2026-11-06 発注者 案A 3回目)。2筆以上・2棟以上の物件の取引にだけ出す。
 * 選んだものだけが、物件タブの所在・地番/家屋番号(書類に出る)と、照合・段取り・書類確認書の謄本の見方に入る。
 * ⚠ほかの項目を直している途中(dirtyElsewhere)は保存させない(保存すると画面が読み直され、その入力が消える)。
 */
export default function DealTargetParcels({
  options, target, dirtyElsewhere, busy, onSave,
}: {
  options: DealParcelOption[];
  target: string[] | null;
  dirtyElsewhere: boolean;
  busy: boolean;
  onSave: (keys: string[] | null) => void;
}) {
  const [picked, setPicked] = useState<string[]>(() => initialParcelSelection(options, target));
  if (!options.length) return null;
  const initial = initialParcelSelection(options, target);
  const dirty = picked.length !== initial.length || picked.some((k) => !initial.includes(k));
  const toggle = (key: string) => setPicked((cur) => (
    cur.includes(key) ? cur.filter((k) => k !== key) : options.filter((o) => o.key === key || cur.includes(o.key)).map((o) => o.key)
  ));

  return (
    <fieldset className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">この取引の土地・建物</legend>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        分筆して一部だけ売るときなどに、この取引で扱う土地・建物を選びます。選んだものだけが、下の所在・地番と家屋番号（書類に出ます）、数値照合・段取り・書類確認書の謄本の確認に入ります。
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {options.map((o) => (
          <label key={o.key} className="flex items-center gap-1.5 text-sm text-gray-800 dark:text-gray-200">
            <input type="checkbox" checked={picked.includes(o.key)} onChange={() => toggle(o.key)} disabled={busy} />
            {o.label}
          </label>
        ))}
      </div>
      {picked.length === 0 && <p className="text-xs text-red-600 dark:text-red-400" role="alert">1つ以上選んでください。</p>}
      {dirty && dirtyElsewhere && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">先に下の項目を保存してください（保存すると、直している途中の入力が消えるため）。</p>
      )}
      <Button
        variant="secondary" size="sm"
        disabled={busy || !dirty || picked.length === 0 || dirtyElsewhere}
        onClick={() => onSave(picked.length === options.length ? null : picked)}
      >
        <Save className="h-4 w-4" />
        選んだ土地・建物を保存（所在・地番と家屋番号も入れ直す）
      </Button>
    </fieldset>
  );
}
