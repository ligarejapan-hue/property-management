/**
 * Excel まとめ取込の下見一覧(表示専用)。状態は画面(page.tsx)が持つ。
 *
 * 行ごとに「登録できる / 要確認 / 登録済み」と、登録した結果を出す。
 * ⚠要確認の行は**自動で登録しない**。「貼り付けて物件化」で人が確かめて
 *   登録できるよう、貼り付ける文章と所有者の備考に写すメモをその場で見せる。
 */
import Link from "next/link";
import StatusBadge from "@/components/ui/status-badge";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import type { PasteDraft } from "@/lib/paste-import/types";
import type { LeadRowStatus } from "@/lib/paste-import/lead-sheet";

export interface ExcelLeadRow {
  sheetName: string;
  rowNumber: number;
  text: string;
  draft: PasteDraft;
  ownerNote: string;
  status: LeadRowStatus;
  reasons: string[];
  registeredPropertyId: string | null;
}

/** 登録を試みた結果。 */
export type ExcelLeadResult =
  | { kind: "created"; propertyId: string }
  | { kind: "duplicate" }
  /** 登録直前の見直しで候補が見つかり、登録しなかった(人が確かめる)。 */
  | { kind: "review"; reasons: string[] }
  | { kind: "failed"; message: string };

export function excelLeadRowKey(r: Pick<ExcelLeadRow, "sheetName" | "rowNumber">): string {
  return `${r.sheetName}#${r.rowNumber}`;
}

function StatusCell({ row, result }: { row: ExcelLeadRow; result: ExcelLeadResult | undefined }) {
  if (result?.kind === "created") {
    return (
      <Link href={`/properties/${result.propertyId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
        <StatusBadge intent="success">登録しました</StatusBadge>
      </Link>
    );
  }
  if (result?.kind === "duplicate") return <StatusBadge intent="neutral">登録済み</StatusBadge>;
  if (result?.kind === "failed") {
    return (
      <div className="space-y-1">
        <StatusBadge intent="error">登録できませんでした</StatusBadge>
        <p className="text-xs text-red-700 dark:text-red-300">{result.message}</p>
      </div>
    );
  }
  if (row.status === "registered") {
    return row.registeredPropertyId ? (
      <Link href={`/properties/${row.registeredPropertyId}`} className="hover:underline">
        <StatusBadge intent="neutral">登録済み</StatusBadge>
      </Link>
    ) : (
      <StatusBadge intent="neutral">登録済み</StatusBadge>
    );
  }
  if (row.status === "ready" && result?.kind !== "review") {
    return <StatusBadge intent="info">登録できる</StatusBadge>;
  }
  const reasons = result?.kind === "review" ? result.reasons : row.reasons;
  return (
    <div className="space-y-1">
      <StatusBadge intent="warning">要確認</StatusBadge>
      <ul className="list-disc pl-4 text-xs text-amber-800 dark:text-amber-300">
        {reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </div>
  );
}

function ReviewHelp({ row }: { row: ExcelLeadRow }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-indigo-600 dark:text-indigo-400">
        「貼り付けて物件化」で確かめて登録する
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-gray-600 dark:text-gray-400">
          ① 下の文章をコピーし、
          <Link href="/import/paste" target="_blank" className="text-indigo-600 underline dark:text-indigo-400">
            貼り付けて物件化
          </Link>
          に貼って登録してください。② 登録後、所有者の備考に下のメモを写してください。
        </p>
        <label className="block">
          <span className="text-gray-700 dark:text-gray-300">貼り付ける文章</span>
          <textarea readOnly rows={6} value={row.text}
            className="mt-1 w-full rounded-md border border-gray-300 bg-gray-50 p-2 font-mono dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        </label>
        <label className="block">
          <span className="text-gray-700 dark:text-gray-300">所有者の備考に写すメモ</span>
          <textarea readOnly rows={4} value={row.ownerNote}
            className="mt-1 w-full rounded-md border border-gray-300 bg-gray-50 p-2 font-mono dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        </label>
      </div>
    </details>
  );
}

export function ExcelLeadTable({
  rows,
  results,
}: {
  rows: ExcelLeadRow[];
  results: Record<string, ExcelLeadResult>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2">シート・行</th>
            <th className="px-3 py-2">氏名</th>
            <th className="px-3 py-2">物件の住所</th>
            <th className="px-3 py-2">種別</th>
            <th className="px-3 py-2">状態</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map((row) => {
            const key = excelLeadRowKey(row);
            const result = results[key];
            const type = row.draft.property.propertyType.value;
            return (
              <tr key={key} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-gray-500 dark:text-gray-400">
                  {row.sheetName} {row.rowNumber}行目
                </td>
                <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                  {row.draft.owner?.name.value ?? "—"}
                </td>
                <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                  {row.draft.property.address.value ?? "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                  {type ? (PROPERTY_TYPE_LABELS[type] ?? type) : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusCell row={row} result={result} />
                  {((row.status === "review" && !result) || result?.kind === "review") && (
                    <ReviewHelp row={row} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
