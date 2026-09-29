"use client";

import { useEffect, useReducer, useState, type Dispatch } from "react";
import { createAgentInquiry, type AgentHit } from "@/lib/api-client";
import {
  EMPTY_DESK_FORM,
  deskFormReducer,
  validateDeskForm,
  materialEmailWarning,
  buildCreateBody,
  isAmbiguousSaveError,
  KIND_LABEL,
  CHANNEL_LABEL,
  type DeskFormAction,
  type DeskFormState,
  splitNewAgentPhone,
} from "@/lib/agent-inquiry/desk-form";
import { formatPhoneJp, isValidPhoneJp } from "@/lib/phone-format-jp";
import { AgentPicker } from "./agent-picker";
import { PropertyPicker } from "./property-picker";
import { AdPermissionChips } from "./ad-permission-chips";
import { AgentCreateModal } from "./agent-create-modal";

const inputCls = "w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900";
const segCls = (on: boolean) =>
  `rounded-md border px-2 py-2 text-sm ${
    on
      ? "border-teal-700 bg-teal-700 font-bold text-white"
      : "border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900"
  }`;

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{children}</p>;
}
function Err({ text }: { text?: string }) {
  return text ? <p className="text-xs text-rose-600">{text}</p> : null;
}

type Errors = ReturnType<typeof validateDeskForm>;

