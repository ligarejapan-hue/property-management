"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { listCandidatePins, type CandidatePinRow } from "@/lib/api-client";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import ConvertPinToPropertyModal from "@/components/field-survey/convert-pin-to-property-modal";
import { formatPinCreatedAt } from "@/lib/field-survey-pin-util";
import {
  describeCandidateAge,
  msUntilNextJstMidnight,
  CANDIDATE_LIST_LIMIT,
} from "@/lib/field-survey-candidate-util";

/**
 * 事務所向け「物件化の完成待ち」一覧。
 * - 未変換の候補 (pinType=candidate × status=open) を listCandidatePins で取得。
 *   座標・memo 本文は view=map 射影で除外される (hasMemo のみ)。
 * - property:write を持つ人にだけ「物件にする」ボタンを出す (fail-closed)。
 *   実際の認可は convert endpoint がサーバー側で行う。
 * - 放置の可視化: 件数と経過日数 (7日以上は強調) を表示し、取得上限
 *   (CANDIDATE_LIST_LIMIT) に達したら「古い候補が表示されていない」警告を出す。
 * - 物件化成功後はそのまま新しい物件ページへ移動する (次アクション =
 *   謄本取得 / DM 判断は物件詳細にあるため、検索し直しの手間を無くす)。
 */
export default function CandidateQueue() {
  const router = useRouter();
  const {
    permissions,
    permissionsLoading,
    permissionsError,
    refetchPermissions,
  } = useScreenProtection();

  // 進入時 refresh (FieldSurveyMap と同方針・Codex P2): provider は dashboard
  // layout の mount 時に 1 回取得するだけのため、滞在中の権限変更 (read 剥奪 /
  // 付与) に追従できない。ページ進入あたり 1 回だけ再取得し、完了までは
  // 権限判定を保留 (= ボタン非表示・遷移しない安全側) に倒す。
  const permissionsRefreshRequestedRef = useRef(false);
  const [permissionsRefreshPending, setPermissionsRefreshPending] =
    useState(true);
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    permissionsRefreshRequestedRef.current = true;
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [refetchPermissions]);

  const canWriteProperty =
    !permissionsRefreshPending &&
    !permissionsLoading &&
    !permissionsError &&
    (permissions ?? []).some(
      (p) => p.resource === "property" && p.action === "write" && p.granted === true,
    );
  // 物件化成功後の遷移先判定。property:read が無い構成 (write のみ付与) では
  // 物件詳細が 403 になるため遷移せず一覧に留まる (Codex P2)。判定不能・
  // 再取得中も安全側 (留まる) に倒す。
  const canReadProperty =
    !permissionsRefreshPending &&
    !permissionsLoading &&
    !permissionsError &&
    (permissions ?? []).some(
      (p) => p.resource === "property" && p.action === "read" && p.granted === true,
    );

  const [rows, setRows] = useState<CandidatePinRow[] | null>(null);
  // 物件詳細へ遷移できない権限構成で物件化した時の成功表示 (一覧に留まる)。
  const [convertedNotice, setConvertedNotice] = useState(false);
  // 取得上限超過 (古い候補が data に含まれていない) の正確な通知は API の
  // truncated フラグで受ける (件数一致だけではちょうど上限件数と区別できない)。
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [convertPinId, setConvertPinId] = useState<string | null>(null);
  // 経過日数の基準時刻。render 中の new Date() 連発を避け、読込ごとに固定する。
  const [ageBase, setAgeBase] = useState<Date | null>(null);
  // 並び順。上限超過時に古い候補へ到達できるよう「古い順」を選べる
  // (Codex P2: 「古いものから処理して」と案内しつつ古い分が開けない矛盾の解消)。
  const [order, setOrder] = useState<"newest" | "oldest">("newest");

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listCandidatePins(order);
      setRows(r.data);
      setTruncated(r.truncated === true);
      setAgeBase(new Date());
    } catch {
      setError("候補の取得に失敗しました。再読み込みしてください。");
    }
  }, [order]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: 一覧データ取得エフェクトの標準形（sales-sheets/new と同様）。取得開始時に error をリセットする同期 setState。
    void load();
  }, [load]);

  // 画面を開いたまま JST の日付を跨いだ場合に「今日/昨日/N日前」と放置強調を
  // 更新する (Codex P2: ageBase が読込時のまま固定だと翌日以降ずれ続ける)。
  // ageBase 更新のたびに次の 0:00 へ再スケジュールされる自己継続タイマー。
  useEffect(() => {
    if (!ageBase) return;
    const timer = setTimeout(() => {
      setAgeBase(new Date());
    }, msUntilNextJstMidnight(new Date()));
    return () => clearTimeout(timer);
  }, [ageBase]);

  return (
    <div className="p-4 sm:p-6">
      <h1 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
        物件化の完成待ち
        {rows !== null && (
          <span
            data-testid="candidate-count"
            className="ml-2 align-middle rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
          >
            {rows.length}
            {truncated ? "件以上" : "件"}
          </span>
        )}
      </h1>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          現地で撮影された「物件化候補」で、まだ物件になっていないものです。
        </p>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="並び順">
          {(
            [
              ["newest", "新しい順"],
              ["oldest", "古い順"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-testid={`candidate-order-${value}`}
              onClick={() => setOrder(value)}
              aria-pressed={order === value}
              className={
                order === value
                  ? "rounded border border-emerald-400 bg-emerald-50 px-2 py-1 font-semibold text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {convertedNotice && (
        <div
          role="status"
          data-testid="candidate-converted-notice"
          className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
        >
          物件を作成しました。続きの入力 (謄本取得・DM判断) は物件の閲覧権限を持つ担当者にお願いしてください。
        </div>
      )}

      {rows !== null && truncated && (
        <div
          role="status"
          data-testid="candidate-limit-warning"
          className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
        >
          候補が{CANDIDATE_LIST_LIMIT}件を超えているため、
          {order === "newest"
            ? "これより古い候補は表示されていません。「古い順」に切り替えると、放置されている古い候補から確認できます。"
            : "これより新しい候補は表示されていません(古い順で表示中)。古いものから物件化を進めて減らしてください。"}
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
          {rows.map((r) => {
            const age = ageBase
              ? describeCandidateAge(r.createdAt, ageBase)
              : { label: "", days: 0, stale: false };
            return (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <span>{formatPinCreatedAt(r.createdAt)}</span>
                    {age.label && (
                      <span
                        data-testid="candidate-age"
                        className={
                          age.stale
                            ? "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                            : "text-[11px] text-gray-500 dark:text-gray-400"
                        }
                      >
                        {age.label}
                        {age.stale ? "・放置気味" : ""}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{r.hasMemo ? "メモあり" : "メモなし"}</div>
                </div>
                {canWriteProperty && (
                  <button
                    type="button"
                    onClick={() => {
                      setConvertedNotice(false);
                      setConvertPinId(r.id);
                    }}
                    className="shrink-0 rounded border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
                  >
                    物件にする
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {convertPinId && (
        <ConvertPinToPropertyModal
          pinId={convertPinId}
          onClose={() => setConvertPinId(null)}
          onConverted={(propertyId) => {
            setConvertPinId(null);
            if (canReadProperty) {
              // 次アクション (謄本取得 / DM 判断) は物件詳細にあるため直行する。
              router.push(`/properties/${propertyId}`);
            } else {
              // 閲覧権限が無い構成では物件詳細が 403 になるため一覧に留まり、
              // 成功と引き継ぎ先を案内する。
              setConvertedNotice(true);
              void load();
            }
          }}
        />
      )}
    </div>
  );
}
