"use client";

/**
 * 「謄本から所有者をまとめて反映」の画面（管理者のみ）。
 *
 * 所有者が空なのに所有者事項の謄本がある物件を、**裏で1件ずつ**順番に処理する。
 * 1件ずつのボタン(物件ページの所有者タブ)と同じ処理を通るので、検査と安全策は同じ。
 *
 * ⚠**まず少しだけ試してから増やす**(発注者承認 2026-09-26)。既定は100件。
 * ⚠進み具合と1件ごとの結果は「取込の記録」の画面で見る(この画面は受付だけ)。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUser, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import ImportSwitcher from "@/components/import/import-switcher";
import {
  fetchRegistryOwnerApplyTarget,
  startRegistryOwnerApply,
  type RegistryOwnerApplyTarget,
} from "@/lib/api-client";
import { describeFillAllButton } from "@/lib/registry-owner-bulk/plan";

export default function RegistryOwnersBulkPage() {
  const router = useRouter();
  const [target, setTarget] = useState<RegistryOwnerApplyTarget | null>(null);
  const [limitText, setLimitText] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await fetchRegistryOwnerApplyTarget();
      setTarget(data);
      // 画面に数字を直書きしない(APIの既定値を使う)
      setLimitText(String(data.defaultLimit));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "対象の件数を取得できませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = target?.busy ?? false;
  const targetCount = target?.targetCount ?? 0;
  // ⚠上限を超えるときは「全件」と書かない(→ describeFillAllButton)
  const fillAll = describeFillAllButton(targetCount, target?.maxLimit ?? targetCount);
  const limit = Number(limitText);
  const limitValid =
    Number.isInteger(limit) && limit >= 1 && limit <= (target?.maxLimit ?? 0);

  const start = useCallback(async () => {
    if (!limitValid) return;
    setStarting(true);
    setErrorMsg(null);
    try {
      const result = await startRegistryOwnerApply(limit);
      if (!result.jobId) {
        setErrorMsg("対象の物件がありませんでした");
        setStarting(false);
        await load();
        return;
      }
      // 進み具合と1件ごとの結果は取込の記録の画面で見る
      router.push(`/import/jobs/${result.jobId}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "開始できませんでした");
      setStarting(false);
    }
  }, [limit, limitValid, load, router]);

  return (
    <div>
      <ImportSwitcher />
      <PageHeader
        title="謄本から所有者をまとめて反映"
        description="所有者が空のまま謄本(所有者事項)が添付されている物件に、謄本の氏名・住所を登録します。すでに取得済みの謄本を読むだけなので、追加の費用はかかりません。"
      />

      <div className="max-w-2xl space-y-6">
        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            対象の物件
          </h2>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              数えています…
            </p>
          ) : (
            <p className="text-sm text-gray-800 dark:text-gray-100">
              <span className="text-2xl font-bold">{targetCount.toLocaleString()}</span>
              件（所有者が空 + 所有者事項の謄本あり）
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            謄本を取得した古い順に処理します。所有者がすでにいる物件は自動で飛ばします。
          </p>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            今回処理する件数
          </h2>
          <p className="mb-3 text-xs text-gray-600 dark:text-gray-300">
            まずは100件ほどで試し、登録された氏名・住所を確かめてから残りを流すことをおすすめします。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={target?.maxLimit ?? undefined}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
              aria-label="今回処理する件数"
              className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
            <span className="text-sm text-gray-600 dark:text-gray-300">件</span>
            <Button
              variant="secondary"
              onClick={() => setLimitText(String(fillAll.limit))}
              disabled={loading || targetCount === 0}
            >
              {fillAll.capped
                ? `上限の${fillAll.limit.toLocaleString()}件`
                : `全件（${targetCount.toLocaleString()}件）`}
            </Button>
          </div>
          {fillAll.capped ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              1回に流せるのは{fillAll.limit.toLocaleString()}件までです。残りの
              {fillAll.remaining.toLocaleString()}件は、終わってからもう一度この画面で実行してください。
            </p>
          ) : null}

          {busy ? (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
              ほかの取込を処理中です。終わってからもう一度お試しください。
            </p>
          ) : null}

          <div className="mt-4 flex items-center gap-2">
            <Button onClick={start} disabled={busy || starting || loading || !limitValid}>
              {starting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  開始しています…
                </>
              ) : (
                <>
                  <FileUser className="mr-1.5 h-4 w-4" />
                  この件数で反映する
                </>
              )}
            </Button>
            {!limitValid && !loading ? (
              <span className="text-xs text-red-600 dark:text-red-400">
                1〜{(target?.maxLimit ?? 0).toLocaleString()} の整数を入れてください
              </span>
            ) : null}
          </div>

          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            開始すると取込の記録の画面に移ります。進み具合と1件ごとの結果（登録した人数・
            飛ばした物件・読み取れなかった物件）はそちらで見られます。100件あたり1〜2分ほどです。
          </p>
        </section>

        {errorMsg ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorMsg}
          </p>
        ) : null}
      </div>
    </div>
  );
}
