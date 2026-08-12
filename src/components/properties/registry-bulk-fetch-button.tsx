"use client";

/**
 * 謄本 一括取得(PR-B・薄い版)の起点ボタン + 確認モーダル。
 * 物件一覧でチェックした物件から一括取得ジョブを作り、進捗画面へ遷移する。
 *
 * 表示ゲート(registry:auto_fetch AND capabilities.registryPurchase)は親側で行う
 * (課金スイッチ休眠中の本番ではボタン自体を出さない=押して 501 にしない)。
 * 種別(所有者事項/全部事項)は単発取得の確認画面と同じ文言で選ばせる。
 */
import { useRef, useState } from "react";
import {
  useRegistryPreflight,
  RegistryPreflightCountLines,
  RegistryTargetSummary,
} from "@/components/properties/registry-preflight-warnings";
import { useRouter } from "next/navigation";
import { createRegistryFetchJob } from "@/lib/api-client";

interface Props {
  /** チェック中の物件ID(親が「今読み込んでいる物件 ∩ 選択」で確定して渡す)。 */
  propertyIds: string[];
  /** 一覧の読み込み中など、操作を止めたいとき。 */
  disabled?: boolean;
}

export function RegistryBulkFetchButton({ propertyIds, disabled }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [certificateType, setCertificateType] = useState<"owner" | "all">("owner");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // モーダルを開いたときだけ事前確認(取得済み/添付あり/所有者あり)の件数を取得する
  // (発注者要望 2026-08-08: 既に情報がある物件への課金前に気づけるようにする)。
  const preflight = useRegistryPreflight(propertyIds, open);
  // 二重作成(連打/再送)防止。⚠キーは**要求内容(対象物件+種別)に紐づける**
  // (@codex #361 P2)。同じ内容の再送(通信失敗)ではキーを保ち冪等に、内容が変わったら
  // 新しいキーにローテーションする(古いキーのまま送るとサーバーが指紋不一致 409 を返し
  // 続けて詰まる)。
  const idemKeyRef = useRef<string | null>(null);
  const idemSigRef = useRef<string | null>(null);

  const count = propertyIds.length;

  const handleConfirm = async () => {
    if (creating || count === 0) return;
    const sig = `${[...propertyIds].sort().join(",")}|${certificateType}`;
    if (!idemKeyRef.current || idemSigRef.current !== sig) {
      idemKeyRef.current =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      idemSigRef.current = sig;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await createRegistryFetchJob(
        propertyIds,
        certificateType,
        idemKeyRef.current, // 再送時の二重作成を防ぐ(サーバーが同じキーを冪等化)
        // ⚠**この画面で見せた内容**を承認の根拠として送る（@codex #373 R6 P1）。
        //   見せてから作成するまでの間に他の担当者が住所や番号を変えると、
        //   作成時に読み直した新しい値で処理が進み、承認していないものを買う。
        Object.fromEntries(
          [...preflight.flagsById.values()].map((f) => [
            f.propertyId,
            f.fingerprintHash,
          ]),
        ),
      );
      idemKeyRef.current = null; // 成功 → 次は新しいキー
      idemSigRef.current = null;
      setOpen(false);
      router.push(`/properties/registry-fetch/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "一括取得の作成に失敗しました");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setCertificateType("owner");
          setOpen(true);
        }}
        disabled={disabled || count === 0}
        className={
          "rounded border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-sm font-medium " +
          "text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60 " +
          "dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
        }
        title="チェックした物件の謄本をまとめて取得します(番号なし・所在で検索できる物件が対象)"
      >
        謄本を一括取得{count > 0 ? `（${count}件）` : ""}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="謄本の一括取得"
          onClick={() => !creating && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              謄本を一括取得（{count}件）
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              チェックした物件の謄本をまとめて取得します。1件ずつ順番に取得し、
              進捗画面で状況を確認できます。
              <br />
              ⚠ 取得した件数ぶんの<strong>利用料金が発生します</strong>。
              番号がある・所在が不足している物件は自動で対象外（要手動）になります。
            </p>
            <RegistryPreflightCountLines state={preflight} />
            {/* ⚠一括は候補1件で自動購入するので、承認の前に「何を買うか」を見せる。 */}
            <RegistryTargetSummary state={preflight} />

            <fieldset className="mt-4 space-y-2 text-sm">
              <legend className="font-medium text-gray-700 dark:text-gray-200">
                取得する種類
              </legend>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="bulkCertificateType"
                  checked={certificateType === "owner"}
                  onChange={() => setCertificateType("owner")}
                />
                所有者事項（所有者の確認向け・料金が安い）
              </label>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="bulkCertificateType"
                  checked={certificateType === "all"}
                  onChange={() => setCertificateType("all")}
                />
                全部事項（権利関係まで・料金が高い）
              </label>
              {certificateType === "all" && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  ※全部事項は過去の所有者も載るため、所有者一覧への自動反映は行わず、PDFの添付のみになります。
                </p>
              )}
            </fieldset>

            {error && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={creating}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                やめる
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={
                  creating ||
                  count === 0 ||
                  preflight.pending ||
                  // ⚠何を取りに行くかが分からないうちは実行させない（fail closed）。
                  //   一括は候補1件で自動購入まで進むので、参考情報の失敗とは扱いが違う。
                  preflight.targetsUnavailable
                }
                title={preflight.pending ? "事前確認中です" : undefined}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {creating
                  ? "作成中…"
                  : preflight.pending
                    ? "確認中..."
                    : `${certificateType === "all" ? "全部事項" : "所有者事項"}で取得を開始`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
