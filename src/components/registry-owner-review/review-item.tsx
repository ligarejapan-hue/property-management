"use client";

/**
 * 謄本の名義の確認: 1物件ぶん(開くと左右に並べ、「このままでよい」「謄本の名義に直す」を選ぶ)。
 *
 * DM の初期値(2026-11-08 発注者決定):
 *   - このままでよい → 「DM を送付可に戻す」に最初からチェック
 *   - 謄本の名義に直す → 最初はチェックなし(所有者が変わるので保留のまま)
 * ⚠「謄本の名義に直す」は必ず確認画面で外れる人・加わる人を見せてから。
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import OwnerComparison from "@/components/registry-owner-review/owner-comparison";
import {
  fetchRegistryOwnerReviewDetail,
  keepRegistryOwnerCheck,
  replaceRegistryOwnerCheck,
  type RegistryOwnerReviewDetail,
} from "@/lib/api-client";
import { DM_STATUS_LABELS } from "@/lib/property-types";

export interface ReviewItemProps {
  propertyId: string;
  address: string;
  dmStatus: string;
  /** 違いの種類の文言(一覧の列・種類を残す前に比べた物件は null) */
  diffKind: string | null;
  canKeep: boolean;
  canReplace: boolean;
  /** DM を戻せるか(物件を編集できる人だけ) */
  canRestoreDm: boolean;
  /** 判断が済んだ(一覧から外す) */
  onDone: (message: string) => void;
}

