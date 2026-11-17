"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getPropertyLeadFollowup,
  stopPropertyLeadFollowup,
  stopSaleDmInquiryFollowup,
  type LeadFollowupStopResponse,
  type LeadFollowupView,
} from "@/lib/api-client";

/**
 * 「追客メール」の様子と「追客を止める」ボタン(設計 2026-11-16 §6 PR2)。
 * - 物件の画面(一括査定の物件だけ)と、査定申込の一覧の行に出す。
 * - 様子はメールを平文で見られる人にだけ届く(API が null / visible=false を返す)=そのときは何も出さない。
 * - 止めたら終わり(再開なし)。押す前に確認を出す。
 */

export const FOLLOWUP_STOP_CONFIRM =
  "このお客様への追客メールを止めます。止めたら、もう送りません(再開はできません)。よろしいですか?";

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 表示だけ(状態は持たない)。 */
export function FollowupStatusBlock({
  view,
  showStop,
  busy = false,
  error = null,
  onStop,
}: {
  view: LeadFollowupView;
  /** 止める権限がある(押せるかは view.canStop と合わせて決める) */
  showStop: boolean;
  busy?: boolean;
  error?: string | null;
  onStop?: () => void;
}) {
  const tone =
    view.state === "active"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : view.state === "stopped"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <div className="text-xs text-gray-700 dark:text-gray-300" data-followup-state={view.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-500">追客メール</span>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${tone}`}>{view.label}</span>
        {showStop && view.canStop && (
          <Button type="button" variant="secondary" size="sm" onClick={onStop} disabled={busy}>
            {busy ? "止めています…" : "追客を止める"}
          </Button>
        )}
      </div>
      {view.stopped && (view.stopped.by || view.stopped.at) && (
        <p className="mt-0.5 text-gray-500">
          {view.stopped.by ? `${view.stopped.by}が止めました` : "止まりました"}
          {view.stopped.at ? `(${formatJst(view.stopped.at)})` : ""}
        </p>
      )}
      {view.sends.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {view.sends.map((s, i) => (
            <li key={`${s.label}-${i}`}>
              {s.label}: {s.result}({formatJst(s.at)})
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mt-0.5 text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function stopErrorMessage(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "追客を止める権限がありません";
  if (status === 404) return "見つかりませんでした。画面を読み直してください";
  if (status === 409) return "一括査定の物件ではないため、追客メールの対象ではありません";
  return "止められませんでした。少し待ってからもう一度押してください";
}

/** 押す→確認→止める→結果の様子に差し替える、の共通部分。 */
function useStopAction(stop: () => Promise<LeadFollowupStopResponse>, onDone: (v: LeadFollowupView) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!window.confirm(FOLLOWUP_STOP_CONFIRM)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await stop();
      onDone(res.followup);
    } catch (e) {
      setError(stopErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** 物件の画面の欄(一括査定の物件だけ)。 */
export function PropertyLeadFollowupField({
  propertyId,
  introductionRoute,
  canWrite,
}: {
  propertyId: string;
  introductionRoute: string | null;
  canWrite: boolean;
}) {
  const target = introductionRoute === "bulk_assessment";
  const [view, setView] = useState<LeadFollowupView | null>(null);
  const { busy, error, run } = useStopAction(() => stopPropertyLeadFollowup(propertyId), setView);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    getPropertyLeadFollowup(propertyId)
      .then((res) => {
        if (alive) setView(res.visible ? res.followup : null);
      })
      .catch(() => {
        // 読めないときは欄を出さない(物件の画面のほかの部分は止めない)。
      });
    return () => {
      alive = false;
    };
  }, [propertyId, target]);

  if (!target || !view) return null;
  return (
    <div className="md:col-span-2">
      <FollowupStatusBlock view={view} showStop={canWrite} busy={busy} error={error} onStop={() => void run()} />
    </div>
  );
}

/** 査定申込の一覧の1行の中。initial=一覧の API が返した様子(メールを見られない人は null=何も出さない)。 */
export function InquiryFollowupLine({ inquiryId, initial }: { inquiryId: string; initial: LeadFollowupView | null | undefined }) {
  const [view, setView] = useState<LeadFollowupView | null>(initial ?? null);
  const { busy, error, run } = useStopAction(() => stopSaleDmInquiryFollowup(inquiryId), setView);
  if (!view) return null;
  return (
    <div className="mt-1">
      <FollowupStatusBlock view={view} showStop busy={busy} error={error} onStop={() => void run()} />
    </div>
  );
}
