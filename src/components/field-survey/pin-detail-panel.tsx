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

import { useCallback, useEffect, useState } from "react";
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

interface PinDetailPanelProps {
  pinId: string;
  /** 親 (FieldSurveyMap) が server-side で確定したログインユーザー id。 */
  currentUserId: string;
  onClose: () => void;
  /** 保存成功 → marker 再 fetch を親側でトリガするためのコールバック。 */
  onUpdated?: (updated: PinDetail) => void;
}

export default function PinDetailPanel({
  pinId,
  currentUserId,
  onClose,
  onUpdated,
}: PinDetailPanelProps) {
  const mutations = useFieldSurveyPinMutations();
  const [detail, setDetail] = useState<PinDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftPinType, setDraftPinType] = useState<FieldSurveyPinType>("candidate");
  const [draftStatus, setDraftStatus] = useState<FieldSurveyPinStatus>("open");
  const [draftMemo, setDraftMemo] = useState<string>("");

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
  const isOwn = isFresh && detail!.staffUserId === currentUserId;

  const handleSave = async () => {
    if (!detail) return;
    // Codex P2: PATCH 直前にも stale / 他人 pin への送信を再確認する。
    if (detail.id !== pinId) return;
    if (detail.staffUserId !== currentUserId) return;
    const patch = buildPinPatch(
      { pinType: detail.pinType, status: detail.status, memo: detail.memo },
      { pinType: draftPinType, status: draftStatus, memo: draftMemo },
    );
    if (!patch) {
      // 変更なし: PATCH を打たず編集モード終了
      setEditing(false);
      return;
    }
    const r = await mutations.updatePin(pinId, patch);
    if (!r.ok || !r.data) return;
    // PATCH のレスポンス時にも pinId 切替が起きていないか再確認。
    if (r.data.id !== pinId) return;
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
        "fixed z-40 bg-white shadow-xl border border-gray-200 " +
        // mobile: bottom sheet
        "inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-lg " +
        // desktop: 右側固定パネル
        "md:inset-y-0 md:right-0 md:bottom-auto md:left-auto md:w-96 md:max-h-none md:rounded-none md:rounded-l-lg"
      }
    >
      <div className="flex items-center justify-between border-b border-gray-200 p-3">
        <h2 className="text-sm font-semibold text-gray-800">調査ピン詳細</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="text-gray-500 hover:text-gray-800"
        >
          ×
        </button>
      </div>

      <div className="p-3 text-sm">
        {mutations.detailLoading && (
          <p className="text-[11px] text-gray-500">読み込み中…</p>
        )}
        {mutations.detailError && (
          <p
            role="status"
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
          >
            {mutations.detailError}
          </p>
        )}

        {isFresh && !editing && (
          <ReadOnlyView
            detail={detail!}
            isOwn={isOwn}
            onEdit={() => setEditing(true)}
          />
        )}

        {isFresh && editing && isOwn && (
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
      </div>
    </aside>
  );
}

function ReadOnlyView({
  detail,
  isOwn,
  onEdit,
}: {
  detail: PinDetail;
  isOwn: boolean;
  onEdit: () => void;
}) {
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] text-gray-800">
        <dt className="text-gray-500">種類</dt>
        <dd>{formatPinType(detail.pinType)}</dd>
        <dt className="text-gray-500">状態</dt>
        <dd>{formatPinStatus(detail.status)}</dd>
        <dt className="text-gray-500">作成者</dt>
        <dd>{isOwn ? "あなた" : "他スタッフ"}</dd>
        <dt className="text-gray-500">作成日時</dt>
        <dd>{formatPinCreatedAt(detail.createdAt)}</dd>
        <dt className="text-gray-500">物件</dt>
        <dd>
          {detail.propertyId ? (
            <a
              href={`/properties/${detail.propertyId}`}
              className="text-blue-600 hover:underline"
            >
              紐付け済 →
            </a>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <div className="mt-3">
        <div className="mb-1 text-[11px] text-gray-500">メモ</div>
        {/* React text node のみで描画する (raw HTML 描画は使わない)。 */}
        <div
          data-testid="pin-detail-memo"
          className="whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[12px] text-gray-800"
        >
          {detail.memo && detail.memo.length > 0 ? detail.memo : "(なし)"}
        </div>
      </div>
      {isOwn && (
        <button
          type="button"
          onClick={onEdit}
          data-testid="pin-detail-edit-button"
          className="mt-3 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
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
  return (
    <>
      <fieldset className="mb-3" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold text-gray-700">
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
              <span>{formatPinType(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-3" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold text-gray-700">
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
              <span>{formatPinStatus(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-semibold text-gray-700">
          メモ
        </span>
        <textarea
          value={draftMemo}
          disabled={saving}
          onChange={(e) => onChangeMemo(e.target.value)}
          maxLength={FIELD_SURVEY_MEMO_MAX_LEN}
          rows={3}
          data-testid="pin-edit-memo"
          className="w-full rounded border border-gray-300 px-2 py-1 text-[12px] focus:border-blue-500 focus:outline-none"
        />
        <span className="mt-1 block text-right text-[10px] text-gray-400">
          {draftMemo.length} / {FIELD_SURVEY_MEMO_MAX_LEN}
        </span>
      </label>

      {serverError && (
        <p
          role="status"
          className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
        >
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="pin-edit-save-button"
          className="rounded border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {/* updatedAt の表示はしない (UI 上の Hint としては不要) */}
      <p className="mt-2 text-[10px] text-gray-400">
        ID: {detail.id.slice(0, 8)}
      </p>
    </>
  );
}
