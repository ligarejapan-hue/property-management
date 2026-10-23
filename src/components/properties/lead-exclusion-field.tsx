"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { badgeIntentClass } from "@/components/ui/status-badge";
import { runNoLockPropertyPatch } from "@/app/(dashboard)/properties/[id]/page";
import { formatDateOnlyJa } from "@/lib/case-dates";
import {
  LEAD_EXCLUSION_STATUS_LABELS,
  isLeadExclusionStatus,
  jstTodayDateOnly,
  leadExclusionBadge,
  showsLeadExclusionBlock,
} from "@/lib/lead-exclusion";

export interface LeadExclusionProperty {
  id: string;
  version: number;
  introductionRoute: string | null;
  leadExclusionStatus: string | null;
  /** "YYYY-MM-DD"・無ければ null。 */
  leadExclusionRequestedAt: string | null;
  leadExclusionDecidedAt: string | null;
}

/**
 * 物件詳細の「除外申請」(査定サイトへ無効な反響の課金を外してもらう申し出・2026-10-24)。
 * - 導入ルートが「一括査定」か、既に状態が入っている物件だけ最初から出す。それ以外は
 *   「除外申請を記録する」の小さなリンクの奥に畳む(書ける人だけ)。
 * - 操作: 申請中にする(申請した日=今日・直せる)/ 除外された・認められなかった(結果の日=今日・直せる)/ 取り消す。
 * - 保存は案件ステータスと同じ鍵なし保存(runNoLockPropertyPatch・版番号つき PATCH)。
 *   書ける条件も物件の編集と同じ(canWrite)。他の人の鍵のときは止める。
 */
export default function LeadExclusionField({
  property,
  onRefresh,
  canWrite,
  editLockHeld,
  today = jstTodayDateOnly(new Date()),
}: {
  property: LeadExclusionProperty;
  onRefresh: () => void;
  canWrite: boolean;
  editLockHeld: boolean;
  /** 「申請中 N日」と既定の日付の基準(JST の今日・テスト用に差し替え可)。 */
  today?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveSeqRef = useRef(0);
  const requestedRef = useRef<HTMLInputElement>(null);
  const decidedRef = useRef<HTMLInputElement>(null);

  const status = isLeadExclusionStatus(property.leadExclusionStatus) ? property.leadExclusionStatus : null;
  const visible = showsLeadExclusionBlock(property.introductionRoute, status) || opened;

  if (!visible) {
    if (!canWrite) return null;
    return (
      <div className="md:col-span-2">
        <Button variant="ghost" size="sm" onClick={() => setOpened(true)} disabled={editLockHeld}>
          除外申請を記録する
        </Button>
      </div>
    );
  }

  const badge = leadExclusionBadge(status, property.leadExclusionRequestedAt, today);
  const disabled = saving || editLockHeld;
  const save = (patch: Record<string, unknown>) =>
    void runNoLockPropertyPatch(property.id, property.version, patch, setSaving, setError, onRefresh, saveSeqRef);
  const dateOrNull = (el: HTMLInputElement | null) => (el && el.value ? el.value : null);
  const inputClass =
    "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

  return (
    <div className="md:col-span-2 rounded-r-md border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2 dark:border-amber-500 dark:bg-amber-950/30">
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">除外申請</dt>
      <dd className="space-y-2 text-sm text-gray-900 dark:text-gray-100">
        <div className="flex flex-wrap items-center gap-2">
          <span>{status ? LEAD_EXCLUSION_STATUS_LABELS[status] : "申請していません"}</span>
          {badge && (
            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeIntentClass(badge.intent)}`}>
              {badge.text}
            </span>
          )}
          {status && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              申請日 {formatDateOnlyJa(property.leadExclusionRequestedAt)}
              {status !== "requested" && ` ・ 結果 ${formatDateOnlyJa(property.leadExclusionDecidedAt)}`}
            </span>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
              申請した日
              <input
                key={`req:${property.version}`}
                ref={requestedRef}
                type="date"
                aria-label="申請した日"
                defaultValue={property.leadExclusionRequestedAt ?? today}
                disabled={disabled}
                className={inputClass}
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() =>
                save({ leadExclusionStatus: "requested", leadExclusionRequestedAt: dateOrNull(requestedRef.current) })
              }
            >
              {status === "requested" ? "申請した日を直す" : "申請中にする"}
            </Button>
          </div>
        )}
        {canWrite && status && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
              結果の日
              <input
                key={`dec:${property.version}`}
                ref={decidedRef}
                type="date"
                aria-label="結果の日"
                defaultValue={property.leadExclusionDecidedAt ?? today}
                disabled={disabled}
                className={inputClass}
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() =>
                save({ leadExclusionStatus: "approved", leadExclusionDecidedAt: dateOrNull(decidedRef.current) })
              }
            >
              除外された
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() =>
                save({ leadExclusionStatus: "rejected", leadExclusionDecidedAt: dateOrNull(decidedRef.current) })
              }
            >
              認められなかった
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                if (window.confirm("除外申請の記録を取り消します(申請した日・結果の日も消えます)。よろしいですか？")) {
                  save({ leadExclusionStatus: null });
                }
              }}
            >
              取り消す
            </Button>
          </div>
        )}
        {(saving || error) && (
          <div className="text-xs">
            {saving && <Loader2 className="inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />}
            {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
          </div>
        )}
      </dd>
    </div>
  );
}
