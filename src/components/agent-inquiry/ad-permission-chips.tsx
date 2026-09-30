import type { DeskProperty } from "@/lib/api-client";
import { AD_MEDIA_ORDER, AD_MEDIUM_LABEL, AD_VALUE_MARK } from "@/lib/agent-inquiry/desk-form";

const TONE = {
  ok: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  ng: "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  ask: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  none: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
} as const;

/** 広告の可否 6媒体(設計 方針8)。未設定は「—」。△=担当者に確認。 */
export function AdPermissionChips({ value }: { value: DeskProperty["adPermissions"] }) {
  return (
    <ul className="grid grid-cols-3 gap-1 text-xs" aria-label="この物件の広告の可否">
      {AD_MEDIA_ORDER.map((m) => {
        const v = value[m];
        return (
          <li key={m} className={`flex justify-between rounded px-2 py-1 ${TONE[v ?? "none"]}`}>
            <span>{AD_MEDIUM_LABEL[m]}</span>
            <b>{v ? AD_VALUE_MARK[v] : "—"}</b>
          </li>
        );
      })}
    </ul>
  );
}
