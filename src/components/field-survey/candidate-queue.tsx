"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { listCandidatePins, type CandidatePinRow } from "@/lib/api-client";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import ConvertPinToPropertyModal from "@/components/field-survey/convert-pin-to-property-modal";
import { useFieldSurveyPinMutations } from "@/components/field-survey/use-field-survey-pin-mutations";
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
 * - 物件化しない候補は「候補から外す」で既存の論理削除 (status=archived) に
 *   落とす。表示ゲートは DELETE の認可 (own=field_survey:write / 他人=manage)
 *   と一致させ、押しても 403 になるボタンを出さない (fail-closed)。
 *   currentUserId は server component が確定した値のみ使う (client 推測なし)。
 */
export default function CandidateQueue({
  currentUserId,
}: {
  currentUserId: string | null;
}) {
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
  // 「候補から外す」の表示ゲート。DELETE /pins/[id] の認可 (own=write /
  // 他人=manage) と同じ条件で行単位に出し分ける。再取得中・失敗時は
  // 非表示の安全側 (fail-closed)。
  const canWriteFieldSurvey =
    !permissionsRefreshPending &&
    !permissionsLoading &&
    !permissionsError &&
    (permissions ?? []).some(
      (p) => p.resource === "field_survey" && p.action === "write" && p.granted === true,
    );
  const canManageFieldSurvey =
    !permissionsRefreshPending &&
    !permissionsLoading &&
    !permissionsError &&
    (permissions ?? []).some(
      (p) => p.resource === "field_survey" && p.action === "manage" && p.granted === true,
    );

  const [rows, setRows] = useState<CandidatePinRow[] | null>(null);
  // 「候補から外す」= 既存の論理削除 (status=archived) の再利用。
  const pinMutations = useFieldSurveyPinMutations();
  // 確認ステップ中の行 id (誤タップ即削除を防ぐ 2 段階)。
  const [rejectPinId, setRejectPinId] = useState<string | null>(null);
  // closure から現在の確認対象を読むための鏡 ref。削除リクエストの await 明けに
  // 対象が切り替わっていた古い completion で UI state を触らないための照合に使う
  // (state 更新箇所で同時に更新する)。
  const rejectPinIdRef = useRef<string | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
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
  // 現地写真は「タップした時だけ」読み込む (モバイルの通信量に配慮)。本番は
  // サムネイル生成が無く cover が原寸 (最大 8MB) のため、一覧の全行に常時
  // <img> を置くとスクロールで原寸を大量に落としてしまう。表示中の行だけ
  // <img> を DOM に入れる。
  const [shownPhotoIds, setShownPhotoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const togglePhoto = useCallback((id: string) => {
    setShownPhotoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // 写真の読込失敗を記録して「表示できません」に倒す (/uploads 配信失敗や欠損)。
  const [brokenThumbIds, setBrokenThumbIds] = useState<Set<string>>(
    () => new Set(),
  );
  const markThumbBroken = useCallback((id: string) => {
    setBrokenThumbIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // 並び順切替の競合ガード: 先行リクエストの遅延応答が後から届いても、
  // 現在の並び順のリクエストでなければ破棄する (Codex P2: 切替直後に
  // 古い応答が rows/truncated を上書きし、表示と選択が食い違う)。
  const loadGenerationRef = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    // 取得前に一覧をクリアして「読み込み中」へ切り替える (Codex P2: 並び順
    // 切替の取得が失敗すると、トグルは新しい選択のまま一覧に反対側の
    // データが残って食い違う。クリアしておけば失敗時は空+エラー表示になる)。
    setRows(null);
    setTruncated(false);
    setError(null);
    setShownPhotoIds(new Set());
    setBrokenThumbIds(new Set());
    try {
      const r = await listCandidatePins(order);
      if (generation !== loadGenerationRef.current) return;
      setRows(r.data);
      setTruncated(r.truncated === true);
      setAgeBase(new Date());
    } catch {
      if (generation !== loadGenerationRef.current) return;
      setError("候補の取得に失敗しました。再読み込みしてください。");
    }
  }, [order]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: 一覧データ取得エフェクトの標準形（sales-sheets/new と同様）。取得開始時に error をリセットする同期 setState。
    void load();
  }, [load]);

  // 「外す」確定。論理削除に成功したら一覧を取り直す (行が消えるのが成功の
  // 見た目のフィードバック)。失敗は確認ボックス内に理由を出して留まる。
  // 進行中はトリガー側を disabled にして行またぎ操作を止めるが、二重防御として
  // await 明けに確認対象 (rejectPinIdRef) が変わっていたら古い completion で
  // UI state を触らない。成功時の一覧再取得だけは server 状態が変わったので
  // 常に行う (陳腐化した行を残して「物件にする」を 404 にしない)。
  const handleRejectConfirm = useCallback(
    async (pinId: string) => {
      setRejectError(null);
      const r = await pinMutations.deletePin(pinId);
      const stillCurrent = rejectPinIdRef.current === pinId;
      if (r.ok) {
        if (stillCurrent) {
          rejectPinIdRef.current = null;
          setRejectPinId(null);
        }
        void load();
        return;
      }
      if (stillCurrent) {
        setRejectError(
          r.error
            ? `候補から外せませんでした。${r.error}`
            : "候補から外せませんでした。時間をおいて再試行してください。",
        );
      }
    },
    [pinMutations, load],
  );

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
        // 取得失敗時は上のエラー表示のみ (スピナーを回し続けない)
        error ? null : (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込み中…
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">完成待ちの候補はありません。</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800">
          {rows.map((r) => {
            const age = ageBase
              ? describeCandidateAge(r.createdAt, ageBase)
              : { label: "", days: 0, stale: false };
            const photoCount = r.photoCount ?? 0;
            const photoShown = shownPhotoIds.has(r.id);
            const photoBroken = brokenThumbIds.has(r.id);
            // DELETE の認可と一致: own は write、他人は manage のみ。
            const canReject =
              canManageFieldSurvey ||
              (canWriteFieldSurvey &&
                currentUserId !== null &&
                r.staffUserId === currentUserId);
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
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
                      {/* 場所特定の手がかり: 現地写真。タップした時だけ読み込む
                          (本番はサムネイル生成が無く原寸のため、常時読込を避ける)。 */}
                      {photoCount > 0 && (
                        <button
                          type="button"
                          data-testid="candidate-photo-toggle"
                          onClick={() => togglePhoto(r.id)}
                          aria-expanded={photoShown}
                          className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          <span aria-hidden="true">📷</span>
                          写真{photoCount}枚{photoShown ? "を隠す" : "を見る"}
                        </button>
                      )}
                      {/* 場所特定の導線: 地図を指定ピンへ寄せて開く。座標は URL に
                          載せず (id のみ)、地図側が pin 詳細 API から取得する。 */}
                      <Link
                        data-testid="candidate-map-link"
                        href={`/field-survey/map?focusPin=${r.id}`}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        <span aria-hidden="true">🗺</span>
                        地図で見る
                      </Link>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{r.hasMemo ? "メモあり" : "メモなし"}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canReject && (
                      <button
                        type="button"
                        data-testid="candidate-reject"
                        onClick={() => {
                          setRejectError(null);
                          const next = rejectPinIdRef.current === r.id ? null : r.id;
                          rejectPinIdRef.current = next;
                          setRejectPinId(next);
                        }}
                        disabled={pinMutations.deleteLoading}
                        className="rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        候補から外す
                      </button>
                    )}
                    {canWriteProperty && (
                      <button
                        type="button"
                        onClick={() => {
                          setConvertedNotice(false);
                          setConvertPinId(r.id);
                        }}
                        className="rounded border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
                      >
                        物件にする
                      </button>
                    )}
                  </div>
                </div>
                {/* 「候補から外す」の確認 (2 段階)。行内に出して対象を見失わない。 */}
                {rejectPinId === r.id && (
                  <div
                    data-testid="candidate-reject-confirm-box"
                    className="mt-2 rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-2 text-[12px] text-red-900 dark:text-red-300"
                  >
                    <p className="font-semibold">この候補を外しますか？</p>
                    <p className="mt-1 text-[11px]">
                      外すと一覧から消え、地図の通常表示にも出なくなります
                      (物件にはなりません)。
                    </p>
                    {rejectError && (
                      <p
                        role="status"
                        className="mt-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
                      >
                        {rejectError}
                      </p>
                    )}
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        data-testid="candidate-reject-cancel"
                        onClick={() => {
                          rejectPinIdRef.current = null;
                          setRejectPinId(null);
                          setRejectError(null);
                        }}
                        disabled={pinMutations.deleteLoading}
                        className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
                      >
                        やめる
                      </button>
                      <button
                        type="button"
                        data-testid="candidate-reject-confirm"
                        onClick={() => {
                          void handleRejectConfirm(r.id);
                        }}
                        disabled={pinMutations.deleteLoading}
                        className="rounded border border-red-600 bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {pinMutations.deleteLoading ? "外しています…" : "外す"}
                      </button>
                    </div>
                  </div>
                )}
                {/* タップ時のみ cover 写真を読み込む (ここで初めて <img> を DOM
                    に入れる = 表示していない行は原寸を落とさない)。 */}
                {photoShown && r.coverPhotoUrl && !photoBroken && (
                  <div data-testid="candidate-photo-view" className="mt-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.coverPhotoUrl}
                      alt="現地写真"
                      loading="lazy"
                      onError={() => markThumbBroken(r.id)}
                      className="max-h-48 w-auto max-w-full rounded border border-gray-200 object-contain dark:border-gray-800"
                    />
                    {photoCount > 1 && (
                      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                        代表写真を表示中 (ほか{photoCount - 1}枚)。
                      </p>
                    )}
                  </div>
                )}
                {photoShown && photoBroken && (
                  <p
                    data-testid="candidate-photo-broken"
                    className="mt-2 text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    写真を表示できませんでした。
                  </p>
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
