"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { listCandidatePins, type CandidatePinRow } from "@/lib/api-client";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import ConvertPinToPropertyModal from "@/components/field-survey/convert-pin-to-property-modal";
import { formatPinCreatedAt } from "@/lib/field-survey-pin-util";

/**
 * 事務所向け「物件化の完成待ち」一覧。
 * - 未変換の候補 (pinType=candidate × status=open) を listCandidatePins で取得。
 *   座標・memo 本文は view=map 射影で除外される (hasMemo のみ)。
 * - property:write を持つ人にだけ「物件にする」ボタンを出す (fail-closed)。
 *   実際の認可は convert endpoint がサーバー側で行う。
 */
export default function CandidateQueue() {
  const { permissions, permissionsLoading, permissionsError } = useScreenProtection();
  const canWriteProperty =
    !permissionsLoading &&
    !permissionsError &&
    (permissions ?? []).some(
      (p) => p.resource === "property" && p.action === "write" && p.granted === true,
    );

  const [rows, setRows] = useState<CandidatePinRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convertPinId, setConvertPinId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listCandidatePins();
      setRows(r.data);
    } catch {
      setError("候補の取得に失敗しました。再読み込みしてください。");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: 一覧データ取得エフェクトの標準形（sales-sheets/new と同様）。取得開始時に error をリセットする同期 setState。
    void load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6">
      <h1 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">物件化の完成待ち</h1>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        現地で撮影された「物件化候補」で、まだ物件になっていないものです。
      </p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">完成待ちの候補はありません。</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-800 dark:text-gray-200">{formatPinCreatedAt(r.createdAt)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{r.hasMemo ? "メモあり" : "メモなし"}</div>
              </div>
              {canWriteProperty && (
                <button
                  type="button"
                  onClick={() => setConvertPinId(r.id)}
                  className="shrink-0 rounded border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
                >
                  物件にする
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {convertPinId && (
        <ConvertPinToPropertyModal
          pinId={convertPinId}
          onClose={() => setConvertPinId(null)}
          onConverted={() => {
            setConvertPinId(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