/** 見た目(SSR テスト用)。並び順=業者→問い合わせ者→物件→用件→内見→入口→保存(方針12)。 */
export function InquiryFormView({
  state: s,
  dispatch,
  users,
  errors,
  warning,
  submitting,
  message,
  saveError,
  onSubmit,
  onCreateAgent,
}: {
  state: DeskFormState;
  dispatch: Dispatch<DeskFormAction>;
  users: { id: string; name: string }[];
  errors: Errors;
  warning: string | null;
  submitting: boolean;
  message: string | null;
  /** 保存の失敗(成功の文言と見分けがつくよう赤・role=alert で出す・最終レビュー M-1)。 */
  saveError: string | null;
  onSubmit: () => void;
  onCreateAgent: () => void;
}) {
  return (
    <form
      className="rounded-lg border-2 border-teal-700 bg-white p-3 dark:bg-gray-900"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {/* 保存中はまとめて使えなくする(保存が終わると空に戻るので、その間の入力が消えないように・@codex #459 R11)。 */}
      <fieldset disabled={submitting} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <section className="space-y-1">
        <Label>業者(代表電話・携帯・会社名)</Label>
        <AgentPicker
          query={s.agentQuery}
          selected={s.agent}
          onQuery={(v) => dispatch({ type: "agentQuery", value: v })}
          onPick={(a) => dispatch({ type: "agentSelected", agent: a })}
          onCreateNew={onCreateAgent}
        />
        <Err text={errors.agent} />
      </section>

      <section className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <Label>問い合わせ者</Label>
          <input
            value={s.contactName}
            onChange={(e) => dispatch({ type: "contact", field: "contactName", value: e.target.value })}
            className={inputCls}
          />
        </label>
        <label className="block">
          <Label>携帯</Label>
          <input
            value={s.contactMobile}
            inputMode="tel"
            onChange={(e) => dispatch({ type: "contact", field: "contactMobile", value: e.target.value })}
            onBlur={() =>
              dispatch({ type: "contact", field: "contactMobile", value: formatPhoneJp(s.contactMobile).value })
            }
            className={inputCls}
          />
          {s.contactMobile.trim() !== "" && !isValidPhoneJp(s.contactMobile) && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              電話番号の桁をご確認ください(このままでも保存できます)
            </span>
          )}
        </label>
        <label className="block">
          <Label>メール(資料の送り先)</Label>
          <input
            type="email"
            value={s.contactEmail}
            onChange={(e) => dispatch({ type: "contact", field: "contactEmail", value: e.target.value })}
            className={inputCls}
          />
        </label>
      </section>

      <section className="space-y-1">
        <Label>物件(物件名・部屋・所在地)</Label>
        <PropertyPicker
          query={s.propertyQuery}
          selected={s.property}
          onQuery={(v) => dispatch({ type: "propertyQuery", value: v })}
          onPick={(p) => dispatch({ type: "propertySelected", property: p })}
        />
        {s.property && (
          <div className="space-y-1 rounded-md bg-teal-50 p-2 dark:bg-gray-800">
            <p className="text-sm font-medium">
              {s.property.roomNo ? `${s.property.name} ${s.property.roomNo}` : s.property.name}
            </p>
            <p className="text-xs text-gray-500">{s.property.town}</p>
            <AdPermissionChips value={s.property.adPermissions} />
          </div>
        )}
        <Err text={errors.property} />
      </section>

      <section className="space-y-1">
        <Label>用件</Label>
        <div className="grid grid-cols-3 gap-1" data-guide="kind">
          {(["viewing", "ad_permission", "material_request"] as const).map((k) => (
            <button key={k} type="button" className={segCls(s.kind === k)} onClick={() => dispatch({ type: "kind", value: k })}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Err text={errors.kind} />
      </section>

      {s.kind === "viewing" && (
        <section className="space-y-2">
          <Label>内見の予定</Label>
          <div className="grid grid-cols-2 gap-1" data-guide="viewingType">
            <button
              type="button"
              className={segCls(s.viewingType === "guided")}
              onClick={() => dispatch({ type: "viewing", field: "viewingType", value: "guided" })}
            >
              案内(お客様連れ)
            </button>
            <button
              type="button"
              className={segCls(s.viewingType === "preview")}
              onClick={() => dispatch({ type: "viewing", field: "viewingType", value: "preview" })}
            >
              下見(業者のみ)
            </button>
          </div>
          <Err text={errors.viewingType} />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={s.viewingDate}
              aria-label="内見の日付"
              onChange={(e) => dispatch({ type: "viewing", field: "date", value: e.target.value })}
              className={inputCls}
            />
            <input
              type="time"
              value={s.viewingTime}
              aria-label="内見の時刻"
              onChange={(e) => dispatch({ type: "viewing", field: "time", value: e.target.value })}
              className={inputCls}
            />
          </div>
          <p className="text-[11px] text-gray-500">日付と時刻の両方を入れると予定になります(空のままなら日程調整中)</p>
          <label className="block">
            <Label>立ち会い(こちら)</Label>
            <select
              value={s.attendantId}
              onChange={(e) => dispatch({ type: "viewing", field: "attendantId", value: e.target.value })}
              className={inputCls}
            >
              <option value="">なし・未定</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      <section className="space-y-1">
        <Label>入口</Label>
        <div className="grid grid-cols-3 gap-1">
          {(["phone", "email", "fax"] as const).map((c) => (
            <button key={c} type="button" className={segCls(s.channel === c)} onClick={() => dispatch({ type: "channel", value: c })}>
              {CHANNEL_LABEL[c]}
            </button>
          ))}
        </div>
        <textarea
          value={s.note}
          onChange={(e) => dispatch({ type: "note", value: e.target.value })}
          rows={2}
          placeholder="メモ(メールの本文を貼ってもよい)"
          className={inputCls}
        />
      </section>

      {warning && (
        <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">{warning}</p>
      )}
      {message && <p className="text-sm text-teal-700 dark:text-teal-300">{message}</p>}
      {saveError && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-sm font-medium text-rose-700 dark:bg-rose-950 dark:text-rose-200">
          保存できませんでした:{saveError}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        data-guide="save"
        className="w-full rounded-lg bg-teal-700 py-3 text-base font-bold text-white disabled:opacity-60"
      >
        {submitting ? "保存中…" : "保存する"}
      </button>
      </fieldset>
    </form>
  );
}

/** 状態と保存を持つ親。保存できたら空に戻し、onSaved で一覧などを読み直させる。 */
export default function InquiryForm({
  users,
  onSaved,
  onStateChange,
}: {
  users: { id: string; name: string }[];
  onSaved: () => void;
  /** 光る案内が次の手順を読むために、今の状態を親へ渡す。 */
  onStateChange?: (s: DeskFormState) => void;
}) {
  const [state, dispatch] = useReducer(deskFormReducer, EMPTY_DESK_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 次の入力を始めたら「登録しました」「保存できませんでした」を消す(前の結果と取り違えない)。
  const act: typeof dispatch = (a) => {
    setMessage(null);
    setSaveError(null);
    dispatch(a);
  };
  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);
  const submit = async () => {
    // 保存中の再押下は無視(二重登録を防ぐ)。
    if (submitting) return;
    const e = validateDeskForm(state);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSubmitting(true);
    setMessage(null);
    setSaveError(null);
    try {
      await createAgentInquiry(buildCreateBody(state));
      dispatch({ type: "reset" });
      setMessage("登録しました");
      onSaved();
    } catch (err) {
      if (isAmbiguousSaveError(err)) {
        // 保存が済んでいることがある=そのまま押し直すと二重登録。一覧を読み直して確かめてもらう。
        setSaveError("保存できたか分かりません(通信が切れました)。右の一覧に出ていないか確かめてから、無ければもう一度保存してください。");
        onSaved();
      } else {
        setSaveError(err instanceof Error ? err.message : "保存できませんでした");
      }
    } finally {
      setSubmitting(false);
    }
  };
  const newAgentPhone = splitNewAgentPhone(state.agentQuery);
  return (
    <>
      <InquiryFormView
        state={state}
        dispatch={act}
        users={users}
        errors={errors}
        warning={materialEmailWarning(state)}
        submitting={submitting}
        message={message}
        saveError={saveError}
        onSubmit={submit}
        onCreateAgent={() => setCreating(true)}
      />
      {creating && (
        <AgentCreateModal
          initialPhone={newAgentPhone.agentPhone}
          onClose={() => setCreating(false)}
          onCreated={(hit: AgentHit) => {
            act({ type: "agentSelected", agent: hit });
            // 携帯で探していたときは、その携帯を問い合わせ者の欄へ(会社の代表電話にはしない・@codex #459 R19)。
            // 自分で打った携帯は上書きしない(前の業者から自動で入れた値・空なら入れる)。
            const typed = state.contactMobile.trim() !== "" && state.contactAutofill?.contactMobile !== state.contactMobile;
            if (newAgentPhone.callerMobile && !typed) {
              act({ type: "contact", field: "contactMobile", value: formatPhoneJp(newAgentPhone.callerMobile).value });
            }
            setCreating(false);
          }}
        />
      )}
    </>
  );
}
