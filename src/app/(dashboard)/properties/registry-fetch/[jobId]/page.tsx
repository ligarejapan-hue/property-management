"use client";

/**
 * 謄本 一括取得(PR-B・薄い版)の進捗画面。
 *
 * ⚠**画面駆動の分割実行**: この画面が開いている間、pending 項目を1件ずつ process-next で
 *   処理していく(サーバー常駐の無人実行はしない)。1件終わるたびに進捗を更新する。
 * ⚠課金済みで失敗した項目が出たらジョブは一時停止する(マイページ確認を促し、再開/中止を選ぶ)。
 * ⚠中止は「節目で止まる」= 実行中の1件は最後まで進み、以降は掴まれない。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  fetchRegistryFetchJob,
  processNextRegistryFetchItem,
  cancelRegistryFetchJob,
  resumeRegistryFetchJob,
  type RegistryFetchJobProgress,
} from "@/lib/api-client";

// rate_limited(順番待ち)で待つ間隔。実サイトの最小間隔(本番30秒)に合わせて余裕を持たせる。
const RATE_LIMIT_WAIT_MS = 32_000;
// busy(他タブ等が実行中)で待つ間隔。
const BUSY_WAIT_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function RegistryBulkFetchProgressPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const router = useRouter();

  const [progress, setProgress] = useState<RegistryFetchJobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // ループの多重起動防止 + アンマウント/中止で停止させる制御。
  const loopActiveRef = useRef(false);
  const stopRef = useRef(false);

  const reload = useCallback(async () => {
    const p = await fetchRegistryFetchJob(jobId);
    setProgress(p);
    return p;
  }, [jobId]);

  // pending を1件ずつ処理するループ。runnable な間だけ回る。
  const runLoop = useCallback(async () => {
    if (loopActiveRef.current) return;
    loopActiveRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setError(null);
    try {
      // eslint-disable-next-line no-constant-condition
      while (!stopRef.current) {
        let res;
        try {
          res = await processNextRegistryFetchItem(jobId);
        } catch (err) {
          setError(err instanceof Error ? err.message : "処理に失敗しました");
          break;
        }
        await reload();

        if (res.outcome === "drained") {
          setNotice("すべての項目の処理が終わりました。");
          break;
        }
        if (res.outcome === "paused") {
          setNotice(
            "課金済みで確認が必要な項目があるため、一時停止しました。マイページで取得状況を確認してください。",
          );
          break;
        }
        if (res.outcome === "cancelled") {
          break;
        }
        if (res.outcome === "rate_limited") {
          // まだ順番待ち。間隔を空けて同じ項目を再試行。
          setNotice("取得の間隔調整のため待機しています…");
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        if (res.outcome === "busy") {
          // 別の実行が進行中。少し待って再確認。
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        // processed / skipped: 次の項目へ。残りが無ければ次回 drained で抜ける。
        if (!res.morePending) {
          await reload();
          break;
        }
      }
    } finally {
      loopActiveRef.current = false;
      setRunning(false);
    }
  }, [jobId, reload]);

  // 初回ロード → runnable なら自動でループ開始。
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = await reload();
        if (!mounted) return;
        if (p.status === "pending" || p.status === "processing") {
          void runLoop();
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "ジョブの読み込みに失敗しました");
        }
      }
    })();
    return () => {
      mounted = false;
      stopRef.current = true; // アンマウントでループ停止
    };
  }, [reload, runLoop]);

  const handleCancel = async () => {
    stopRef.current = true;
    try {
      await cancelRegistryFetchJob(jobId);
      await reload();
      setNotice("中止しました（実行中の1件は最後まで進みます）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "中止に失敗しました");
    }
  };

  const handleResume = async () => {
    try {
      await resumeRegistryFetchJob(jobId);
      setNotice(null);
      await reload();
      void runLoop();
    } catch (err) {
      setError(err instanceof Error ? err.message : "再開に失敗しました");
    }
  };

  if (!progress) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {error ?? "読み込み中…"}
        </p>
      </div>
    );
  }

  const c = progress.counts;
  const finished = c.done + c.failed + c.skipped + c.chargedButFailed;
  const pct = c.total > 0 ? Math.round((finished / c.total) * 100) : 0;
  const certLabel = progress.certificateType === "all" ? "全部事項" : "所有者事項";

  const statusText: Record<string, string> = {
    pending: "準備中",
    processing: "取得中…",
    paused: "一時停止",
    completed: "完了",
    cancelled: "中止しました",
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <button
        type="button"
        onClick={() => router.push("/properties")}
        className="mb-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
      >
        ← 物件一覧へ戻る
      </button>

      <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        謄本の一括取得（{certLabel}）
      </h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        状態: {statusText[progress.status] ?? progress.status}
        {running && <span className="ml-2 animate-pulse">●</span>}
      </p>

      {/* 進捗バー */}
      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>
            {finished} / {c.total} 件
          </span>
          <span>{pct}%</span>
        </div>
        <div
          className="mt-1 h-3 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* 集計タイル */}
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <Tile label="取得済み" value={c.done} tone="green" />
        <Tile label="残り" value={c.pending + c.processing} tone="gray" />
        <Tile label="対象外" value={c.skipped} tone="amber" />
        <Tile label="失敗" value={c.failed} tone="red" />
        <Tile label="要確認" value={c.chargedButFailed} tone="red" />
      </div>

      {progress.status === "paused" && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          課金済みで確認が必要な項目があるため一時停止しています。
          法務局のマイページで取得状況を確認のうえ、再開してください。
          <div className="mt-2">
            <button
              type="button"
              onClick={handleResume}
              className="rounded bg-amber-600 px-3 py-1.5 text-white hover:bg-amber-700"
            >
              残りの取得を再開する
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p className="mt-4 text-sm text-gray-700 dark:text-gray-300">{notice}</p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {(progress.status === "processing" || progress.status === "pending") && (
        <div className="mt-5">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            中止する
          </button>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "gray" | "amber" | "red";
}) {
  const toneClass: Record<string, string> = {
    green: "text-green-700 dark:text-green-400",
    gray: "text-gray-700 dark:text-gray-300",
    amber: "text-amber-700 dark:text-amber-400",
    red: "text-red-700 dark:text-red-400",
  };
  return (
    <div className="rounded border border-gray-200 bg-white p-2 text-center dark:border-gray-800 dark:bg-gray-900">
      <div className={`text-lg font-semibold ${toneClass[tone]}`}>{value}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}