export default function ReviewItem({ propertyId, address, dmStatus, diffKind, canKeep, canReplace, canRestoreDm, onDone }: ReviewItemProps) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RegistryOwnerReviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [keepRestoreDm, setKeepRestoreDm] = useState(true);
  const [replaceRestoreDm, setReplaceRestoreDm] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setErrorMsg(null);
    setLoading(true);
    try {
      setDetail(await fetchRegistryOwnerReviewDetail(propertyId));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, [open, propertyId]);

  // DM を戻す選びは、未判断の物件で・物件を編集できる人にだけ出す
  const isHold = canRestoreDm && (detail?.dmStatus ?? dmStatus) === "hold";

  const keep = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const r = await keepRegistryOwnerCheck(propertyId, {
        attachmentId: detail.attachment.id,
        restoreDm: isHold && keepRestoreDm,
      });
      onDone(r.dmRestored ? "「このままでよい」にしました。DM は送付可に戻しました。" : "「このままでよい」にしました。");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  }, [detail, propertyId, isHold, keepRestoreDm, onDone]);

  const replace = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const r = await replaceRegistryOwnerCheck(propertyId, {
        attachmentId: detail.attachment.id,
        linkedOwnerIds: detail.plan.linkedOwnerIds,
        removeOwnerIds: detail.plan.removeOwnerIds,
        restoreDm: isHold && replaceRestoreDm,
      });
      setConfirming(false);
      onDone(
        `謄本の名義に直しました(外した人 ${r.removed}名・足した人 ${r.added}名)。` +
          (r.dmRestored ? "DM は送付可に戻しました。" : ""),
      );
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "直せませんでした");
      setBusy(false);
    }
  }, [detail, propertyId, isHold, replaceRestoreDm, onDone]);

  const removeNames = detail?.systemOwners.filter((o) => o.willBeRemoved) ?? [];
  const addNames = detail?.registryOwners.filter((o) => o.willBeAdded) ?? [];
  const blockedByNote = removeNames.some((o) => o.hasNote);
  // 外字の組だけ(システムの人を残す)など、直しても外れる人も加わる人もいない(2026-11-11 昼)
  const nothingToReplace = !!detail?.readable && removeNames.length === 0 && addNames.length === 0;

  return (
    <li className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        // data-ui=raw: 一覧の行全体を開閉する見出し(ボタンの見た目にしない)
        data-ui="raw"
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left text-sm md:flex-nowrap"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1 text-gray-900 dark:text-gray-100">{address}</span>
        <span className="order-last w-full pl-6 text-xs text-gray-700 md:order-none md:w-72 md:shrink-0 md:pl-0 dark:text-gray-200">
          {diffKind ?? <span className="text-gray-400">（種類はこの次に比べたときに出ます）</span>}
        </span>
        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">DM: {DM_STATUS_LABELS[dmStatus] ?? dmStatus}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-gray-100 px-4 py-4 dark:border-gray-800">
          {loading ? <p className="text-sm text-gray-500">謄本を読んでいます…</p> : null}
          {detail ? (
            <>
              <OwnerComparison
                systemOwners={detail.systemOwners}
                registryOwners={detail.registryOwners}
                registryLabel={detail.attachment.label}
              />
              <p className="text-xs">
                <Link href={`/properties/${propertyId}`} className="text-blue-600 underline dark:text-blue-400" target="_blank">
                  物件を開く
                </Link>
              </p>

              <div className="grid gap-3 md:grid-cols-2">
                <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
                  <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">このままでよい</h4>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    所有者は変えずに、一覧から外します。あとで新しい謄本を付けたら、もう一度比べます。
                  </p>
                  {isHold ? (
                    <label className="mt-2 flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                      <input type="checkbox" checked={keepRestoreDm} onChange={(e) => setKeepRestoreDm(e.target.checked)} />
                      DM を「送付可」に戻す
                    </label>
                  ) : null}
                  <Button className="mt-3" size="sm" variant="secondary" onClick={keep} disabled={!canKeep || busy}>
                    このままでよい
                  </Button>
                  {!canKeep ? <p className="mt-1 text-xs text-gray-500">所有者を編集できる人だけが選べます。</p> : null}
                </section>

                <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
                  <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">謄本の名義に直す</h4>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    謄本にない人を物件から外し、システムにいない謄本の人を足します。外した人の記録は消えず、変更履歴に残ります。
                  </p>
                  {isHold ? (
                    <label className="mt-2 flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                      <input type="checkbox" checked={replaceRestoreDm} onChange={(e) => setReplaceRestoreDm(e.target.checked)} />
                      DM を「送付可」に戻す(所有者が変わるので、最初はチェックなし)
                    </label>
                  ) : null}
                  <Button
                    className="mt-3"
                    size="sm"
                    onClick={() => setConfirming(true)}
                    disabled={!canReplace || busy || !detail.readable || blockedByNote || nothingToReplace}
                  >
                    謄本の名義に直す
                  </Button>
                  {!canReplace ? <p className="mt-1 text-xs text-gray-500">管理者だけが直せます。</p> : null}
                  {nothingToReplace ? (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      直しても外れる人・加わる人はいません(外字の人はシステムの名前のまま残します)。確かめたら「このままでよい」を選んでください。
                    </p>
                  ) : null}
                  {blockedByNote ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      外す人に、この物件についてのメモがあります。物件の所有者タブでメモを確かめてから直してください。
                    </p>
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
          {errorMsg ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorMsg}
            </p>
          ) : null}
        </div>
      ) : null}

      {confirming && detail ? (
        <ModalShell
          title="謄本の名義に直す"
          size="md"
          onClose={busy ? undefined : () => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                やめる
              </Button>
              <Button onClick={replace} disabled={busy}>
                {busy ? "直しています…" : "この内容で直す"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-semibold text-gray-800 dark:text-gray-100">物件から外れる人({removeNames.length}名)</p>
              <ul className="mt-1 list-disc pl-5 text-gray-700 dark:text-gray-200">
                {removeNames.length === 0 ? <li>なし</li> : removeNames.map((o) => <li key={o.ownerId}>{o.name}</li>)}
              </ul>
            </div>
            <div>
              <p className="font-semibold text-gray-800 dark:text-gray-100">加わる人({addNames.length}名)</p>
              <ul className="mt-1 list-disc pl-5 text-gray-700 dark:text-gray-200">
                {addNames.length === 0 ? <li>なし</li> : addNames.map((o, i) => <li key={`${o.name}-${i}`}>{o.name}</li>)}
              </ul>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              DM: {isHold ? (replaceRestoreDm ? "送付可に戻します" : "未判断のまま") : "変えません"}
            </p>
            {errorMsg ? (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errorMsg}
              </p>
            ) : null}
          </div>
        </ModalShell>
      ) : null}
    </li>
  );
}
