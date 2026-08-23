"use client";

/**
 * Phase 1-G: 調査ピン詳細パネル。
 *
 * - desktop (>= md): 右側固定パネル
 * - mobile: bottom sheet 風 fixed div
 * - GET /api/field-survey/pins/[id] を呼んで詳細を取得 (memo 本文も含む)
 * - own pin のみ編集 UI を出す。他人 pin は read_all/manage を持っていても
 *   閲覧のみ (Phase 1-G 方針)。
 * - memo 表示は React テキストノード。raw HTML 描画は禁止。
 * - lat / lng / accuracy / raw response 全文 / API key / PII を console や
 *   error UI に出さない。
 * - optimistic update しない。保存中は read-only + disable。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  FIELD_SURVEY_PIN_STATUSES,
  FIELD_SURVEY_PIN_TYPES,
  buildPinPatch,
  formatPinCreatedAt,
  formatPinStatus,
  formatPinType,
  type FieldSurveyPinStatus,
  type FieldSurveyPinType,
} from "@/lib/field-survey-pin-util";
import { FIELD_SURVEY_MEMO_MAX_LEN } from "@/lib/field-survey-constants";
import {
  useFieldSurveyPinMutations,
  type PinDetail,
} from "@/components/field-survey/use-field-survey-pin-mutations";
import {
  hasInFlightPhotoUpload,
  pendingPhotoDeleteIds,
  subscribePhotoMutationSettled,
  takeLastPhotoMutationFailure,
  useFieldSurveyPinPhotoMutations,
  type PinPhoto,
} from "@/components/field-survey/use-field-survey-pin-photo-mutations";
import ConvertPinToPropertyModal from "@/components/field-survey/convert-pin-to-property-modal";

interface PinDetailPanelProps {
  pinId: string;
  /** 親 (FieldSurveyMap) が server-side で確定したログインユーザー id。 */
  currentUserId: string;
  /** field_survey:manage を granted で持つか。他人 pin の削除ボタン表示に使う。 */
  canManage?: boolean;
  /** property:write を持つか。候補ピンの「物件にする」ボタン表示に使う。 */
  canWriteProperty?: boolean;
  /** Phase 1-J: 履歴閲覧など完全 read-only 表示。編集/削除/写真追加削除を出さない。 */
  readOnly?: boolean;
  onClose: () => void;
  /** 保存成功 → marker 再 fetch を親側でトリガするためのコールバック。 */
  onUpdated?: (updated: PinDetail) => void;
  /** 論理削除の成功通知 → 親側で panel を閉じ marker 再 fetch する。 */
  onDeleted?: (pinId: string) => void;
  /**
   * 「作業中 (編集中の下書き / 削除確認 / 物件化 / 写真の送信・削除中)」の
   * 変化通知。連続ピンモードでは詳細パネル表示中も地図タップが有効なため、
   * 親 (FieldSurveyMap) はこれが true の間、新規ピン作成の地図タップを無視して
   * パネルを黙って閉じない (下書き・送信中の写真の喪失防止。Codex P2)。
   */
  onBusyStateChange?: (busy: boolean) => void;
}

