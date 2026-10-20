/** 変更履歴タブの表示の決まり(純関数)。 */
import { CASE_STATUS_LABELS } from "@/lib/property-types";

/** 案件ステータスは内部の値(new_case など)ではなく画面の名前で出す。やめた古い値は「（旧）」付き。 */
export function caseStatusHistoryLabel(value: string | null): string | null {
  if (value == null) return null;
  return CASE_STATUS_LABELS[value] ?? value;
}

/**
 * 「変更者」の欄。自動の切り替え(source=auto)は、記録上の人(手紙を作った人など)ではなく
 * 「自動」と出す=その人が手で変えたように見せない。
 */
export function historyChangerLabel(log: { source: string; changer: { name: string } }): string {
  return log.source === "auto" ? "自動" : log.changer.name;
}
