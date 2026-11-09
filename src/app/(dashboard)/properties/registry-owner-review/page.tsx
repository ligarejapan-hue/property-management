"use client";

/**
 * 謄本の名義の確認(2026-11-08 発注者依頼)。
 *
 * 謄本(所有者事項)の名義と、システムの所有者が違う物件の一覧。表記の違いだけ((株)と株式会社・
 * 異体字など)は「同じ」として出さない(取引の照合と同じそろえ方)。
 * 1件ずつ開いて左右に並べ、「謄本の名義に直す」(管理者だけ)か「このままでよい」を選ぶ。
 *
 * ⚠見られるのは所有者の氏名を伏せずに見られて謄本も見られる人だけ(API が判定)。CSV は無い。
 * ⚠比べた結果は管理者が「まだ比べていない物件を比べる」で作る(謄本を読むので1回50件ずつ)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import ReviewItem from "@/components/registry-owner-review/review-item";
import {
  fetchRegistryOwnerReviewList,
  runRegistryOwnerCheckBatch,
  type RegistryOwnerReviewList,
  type RegistryOwnerReviewSort,
} from "@/lib/api-client";

const RESULT_LABELS: Record<string, string> = {
  same: "同じ",
  same_notation: "同じ(表記の違い)",
  mismatch: "違う",
  unreadable: "謄本を読めない",
  no_owner: "システムに所有者がいない",
  skipped: "比べられなかった(謄本が変わった・無い)",
  auto_added: "謄本にだけいる人を自動で登録した物件",
  auto_added_people: "自動で登録した人",
};

/** 件数の単位(人数だけ「人」) */
const countUnit = (k: string) => (k === "auto_added_people" ? "人" : "件");

