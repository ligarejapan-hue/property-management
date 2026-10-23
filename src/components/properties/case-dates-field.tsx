"use client";

import { useRef, useState, type KeyboardEvent, type FocusEvent } from "react";
import { Loader2 } from "lucide-react";
import { runNoLockPropertyPatch } from "@/app/(dashboard)/properties/[id]/page";
import {
  caseDateLabels,
  caseDateNotice,
  formatDateOnlyJa,
  showsCaseDates,
  todayDateOnly,
  type CaseDateField,
} from "@/lib/case-dates";

/**
 * 物件詳細の「契約予定日」「決済予定日」(2026-10-23 発注者指示)。
 * 案件ステータスが 契約予定/契約完了/決済完了 のときだけ、案件ステータスのすぐ下に出る。
 * - 未定=空のまま(入力を強制しない・表示は「未定」)。
 * - 保存は案件ステータスと同じ鍵なし保存(runNoLockPropertyPatch)。欄を離れたとき(blur)と Enter で保存する。
 *   ⚠type=date は打ちかけ(例 "2026-11")だと value が "" になる=そのまま保存すると未定に戻してしまう。
 *   validity.badInput のときは保存しない。
 * - 値は制御しない(defaultValue)。保存後に onRefresh で物件を読み直し、version が変わる→ key で欄を作り直す。
 */
export default function CaseDatesField({
  property,
  onRefresh,
  canWrite,
  editLockHeld,
  today = todayDateOnly(),
}: {
  property: { id: string; version: number; caseStatus: string; contractPlannedOn: string | null; settlementPlannedOn: string | null };
  onRefresh: () => void;
  canWrite: boolean;
  /** 見ている側。物件が他の人の鍵なら入力を止める(案件ステータスのプルダウンと同じ)。 */
  editLockHeld: boolean;
  /** 「あと N 日」の基準(テスト用に差し替え可)。 */
  today?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const saveSeqRef = useRef(0);
  // 送った値の控え(version ごと)。Enter で送った直後に欄を離れる(blur)と、物件の読み直しが
  // 終わる前は property の値が古いままなので、同じ値を同じ version でもう一度送って 409 になる。
  // 送った値と同じなら送らない。失敗したら控えを消して、同じ値でも送り直せるようにする。
  const sentRef = useRef<{ version: number; values: Partial<Record<CaseDateField, string | null>> }>({
    version: property.version,
    values: {},
  });

  if (!showsCaseDates(property.caseStatus)) return null;

  const labels = caseDateLabels(property.caseStatus);
  const notice = caseDateNotice(property.caseStatus, property.contractPlannedOn, property.settlementPlannedOn, today);

  const commit = (field: CaseDateField, el: HTMLInputElement) => {
    if (el.validity?.badInput) {
      setPartial(true);
      return;
    }
    setPartial(false);
    const next = el.value ? el.value : null;
    if (sentRef.current.version !== property.version) sentRef.current = { version: property.version, values: {} };
    const last = field in sentRef.current.values ? sentRef.current.values[field] : property[field];
    if (next === last) return;
    sentRef.current.values[field] = next;
    const setErrorAndForget: typeof setError = (v) => {
      if (typeof v !== "function" && v != null) delete sentRef.current.values[field];
      setError(v);
    };
    void runNoLockPropertyPatch(property.id, property.version, { [field]: next }, setSaving, setErrorAndForget, onRefresh, saveSeqRef);
  };
  const onBlur = (field: CaseDateField) => (e: FocusEvent<HTMLInputElement>) => commit(field, e.currentTarget);
  const onKeyDown = (field: CaseDateField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit(field, e.currentTarget);
  };

  const noticeEl = notice && (
    <span
      className={
        notice.kind === "overdue"
          ? "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : "inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
      }
    >
      {notice.text}
    </span>
  );

  const fields: { field: CaseDateField; label: string; value: string | null }[] = [
    { field: "contractPlannedOn", label: labels.contract, value: property.contractPlannedOn },
    { field: "settlementPlannedOn", label: labels.settlement, value: property.settlementPlannedOn },
  ];

  return (
    <div className="md:col-span-2 grid grid-cols-1 gap-3 rounded-r-md border-l-2 border-indigo-400 bg-indigo-50/60 px-3 py-2 sm:grid-cols-2 dark:border-indigo-500 dark:bg-indigo-950/30">
      {fields.map(({ field, label, value }) => (
        <div key={field}>
          <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
            {canWrite ? (
              <>
                <input
                  key={`${field}:${property.version}`}
                  type="date"
                  defaultValue={value ?? ""}
                  aria-label={label}
                  disabled={saving || editLockHeld}
                  onBlur={onBlur(field)}
                  onKeyDown={onKeyDown(field)}
                  className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                <span className="text-xs text-gray-500 dark:text-gray-400">未定なら空のまま</span>
              </>
            ) : (
              <span>{formatDateOnlyJa(value)}</span>
            )}
            {/* 知らせは「今見ている予定日」の欄に添える(契約予定→契約・契約完了→決済)。 */}
            {((property.caseStatus === "contract_planned" && field === "contractPlannedOn") ||
              (property.caseStatus === "contracted" && field === "settlementPlannedOn")) &&
              noticeEl}
          </dd>
        </div>
      ))}
      {(saving || error || partial) && (
        <div className="sm:col-span-2 text-xs">
          {saving && <Loader2 className="inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />}
          {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
          {!error && partial && <span className="text-amber-700 dark:text-amber-400">日付が途中です。年月日まで入れるか、空にしてください</span>}
        </div>
      )}
    </div>
  );
}
