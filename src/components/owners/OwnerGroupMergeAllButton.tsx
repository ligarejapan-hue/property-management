"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  runGroupMergeAll,
  type GroupMergeMemberResult,
} from "@/lib/owner-merge-all";
import { mergeBlockReasonLabel } from "@/lib/owner-merge-reason-labels";

/**
 * 重複候補のグループで、選んだ master に残りの人を全部まとめるボタン（2026-11-24 発注者承認）。
 *
 * - 確認は1回だけ（window.confirm）。そのあとは1人ずつ順に統合する（runGroupMergeAll）。
 * - 途中で止まった人がいても残りは続け、1人ずつ「成功 / 止まった（理由）」を出す。
 * - 表示するのは ID の先頭8桁と理由だけ（名前・住所は出さない）。
 */
interface OwnerGroupMergeAllButtonProps {
  masterId: string;
  /** グループの全員（master が混ざっていても除いて数える）。 */
  sourceIds: string[];
  /** 結果を閉じたとき、1人以上まとまっていれば候補一覧を読み直す。 */
  onExecuted?: () => void;
}

export function OwnerGroupMergeAllButton({
  masterId,
  sourceIds,
  onExecuted,
}: OwnerGroupMergeAllButtonProps) {
  const targets = sourceIds.filter((id) => id !== masterId);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<GroupMergeMemberResult[] | null>(null);

  const handleClick = async () => {
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `master ${masterId.slice(0, 8)}… に、残りの${targets.length}人を1人ずつ統合します。` +
          "統合された人はアーカイブされ、元に戻せません。よろしいですか？",
      )
    ) {
      return;
    }
    setRunning(true);
    setResults(null);
    setProgress({ done: 0, total: targets.length });
    const r = await runGroupMergeAll({
      masterId,
      sourceIds: targets,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    // ⚠ここで一覧を読み直さない: 読み直すと一覧が「読み込み中」になってこの部品ごと外れ、
    //   1人ずつの結果が見えないまま消える(@codex P2)。結果を閉じるときに読み直す。
    setResults(r);
    setRunning(false);
  };

  const handleClose = () => {
    const merged = results?.some((x) => x.ok) ?? false;
    setResults(null);
    setProgress(null);
    if (merged) onExecuted?.();
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="duplicate-group-merge-all">
      <div className="flex items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          onClick={handleClick}
          // 結果を出している間は押せない（一覧が古いまま＝統合済みの人にもう一度かけない）
          disabled={running || results !== null || targets.length === 0}
        >
          {running ? "まとめています..." : "この1人に全部まとめる"}
        </Button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          残りの{targets.length}人を master に統合します
        </span>
      </div>

      {running && progress && (
        <p className="text-xs text-gray-600 dark:text-gray-300">
          {progress.done} / {progress.total} 人 終わりました
        </p>
      )}

      {results && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-800">
          <p className="mb-1 font-medium text-gray-800 dark:text-gray-100">
            {okCount}人を統合しました（{results.length}人中）
          </p>
          <ul className="space-y-0.5">
            {results.map((r) => (
              <li key={r.sourceId}>
                <span className="font-mono">{r.sourceId.slice(0, 8)}…</span>{" "}
                {r.ok ? (
                  <span className="text-green-700 dark:text-green-300">成功</span>
                ) : (
                  <span className="text-red-700 dark:text-red-300">
                    止まった（
                    {[
                      ...r.reasons.map(mergeBlockReasonLabel),
                      ...(r.message ? [r.message] : []),
                    ].join(" / ") || "理由不明"}
                    ）
                  </span>
                )}
              </li>
            ))}
          </ul>
          {okCount < results.length && (
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              止まった人は統合されずにそのまま残っています。理由を直してから、もう一度まとめられます。
            </p>
          )}
          <Button variant="secondary" size="sm" className="mt-2" onClick={handleClose}>
            閉じて一覧を更新
          </Button>
        </div>
      )}
    </div>
  );
}