export default function RegistryOwnerReviewPage() {
  const [list, setList] = useState<RegistryOwnerReviewList | null>(null);
  const [offset, setOffset] = useState(0);
  // 既定=違いの種類の順(漢字の違い → 法人の書き方 → … → 別の人)
  const [sort, setSort] = useState<RegistryOwnerReviewSort>("kind");
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runCounts, setRunCounts] = useState<Record<string, number> | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async (nextOffset: number, nextSort: RegistryOwnerReviewSort = sort) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      setList(await fetchRegistryOwnerReviewList(nextOffset, nextSort));
      setOffset(nextOffset);
      setSort(nextSort);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "一覧を読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, [sort]);

  // 最初の読み込み(loading は最初から true なので、ここでは読み終えてから state を変える)
  useEffect(() => {
    let alive = true;
    fetchRegistryOwnerReviewList(0)
      .then((d) => {
        if (alive) setList(d);
      })
      .catch((e) => {
        if (alive) setErrorMsg(e instanceof Error ? e.message : "一覧を読み込めませんでした");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!list) return;
    stopRef.current = false;
    setRunning(true);
    setErrorMsg(null);
    const total: Record<string, number> = {};
    try {
      // 残りが0になるか「止める」まで、50件ずつ繰り返す
      for (;;) {
        const r = await runRegistryOwnerCheckBatch(list.runMax);
        for (const [k, v] of Object.entries(r.counts)) total[k] = (total[k] ?? 0) + v;
        if (r.failed) total.failed = (total.failed ?? 0) + r.failed;
        setRunCounts({ ...total });
        setList((prev) => (prev ? { ...prev, pending: r.remaining } : prev));
        // 進まない(全部失敗した)ときも止める(読めない物件を同じ順で読み続けない)
        if (r.remaining === 0 || r.processed === 0 || r.failed === r.processed || stopRef.current) break;
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "比べられませんでした");
    } finally {
      setRunning(false);
      await load(0);
    }
  }, [list, load]);

  const onDone = useCallback(
    (message: string) => {
      setNotice(message);
      void load(offset);
    },
    [load, offset],
  );

  return (
    <div>
      <PageHeader
        title="謄本の名義の確認"
        description="謄本（所有者事項）の名義と、システムの所有者が違う物件です。（株）と株式会社・異体字など表記の違いだけのものは出していません。1件ずつ開いて、謄本の名義に直すか、このままでよいかを選んでください。"
      />
      <p className="mb-4 max-w-4xl rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        比べて違うと出たときは、謄本にだけいる人を自動でシステムの所有者に登録します（毎晩の自動の比べと「まだ比べていない物件を比べる」のたびに）。システムにだけいる人は外さず、今いる人の名前・住所も変えません。漢字1字の違い（髙／高）や法人の書き方の違いの人は登録せず、ここで確かめます。DM の保留はそのままです。謄本が古いなどで、自動で登録された人を外したいときは、先にこの一覧で「このままでよい」を選んでから外してください（選ばずに外すと、次に比べたときにまた登録されます）。
      </p>

      <div className="max-w-4xl space-y-4">
        {list?.canRun ? (
          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">まだ比べていない物件</h2>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
              <span className="text-xl font-bold">{(list.pending ?? 0).toLocaleString()}</span> 件
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                (所有者事項の謄本がある物件のうち、まだ比べていない・所有者や謄本が変わった物件)
              </span>
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={run} disabled={running || (list.pending ?? 0) === 0}>
                {running ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    比べています…
                  </>
                ) : (
                  "まだ比べていない物件を比べる"
                )}
              </Button>
              {running ? (
                <Button size="sm" variant="secondary" onClick={() => (stopRef.current = true)}>
                  止める
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              毎晩（日本時間 2〜5時）自動で少しずつ比べています（1晩2,000件まで）。急ぐときはこのボタンで今すぐ比べられます。添付済みの謄本を読むだけで、費用はかかりません。{list.runMax}件ずつ順番に比べます（100件で1分ほど）。この画面を開いたままにしてください。
            </p>
            {runCounts ? (
              <ul className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                {Object.entries(runCounts).map(([k, v]) => (
                  <li key={k}>
                    {k === "failed" ? "失敗" : (RESULT_LABELS[k] ?? k)}: {v.toLocaleString()}
                    {countUnit(k)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {notice ? (
          <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
            {notice}
          </p>
        ) : null}
        {errorMsg ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorMsg}
          </p>
        ) : null}

        {loading && !list ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込んでいます…
          </p>
        ) : null}

        {list ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                名義が違う物件: <span className="font-bold">{list.total.toLocaleString()}</span> 件
              </p>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                並べ替え
                <select
                  value={sort}
                  disabled={loading}
                  onChange={(e) => void load(0, e.target.value as RegistryOwnerReviewSort)}
                  className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                >
                  <option value="kind">違いの種類の順</option>
                  <option value="default">今までの順</option>
                </select>
              </label>
              {sort === "kind" ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  漢字の違い → 法人の書き方の違い → 名前の一部が違う → 人数が違う → 別の人
                </span>
              ) : null}
            </div>
            {list.data.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">確認が必要な物件はありません。</p>
            ) : (
              <>
                <div className="hidden gap-2 px-4 text-xs text-gray-500 md:flex dark:text-gray-400" aria-hidden="true">
                  <span className="w-4" />
                  <span className="flex-1">物件</span>
                  <span className="w-72">違いの種類</span>
                  <span>DM</span>
                </div>
                <ul className="space-y-2">
                  {list.data.map((row) => (
                    <ReviewItem
                      key={row.propertyId}
                      propertyId={row.propertyId}
                      address={row.address}
                      dmStatus={row.dmStatus}
                      diffKind={row.diffKind}
                      canKeep={list.canKeep}
                      canReplace={list.canReplace}
                      canRestoreDm={list.canRestoreDm}
                      onDone={onDone}
                    />
                  ))}
                </ul>
              </>
            )}
            {list.total > list.pageSize ? (
              <Pagination
                page={Math.floor(offset / list.pageSize) + 1}
                totalPages={Math.ceil(list.total / list.pageSize)}
                total={list.total}
                pageSize={list.pageSize}
                busy={loading}
                onPrev={() => load(Math.max(0, offset - list.pageSize))}
                onNext={() => load(offset + list.pageSize)}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
