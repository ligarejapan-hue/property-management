"use client";

import { PARCEL_KINDS, type ExtraParcel } from "@/lib/property-parcels";

/**
 * 謄本の取得で「どの土地・建物を取るか」(2026-11-06 2筆以上・2棟以上の2回目後半)。
 * 足した行がある物件だけに出す。既定は1筆目・1棟目(今までどおり)。
 * ⚠検索の前に選ぶ(候補が1件ならそのまま取得まで進むため、あとから選ぶ画面が無い)。
 */
export function parcelTargetLabel(p: Pick<ExtraParcel, "kind" | "location" | "number">): string {
  return [PARCEL_KINDS[p.kind], p.location?.trim() || null, p.number].filter(Boolean).join(" ");
}

export function mainParcelLabel(lotNumber: string | null | undefined, buildingNumber: string | null | undefined): string {
  const nums = [lotNumber?.trim() && `地番 ${lotNumber.trim()}`, buildingNumber?.trim() && `家屋番号 ${buildingNumber.trim()}`]
    .filter(Boolean)
    .join(" / ");
  return nums ? `1筆目・1棟目（${nums}）` : "1筆目・1棟目";
}

export default function RegistryParcelTargetPicker({
  rows,
  mainLotNumber,
  mainBuildingNumber,
  value,
  onChange,
  disabled = false,
}: {
  rows: ExtraParcel[];
  mainLotNumber?: string | null;
  mainBuildingNumber?: string | null;
  /** 選んだ行の id。null=1筆目・1棟目。 */
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <fieldset className="mt-1 flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 p-1.5">
      <legend className="px-1 text-indigo-800 dark:text-indigo-300">取得する土地・建物</legend>
      <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
        <input
          type="radio"
          name="registryParcelTarget"
          checked={value === null}
          disabled={disabled}
          onChange={() => onChange(null)}
        />
        {mainParcelLabel(mainLotNumber, mainBuildingNumber)}
      </label>
      {rows.map((r) => (
        <label key={r.id} className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
          <input
            type="radio"
            name="registryParcelTarget"
            checked={value === r.id}
            disabled={disabled}
            onChange={() => onChange(r.id)}
          />
          {parcelTargetLabel(r)}
        </label>
      ))}
      <p className="text-[11px] text-indigo-600 dark:text-indigo-400">
        ほかの土地・建物は、その行の所在（空なら物件の住所）と地番・家屋番号で探します。全部事項なら、その行の空いている面積に入ります。
      </p>
    </fieldset>
  );
}