export default function PinDetailPanel({
  pinId,
  currentUserId,
  canManage = false,
  canWriteProperty = false,
  readOnly = false,
  onClose,
  onUpdated,
  onDeleted,
  onBusyStateChange,
}: PinDetailPanelProps) {
  const mutations = useFieldSurveyPinMutations();
  const [detail, setDetail] = useState<PinDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftPinType, setDraftPinType] = useState<FieldSurveyPinType>("candidate");
  const [draftStatus, setDraftStatus] = useState<FieldSurveyPinStatus>("open");
  const [draftMemo, setDraftMemo] = useState<string>("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showConvert, setShowConvert] = useState(false);
  // 写真セクション (子) の送信・削除中フラグ。作業中判定に合流させる。
  const [photoSectionBusy, setPhotoSectionBusy] = useState(false);

  // 作業中 = 下書きが失われ得る状態 (編集フォーム / 削除確認 / 物件化 modal)
  // または進行中の通信 (保存 / 削除 / 写真送信・削除)。
  const hasUnfinishedWork =
    editing ||
    confirmingDelete ||
    showConvert ||
    photoSectionBusy ||
    mutations.updateLoading ||
    mutations.deleteLoading;
  useEffect(() => {
    onBusyStateChange?.(hasUnfinishedWork);
  }, [hasUnfinishedWork, onBusyStateChange]);
  // unmount 時は必ず false へ戻す (親 ref に stale な true を残さない)。
  useEffect(() => {
    return () => {
      onBusyStateChange?.(false);
    };
  }, [onBusyStateChange]);

  // Codex P2 (本 fix): props.pinId は handleSave 内で stale closure になりうる。
  // PATCH レスポンス到達時に「現在表示中の pinId」と一致するかを ref で再確認
  // するため、毎 render で同期する最新値 ref を保持する。
  const latestPinIdRef = useRef(pinId);
  useEffect(() => {
    latestPinIdRef.current = pinId;
  }, [pinId]);

  const loadDetail = useCallback(async () => {
    const r = await mutations.fetchPinDetail(pinId);
    if (!r.ok || !r.data) return;
    // Codex P2: GET 完了時に pinId が他の pin に切り替わっていたら state を
    // 汚さない。pinId と data.id を再照合する。
    if (r.data.id !== pinId) return;
    setDetail(r.data);
    const t = r.data.pinType;
    const s = r.data.status;
    setDraftPinType(
      (FIELD_SURVEY_PIN_TYPES as readonly string[]).includes(t)
        ? (t as FieldSurveyPinType)
        : "candidate",
    );
    setDraftStatus(
      (FIELD_SURVEY_PIN_STATUSES as readonly string[]).includes(s)
        ? (s as FieldSurveyPinStatus)
        : "open",
    );
    setDraftMemo(r.data.memo ?? "");
  }, [mutations, pinId]);

  // Codex P2: pinId が変わった瞬間に古い detail / editing / form / error を
  // 同期 reset する。新しい GET が完了するまで旧 own pin の編集 UI が残らない
  // ようにするため、loadDetail 前にこの reset を必ず実行する。
  useEffect(() => {
    setDetail(null);
    setEditing(false);
    setConfirmingDelete(false);
    setDraftPinType("candidate");
    setDraftStatus("open");
    setDraftMemo("");
    void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinId]);

  // Codex P2: 編集 UI 表示条件は (detail が存在 && detail.id === pinId &&
  // detail.staffUserId === currentUserId)。pin 切替直後の race で旧 own pin
  // の編集 UI が新 pinId に対して残らないことを保証する。
  // manage 権限を持っていても、Phase 1-G では他人 pin の編集 UI を出さない。
  const isFresh = !!detail && detail.id === pinId;
  // readOnly 時は編集系をすべて抑止する。canEditOwn は編集 UI (EditView / 写真) 用。
  const isOwn = isFresh && detail!.staffUserId === currentUserId;
  const canEditOwn = !readOnly && isOwn;
  // Phase 1-I: 論理削除ボタンの表示可否。own または canManage、かつ未アーカイブのみ。
  // canManage は親が field_survey:manage の granted で算出した値だけを使う
  // (閲覧専用の上位権限では false になり、他人 pin に削除ボタンは出ない)。
  // readOnly (履歴閲覧) では削除ボタンも出さない。
  const canDelete =
    !readOnly &&
    isFresh &&
    (isOwn || canManage) &&
    detail!.status !== "archived";

  // 候補ピンの物件化ボタン: 未変換 (propertyId 無し) の candidate で
  // property:write を持つときのみ。サーバー側 (convert endpoint) が認可の正。
  const canConvert =
    !readOnly &&
    isFresh &&
    detail!.pinType === "candidate" &&
    detail!.propertyId == null &&
    detail!.status === "open" &&
    canWriteProperty === true;

  const handleConverted = async () => {
    setShowConvert(false);
    // 変換後は pin が closed + propertyId 付きに変わる。再取得して表示を更新し、
    // 親に通知して marker を再 fetch させる。
    const refreshed = await mutations.fetchPinDetail(pinId);
    if (refreshed.ok && refreshed.data && refreshed.data.id === pinId) {
      setDetail(refreshed.data);
      onUpdated?.(refreshed.data);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    const targetPinId = pinId;
    if (detail.id !== targetPinId) return;
    const r = await mutations.deletePin(targetPinId);
    if (!r.ok) return; // 失敗は mutations.deleteError 経由で汎用表示
    if (latestPinIdRef.current !== targetPinId) return;
    setConfirmingDelete(false);
    onDeleted?.(targetPinId);
  };

  const handleSave = async () => {
    if (!detail) return;
    // Codex P2: PATCH 直前に stale / 他人 pin への送信を再確認する。
    // saveTargetPinId は PATCH に投げる対象を確定するための snapshot。
    const saveTargetPinId = pinId;
    if (detail.id !== saveTargetPinId) return;
    if (detail.staffUserId !== currentUserId) return;
    // 巡回に紐づかない pin は種類を候補に固定する (編集 UI も選択肢を出さないが、
    // 開いている間に紐づけが外れた場合でも stale な下書きを送らないよう送信側でも
    // 倒す = API の 422 に当てない)。
    const effectiveDraftPinType: FieldSurveyPinType =
      detail.sessionId === null ? "candidate" : draftPinType;
    const patch = buildPinPatch(
      { pinType: detail.pinType, status: detail.status, memo: detail.memo },
      { pinType: effectiveDraftPinType, status: draftStatus, memo: draftMemo },
    );
    if (!patch) {
      // 変更なし: PATCH を打たず編集モード終了
      setEditing(false);
      return;
    }
    const r = await mutations.updatePin(saveTargetPinId, patch);
    if (!r.ok || !r.data) return;
    // Codex P2 (本 fix): PATCH レスポンス到達時に、stale closure の pinId では
    // なく「最新の」props.pinId と比較する。
    // 旧実装は r.data.id === (closure 内の) pinId だけ見ていたため、
    // pin A 保存中に pin B へ切替えるとレスポンスが現在表示中の B パネルに
    // 流入していた。3 段ガード:
    //   1) ref が捕捉した saveTargetPinId のままか (= 切替されていない)
    //   2) サーバ応答 id が ref と一致するか
    //   3) サーバ応答 id が捕捉 target と一致するか (念のため二重)
    if (latestPinIdRef.current !== saveTargetPinId) return;
    if (r.data.id !== latestPinIdRef.current) return;
    if (r.data.id !== saveTargetPinId) return;
    setDetail(r.data);
    setEditing(false);
    onUpdated?.(r.data);
  };

  return (
    <aside
      role="complementary"
      aria-label="調査ピン詳細"
      data-testid="pin-detail-panel"
      className={
        "fixed z-40 bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 " +
        // mobile: bottom sheet
        "inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-lg " +
        // desktop: 右側固定パネル
        "md:inset-y-0 md:right-0 md:bottom-auto md:left-auto md:w-96 md:max-h-none md:rounded-none md:rounded-l-lg"
      }
    >
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 p-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">調査ピン詳細</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
        >
          ×
        </button>
      </div>

      <div className="p-3 text-sm">
        {mutations.detailLoading && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400">読み込み中…</p>
        )}
        {mutations.detailError && (
          <p
            role="status"
            className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
          >
            {mutations.detailError}
          </p>
        )}

        {isFresh && !editing && (
          <ReadOnlyView
            detail={detail!}
            isOwn={isOwn}
            canEdit={canEditOwn}
            onEdit={() => setEditing(true)}
            canConvert={canConvert}
            onConvert={() => setShowConvert(true)}
          />
        )}

        {isFresh && editing && canEditOwn && (
          <EditView
            detail={detail!}
            draftPinType={draftPinType}
            draftStatus={draftStatus}
            draftMemo={draftMemo}
            saving={mutations.updateLoading}
            serverError={mutations.updateError}
            onChangePinType={setDraftPinType}
            onChangeStatus={setDraftStatus}
            onChangeMemo={setDraftMemo}
            onCancel={() => {
              // 編集破棄: detail の現状で reset
              setEditing(false);
              setDraftPinType(
                (FIELD_SURVEY_PIN_TYPES as readonly string[]).includes(
                  detail.pinType,
                )
                  ? (detail.pinType as FieldSurveyPinType)
                  : "candidate",
              );
              setDraftStatus(
                (FIELD_SURVEY_PIN_STATUSES as readonly string[]).includes(
                  detail.status,
                )
                  ? (detail.status as FieldSurveyPinStatus)
                  : "open",
              );
              setDraftMemo(detail.memo ?? "");
            }}
            onSave={() => {
              void handleSave();
            }}
          />
        )}

        {isFresh && !editing && (
          <PinPhotoSection
            pinId={pinId}
            canEdit={canEditOwn && detail!.status !== "archived"}
            onBusyChange={setPhotoSectionBusy}
          />
        )}

        {canDelete && !editing && (
          <div className="mt-4 border-t border-gray-200 dark:border-gray-800 pt-3">
            {!confirmingDelete ? (
              <button
                type="button"
                data-testid="pin-detail-delete-button"
                onClick={() => setConfirmingDelete(true)}
                className="w-full rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-500/20"
              >
                削除
              </button>
            ) : (
              <div
                role="alertdialog"
                aria-modal="true"
                data-testid="pin-detail-delete-confirm"
                className="rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-2 text-[12px] text-red-900 dark:text-red-300"
              >
                <p className="font-semibold">この調査ピンを削除しますか？</p>
                <p className="mt-1 text-[11px]">
                  削除すると地図上の通常表示から非表示になります。
                </p>
                {deleteErrorMessage(mutations.deleteError) && (
                  <p
                    role="status"
                    className="mt-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
                  >
                    {deleteErrorMessage(mutations.deleteError)}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={mutations.deleteLoading}
                    className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDelete();
                    }}
                    disabled={mutations.deleteLoading}
                    data-testid="pin-detail-delete-confirm-button"
                    className="rounded border border-red-600 bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {mutations.deleteLoading ? "削除中…" : "削除する"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {showConvert && (
          // ⚠**key で pin ごとに作り直す** (@codex #352 P2 の同類を根で止める)。
          // このパネルは pinId が変わっても unmount されず、showConvert も
          // リセットしない。key が無いと modal の instance が使い回され、
          // **前の pin に入力した住所・種別・地番がそのまま次の pin の
          // フォームに残る**(座標だけの問題ではない)。
          <ConvertPinToPropertyModal
            key={pinId}
            pinId={pinId}
            onClose={() => setShowConvert(false)}
            onConverted={handleConverted}
          />
        )}
      </div>
    </aside>
  );
}

// 削除失敗の汎用文言。権限エラー (403) は削除文脈の文言に差し替える。
// 座標 / memo / 内部情報は出さない。
function deleteErrorMessage(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === "権限がありません。") return "このピンを削除する権限がありません";
  return raw;
}

// Phase 1-H: pin 写真セクション (一覧 / 追加 / プレビュー)。
// - own pin かつ非アーカイブのみ編集 UI を出す (canEdit)。他人 pin は閲覧のみ。
// - thumbnail / preview は fileUrl (/uploads/...) を使う (内部 key は保持しない)。
// - HEIC 等でブラウザが表示できない場合は代替表示を出す (onError)。
// - 画像情報 / fileUrl / fileName を console に出さない。
function PinPhotoSection({
  pinId,
  canEdit,
  onBusyChange,
}: {
  pinId: string;
  canEdit: boolean;
  /** 写真の送信・削除中の変化通知 (親 panel の作業中判定に合流)。 */
  onBusyChange?: (busy: boolean) => void;
}) {
  const photoMutations = useFieldSurveyPinPhotoMutations();
  // この写真セクションが始めた操作の識別子 (ライフタイム中不変)。
  // 自分が始めた失敗は hook の uploadError / deleteError で出るので、
  // 「離れている間に失敗しました」の案内は**他インスタンス由来だけ**に限る。
  const ownInstanceId = photoMutations.instanceId;
  const [photos, setPhotos] = useState<PinPhoto[]>([]);
  // 送信・削除の進行中を親へ通知する (unmount 時は必ず false へ戻す)。
  const photoBusy =
    photoMutations.uploadLoading || photoMutations.deleteLoading;
  useEffect(() => {
    onBusyChange?.(photoBusy);
  }, [photoBusy, onBusyChange]);
  useEffect(() => {
    return () => {
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set());
  // パネルを閉じて開き直したとき、まだ送信中の写真があるか
  // (この一覧には未反映でも、送信は続いている)。
  const [detachedUploading, setDetachedUploading] = useState(false);
  // パネルを離れている間に失敗した送信・削除の案内 (hook の state は
  // unmount 後の更新を抑止するため、こちらで受け取って表示する)。
  const [detachedError, setDetachedError] = useState<string | null>(null);
  // パネルを離れている間も走っている削除の対象 (一覧にはまだ残って見える)。
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const latestPinIdRef = useRef(pinId);
  useEffect(() => {
    latestPinIdRef.current = pinId;
  }, [pinId]);

  // reload は photoMutations 経由で毎レンダー変わるため、購読 effect からは
  // ref 経由で最新を呼ぶ (effect を貼り直さない)。
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  const reload = useCallback(async () => {
    const r = await photoMutations.listPhotos(pinId);
    if (!r.ok || !r.data) return;
    if (latestPinIdRef.current !== pinId) return;
    setPhotos(r.data);
    setBrokenIds(new Set());
  }, [photoMutations, pinId]);

  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    setPhotos([]);
    setPreviewId(null);
    setBrokenIds(new Set());
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinId]);

  // ⚠閉じてすぐ開き直すと、初回 GET が送信中 upload の commit より先に終わり、
  // **保存された写真が次の再読込まで見えない**ことがある (@codex #331 R1)。
  // 利用者は消えたと思って同じ写真をもう一度送る (= 重複)。
  // 削除も同じで、**削除済みの写真が残り**、もう一度消そうとして 404 になる。
  // 送信中があれば案内を出し、upload / delete どちらの完了でも自動で読み直す。
  //
  // ⚠**この effect の依存は pinId だけにする** (@codex #331 R1)。
  // reload は photoMutations(毎レンダー新しいオブジェクト)に依存するため
  // 毎レンダー変わる。deps に入れると、コールバックが失敗を表示した直後の
  // 再レンダーで effect が再実行され、**セットしたエラーがその場で消える**
  // (= 案内が一瞬も出ない)。購読も毎レンダー張り替わる。
  // reload は ref 経由で最新を呼ぶ。
  useEffect(() => {
    setDetachedUploading(hasInFlightPhotoUpload(pinId));
    setPendingDeleteIds(pendingPhotoDeleteIds(pinId));
    // 開く前に確定していた失敗も拾う (通知は購読中しか届かない)。
    // pin 切替時は前の pin のエラーを消す意味も兼ねる。
    setDetachedError(takeLastPhotoMutationFailure(pinId)?.error ?? null);
    return subscribePhotoMutationSettled((settledPinId, outcome) => {
      if (settledPinId !== pinId) return;
      setDetachedUploading(hasInFlightPhotoUpload(pinId));
      setPendingDeleteIds(pendingPhotoDeleteIds(pinId));
      // ⚠失敗をここで出さないと、「出ますのでお待ちください」と案内したまま
      // 何も出ず・エラーも出ない状態になる。写真が端末のピッカーにしか無い
      // 場面なので、必ず気づける形にする。
      //
      // ⚠**無関係な成功で失敗案内を消さない** (@codex #331 R1)。離れている間の
      // 送信が失敗し、そのあと新しく送った写真が成功すると、成功側が案内を
      // 消してしまい**最初の写真が失われたことが永久に隠れる**。案内は
      // 利用者が閉じるか、別の pin を開くまで残す。
      if (!outcome.ok) {
        // ⚠**自分が始めた失敗も必ず消費する** (@codex #331 R1)。表示しないからと
        // いって残すと、次にこのパネルを開いた/この pin に戻ったときに
        // 「離れている間に失敗しました」として蒸し返され、しかも**その後
        // 再送して成功していても出てしまう**。
        takeLastPhotoMutationFailure(pinId);
        // 表示するのは他インスタンス由来だけ (自分の分は hook の
        // uploadError / deleteError が出している)。
        if (outcome.ownerId !== ownInstanceId) {
          setDetachedError(outcome.error ?? null);
        }
      }
      void reloadRef.current();
    });
  }, [pinId, ownInstanceId]);

  const handleFilePicked = async (file: File | null) => {
    if (!file) return;
    const r = await photoMutations.uploadPhoto(pinId, file);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    if (r.ok) await reload();
  };

  // 第1弾 A1: 削除は必ず確認をはさむ(現地写真は撮り直しが効かない)。
  const [confirmDeletePhotoId, setConfirmDeletePhotoId] = useState<string | null>(
    null,
  );
  const handleDelete = async (photoId: string) => {
    const r = await photoMutations.deletePhoto(pinId, photoId);
    if (r.ok) {
      if (previewId === photoId) setPreviewId(null);
      await reload();
    }
  };

  const markBroken = (photoId: string) => {
    setBrokenIds((prev) => {
      const next = new Set(prev);
      next.add(photoId);
      return next;
    });
  };

  const preview = photos.find((p) => p.id === previewId) ?? null;

  return (
    <section data-testid="pin-detail-photos" className="mt-4">
      <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">写真</div>

      {photoMutations.listLoading && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">読み込み中…</p>
      )}
      {photoMutations.listError && (
        <p
          role="status"
          className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
        >
          {photoMutations.listError}
        </p>
      )}

      {photos.length === 0 && !photoMutations.listLoading ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">(写真なし)</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <li key={p.id} className="relative">
              <button
                type="button"
                onClick={() => setPreviewId(p.id)}
                data-testid="pin-photo-thumb"
                className="block h-20 w-full overflow-hidden rounded border border-gray-200 dark:border-gray-800"
              >
                {brokenIds.has(p.id) ? (
                  <span className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-800 text-center text-[10px] text-gray-500 dark:text-gray-400">
                    プレビューを表示できません
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.thumbnailUrl ?? p.fileUrl}
                    alt="調査ピンの写真"
                    onError={() => markBroken(p.id)}
                    // thumbnailUrl が null の場合は原本 (/uploads 原寸) に fallback するため、
                    // 画面外サムネの先読みを抑止する（F11 uploads 配信負荷・C前段）。
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                )}
              </button>
              {/* 第1弾 A1: 削除ボタンをサムネイルの外へ(拡大タップとの押し
                  間違いで、確認なしに現地写真が消えていた)。押すと確認を出す。 */}
              {canEdit && (
                <div className="mt-0.5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirmDeletePhotoId(p.id)}
                    disabled={
                      photoMutations.deleteLoading || pendingDeleteIds.includes(p.id)
                    }
                    data-testid="pin-photo-delete"
                    className="rounded px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-500/10"
                  >
                    {pendingDeleteIds.includes(p.id) ? "削除中…" : "削除"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmDeletePhotoId && (
        <ConfirmDialog
          title="写真を削除しますか？"
          onCancel={() => setConfirmDeletePhotoId(null)}
          onConfirm={() => {
            const id = confirmDeletePhotoId;
            setConfirmDeletePhotoId(null);
            void handleDelete(id);
          }}
        />
      )}

      {preview && !brokenIds.has(preview.id) && (
        <div
          data-testid="pin-photo-preview"
          className="mt-2 rounded border border-gray-200 dark:border-gray-800 p-1"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.fileUrl}
            alt="調査ピンの写真 (プレビュー)"
            onError={() => markBroken(preview.id)}
            className="max-h-64 w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setPreviewId(null)}
            className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 underline hover:text-gray-800 dark:hover:text-gray-100"
          >
            閉じる
          </button>
        </div>
      )}

      {canEdit && (
        <div className="mt-2">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            data-testid="pin-photo-camera-input"
            onChange={(e) => {
              void handleFilePicked(e.target.files?.[0] ?? null);
            }}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="pin-photo-file-input"
            onChange={(e) => {
              void handleFilePicked(e.target.files?.[0] ?? null);
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={photoMutations.uploadLoading}
              data-testid="pin-photo-camera"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
            >
              写真を撮る
            </button>
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={photoMutations.uploadLoading}
              data-testid="pin-photo-add"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
            >
              写真を追加
            </button>
          </div>
          {detachedError && (
            <div
              role="alert"
              data-testid="pin-photo-detached-error"
              className="mt-1 flex items-start gap-2 rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/15 px-2 py-1 text-[11px] text-red-800 dark:text-red-300"
            >
              <span className="flex-1">
                パネルを離れている間の写真の処理が失敗しました（{detachedError}）。
                もう一度お試しください。
              </span>
              <button
                type="button"
                onClick={() => setDetachedError(null)}
                data-testid="pin-photo-detached-error-dismiss"
                className="shrink-0 underline"
              >
                閉じる
              </button>
            </div>
          )}
          {detachedUploading && !photoMutations.uploadLoading && (
            <p
              role="status"
              data-testid="pin-photo-detached-uploading"
              className="mt-1 rounded border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-2 py-1 text-[11px] text-blue-900 dark:text-blue-300"
            >
              前に選んだ写真を送信中です。終わり次第この一覧に出ますので、
              もう一度送らずにお待ちください。
            </p>
          )}
          {photoMutations.uploadError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
            >
              {photoMutations.uploadError}
            </p>
          )}
          {photoMutations.deleteError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
            >
              {photoMutations.deleteError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ReadOnlyView({
  detail,
  isOwn,
  canEdit,
  onEdit,
  canConvert,
  onConvert,
}: {
  detail: PinDetail;
  isOwn: boolean;
  canEdit: boolean;
  onEdit: () => void;
  canConvert?: boolean;
  onConvert?: () => void;
}) {
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] text-gray-800 dark:text-gray-100">
        <dt className="text-gray-500 dark:text-gray-400">種類</dt>
        <dd>{formatPinType(detail.pinType)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">状態</dt>
        <dd>{formatPinStatus(detail.status)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">作成者</dt>
        <dd>{isOwn ? "あなた" : "他スタッフ"}</dd>
        <dt className="text-gray-500 dark:text-gray-400">作成日時</dt>
        <dd>{formatPinCreatedAt(detail.createdAt)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">物件</dt>
        <dd>
          {detail.propertyId ? (
            <a
              href={`/properties/${detail.propertyId}`}
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              紐付け済 →
            </a>
          ) : canConvert ? (
            <button
              type="button"
              onClick={onConvert}
              data-testid="pin-detail-convert-button"
              className="rounded border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
            >
              この場所を物件にする
            </button>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <div className="mt-3">
        <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">メモ</div>
        {/* React text node のみで描画する (raw HTML 描画は使わない)。 */}
        <div
          data-testid="pin-detail-memo"
          className="whitespace-pre-wrap rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-2 py-1 text-[12px] text-gray-800 dark:text-gray-100"
        >
          {detail.memo && detail.memo.length > 0 ? detail.memo : "(なし)"}
        </div>
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          data-testid="pin-detail-edit-button"
          className="mt-3 w-full rounded border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/20 px-2 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-500/30"
        >
          編集
        </button>
      )}
    </>
  );
}

function EditView({
  detail,
  draftPinType,
  draftStatus,
  draftMemo,
  saving,
  serverError,
  onChangePinType,
  onChangeStatus,
  onChangeMemo,
  onCancel,
  onSave,
}: {
  detail: PinDetail;
  draftPinType: FieldSurveyPinType;
  draftStatus: FieldSurveyPinStatus;
  draftMemo: string;
  saving: boolean;
  serverError: string | null;
  onChangePinType: (v: FieldSurveyPinType) => void;
  onChangeStatus: (v: FieldSurveyPinStatus) => void;
  onChangeMemo: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  // 巡回に紐づかない pin (巡回なし撮影) は種類を「物件化候補」に固定する。
  // 巡回外 pin は巡回履歴に出ないため、候補以外にすると完成待ち一覧からも外れ、
  // どの一覧にも出なくなる (API も 422 で拒否する)。選べる形で出して保存時に
  // 422 を返すのが最悪の体験なので、選択肢自体を出さない (@codex #328 R3 P2)。
  const lockPinType = detail.sessionId === null;
  return (
    <>
      {lockPinType ? (
        <div className="mb-3" data-testid="pin-edit-type-locked">
          <p className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
            種類
          </p>
          <p className="text-[11px] text-gray-700 dark:text-gray-200">
            {formatPinType("candidate")}
            <span className="ml-1 text-gray-500 dark:text-gray-400">
              （巡回外の撮影は「物件化の完成待ち」に必ず出すため、種類は変更できません）
            </span>
          </p>
        </div>
      ) : (
        <fieldset className="mb-3" disabled={saving}>
          <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
            種類
          </legend>
          <div className="grid grid-cols-2 gap-1">
            {FIELD_SURVEY_PIN_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1 text-[11px]">
                <input
                  type="radio"
                  name="pin-edit-type"
                  value={t}
                  checked={draftPinType === t}
                  onChange={() => onChangePinType(t)}
                  data-testid={`pin-edit-type-${t}`}
                />
                <span className="dark:text-gray-200">{formatPinType(t)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="mb-3" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          状態
        </legend>
        <div className="flex flex-wrap gap-2">
          {FIELD_SURVEY_PIN_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-[11px]">
              <input
                type="radio"
                name="pin-edit-status"
                value={s}
                checked={draftStatus === s}
                onChange={() => onChangeStatus(s)}
                data-testid={`pin-edit-status-${s}`}
              />
              <span className="dark:text-gray-200">{formatPinStatus(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-200">
          メモ
        </span>
        <textarea
          value={draftMemo}
          disabled={saving}
          onChange={(e) => onChangeMemo(e.target.value)}
          maxLength={FIELD_SURVEY_MEMO_MAX_LEN}
          rows={3}
          data-testid="pin-edit-memo"
          className="w-full rounded border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
        />
        <span className="mt-1 block text-right text-[10px] text-gray-400 dark:text-gray-500">
          {draftMemo.length} / {FIELD_SURVEY_MEMO_MAX_LEN}
        </span>
      </label>

      {serverError && (
        <p
          role="status"
          className="mb-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
        >
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="pin-edit-save-button"
          className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {/* updatedAt の表示はしない (UI 上の Hint としては不要) */}
      <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500">
        ID: {detail.id.slice(0, 8)}
      </p>
    </>
  );
}
