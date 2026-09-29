"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import WatermarkOverlay from "@/components/screen-protection/watermark-overlay";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { useDeskAccess } from "./desk-access";
import {
  addAgentViewing,
  apiErrorCode,
  fetchAgentInquiry,
  updateAgentInquiry,
  updateAgentViewing,
  type InquiryStatusKey,
  type InquiryView,
  type ViewingTypeKey,
  type ViewingView,
} from "@/lib/api-client";
import {
  CONFLICT_MESSAGE,
  KIND_LABEL,
  STATUS_LABEL,
  VIEWING_TYPE_LABEL,
  formatJst,
  isoToJstInputs,
  jstInputsToIso,
  draftOf,
  draftStale,
  editDraft,
  isAmbiguousSaveError,
  type Draft,
} from "@/lib/agent-inquiry/desk-form";

export const mainWindowPropertyHref = (id: string) => `/properties/${id}`;
const inputCls = "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900";

/**
 * 書けないときの文字(メモ・結果)。画面保護はテキスト欄の中を見ないので、欄ではなく保護の印付きの
 * 文章で出す=コピーの抑止と記録が効く(@codex #459 R17)。
 */
function ProtectedText({ text }: { text: string }) {
  return (
    <p data-pii-protected="true" data-pii-surface="dashboard" className="min-h-[2rem] whitespace-pre-wrap rounded-md border border-gray-200 px-2 py-1.5 text-sm dark:border-gray-700">{text}</p>
  );
}

export type ViewingPatch = {
  scheduledAt?: string | null;
  viewingType?: ViewingTypeKey;
  attendantId?: string | null;
  resultNote?: string | null;
  canceled?: boolean;
};

function ViewingRow({
  v,
  users,
  busy,
  readOnlyText,
  onSave,
}: {
  v: ViewingView;
  users: { id: string; name: string }[];
  busy: boolean;
  readOnlyText: boolean;
  onSave: (patch: ViewingPatch) => void;
}) {
  // 下書き(書き始めたときの最新の値も覚える)。行は内見の id だけで作り直すので、保存で版が進んでも・
  // 読み直しても、打ちかけの入力は消えない(最終レビュー I-1/I-2)。ただし書き始めた後に他の人が同じ欄を
  // 変えていたら、1回目の保存は止めて相手の値を見せる=黙って上書きしない(@codex #459 R6)。
  const server = {
    date: isoToJstInputs(v.scheduledAt).date,
    time: isoToJstInputs(v.scheduledAt).time,
    result: v.resultNote ?? "",
    attendant: v.attendant?.id ?? "",
  };
  type Field = keyof typeof server;
  const [drafts, setDrafts] = useState<Partial<Record<Field, Draft>>>({});
  const [warn, setWarn] = useState<string | null>(null);
  const val = (f: Field) => draftOf(drafts[f] ?? null, server[f]);
  const edit = (f: Field, value: string) => {
    setWarn(null);
    setDrafts((d) => ({ ...d, [f]: editDraft(d[f] ?? null, value, server[f]) }));
  };
  const save = () => {
    const stale = (Object.keys(server) as Field[]).filter((f) => draftStale(drafts[f] ?? null, server[f]));
    if (stale.length > 0) {
      // 相手の変更を見せ、今の値を基準にし直す(もう一度押せば自分の内容で保存)。
      setWarn("他の人が先に変えています(上の表示が今の内容です)。自分の内容で上書きするなら、もう一度保存を押してください。");
      setDrafts((d) => {
        const next = { ...d };
        for (const f of stale) next[f] = { value: d[f]!.value, base: server[f] };
        return next;
      });
      return;
    }
    setWarn(null);
    onSave({
      scheduledAt: jstInputsToIso(val("date"), val("time")),
      resultNote: val("result"),
      attendantId: val("attendant") || null,
    });
  };
  const canceled = v.canceledAt != null;
  return (
    <li className={`space-y-1 rounded-md border border-gray-200 p-2 dark:border-gray-700 ${canceled ? "opacity-60" : ""}`}>
      <p className="text-sm font-medium tabular-nums">
        {formatJst(v.scheduledAt)} {VIEWING_TYPE_LABEL[v.viewingType]}
        {v.attendant ? ` ・ 立会 ${v.attendant.name}` : ""}
        {v.resultNote ? ` ・ 結果「${v.resultNote}」` : ""}
        {canceled ? " ・ 取り消し済み" : ""}
      </p>
      <div className="grid grid-cols-2 gap-1">
        <input type="date" value={val("date")} readOnly={busy} aria-label="内見の日付" onChange={(e) => edit("date", e.target.value)} className={inputCls} />
        <input type="time" value={val("time")} readOnly={busy} aria-label="内見の時刻" onChange={(e) => edit("time", e.target.value)} className={inputCls} />
      </div>
      {/* 立ち会いは選んだだけでは保存しない(保存で行の版が進み、打ちかけの結果が消えるのを防ぐ)。 */}
      <select value={val("attendant")} disabled={busy} aria-label="立ち会い" onChange={(e) => edit("attendant", e.target.value)} className={inputCls}>
        <option value="">立ち会い なし・未定</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {readOnlyText ? (
        <ProtectedText text={val("result")} />
      ) : (
        <textarea
          value={val("result")}
          readOnly={busy}
          onChange={(e) => edit("result", e.target.value)}
          rows={2}
          placeholder="内見後の結果"
          className={inputCls}
        />
      )}
      {warn && <p className="text-xs text-amber-700 dark:text-amber-300">{warn}</p>}
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={busy} onClick={save} className="rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60">
          日時・立ち会い・結果を保存
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave({ canceled: !canceled })}
          className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
        >
          {canceled ? "取り消しを戻す" : "この内見を取り消す"}
        </button>
      </div>
    </li>
  );
}

/** 見た目(SSR テスト用)。 */
export function InquiryDetailView({
  inquiry: q,
  canOpenProperty,
  users,
  busy,
  error,
  onStatus,
  onAssignee,
  onSaveNote,
  onAddViewing,
  onSaveViewing,
  onClose,
  onReload,
  closeLocked = false,
  readOnlyText = false,
  addLocked = false,
  onConfirmAdd,
}: {
  inquiry: InquiryView;
  canOpenProperty: boolean;
  users: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  onStatus: (s: InquiryStatusKey) => void;
  onAssignee: (id: string | null) => void;
  onSaveNote: (note: string) => void;
  onAddViewing: (t: ViewingTypeKey) => void;
  onSaveViewing: (v: ViewingView, patch: ViewingPatch) => void;
  onClose: () => void;
  /** 他の人が先に更新したとき、入力を残したまま最新を読み直す。 */
  onReload?: () => void;
  /** 閉じられない(書き込み中だけ)。読み直しに失敗しているだけなら閉じられる=閉じ込めない(@codex #459 R9)。 */
  closeLocked?: boolean;
  /** 書けない(書く権限なし・読み直し失敗)ときは、メモと結果を保護付きの文章で出す(@codex #459 R17)。 */
  readOnlyText?: boolean;
  /** 内見を足せたか分からない(通信が切れた等)。確かめるまで足すボタンを止める(@codex #459 R19)。 */
  addLocked?: boolean;
  onConfirmAdd?: () => void;
}) {
  // メモの下書き(null=まだ触っていない)。詳細は反響の id だけで作り直すので、状態や担当を変えて版が
  // 進んでも・読み直しても、打ちかけのメモは消えない(最終レビュー I-1/I-2)。
  const { bypass, watermarkText } = useScreenProtection();
  const [noteDraft, setNoteDraft] = useState<Draft | null>(null);
  const [noteWarn, setNoteWarn] = useState<string | null>(null);
  const serverNote = q.note ?? "";
  const note = draftOf(noteDraft, serverNote);
  const setNote = (value: string) => {
    setNoteWarn(null);
    setNoteDraft((d) => editDraft(d, value, serverNote));
  };
  const saveNote = () => {
    // 書き始めた後に他の人がメモを変えていたら、1回目は止めて相手のメモを見せる(@codex #459 R6)。
    if (noteDraft && draftStale(noteDraft, serverNote)) {
      setNoteWarn(`他の人が先に変えています。今のメモ:「${serverNote || "(空)"}」。自分のメモで上書きするなら、もう一度「メモを保存」を押してください。`);
      setNoteDraft({ value: noteDraft.value, base: serverNote });
      return;
    }
    setNoteWarn(null);
    onSaveNote(note);
  };
  return (
    <ModalShell
      size="lg"
      title={`${KIND_LABEL[q.kind]} ― ${q.agent.companyName}`}
      // 保存中は閉じない(閉じて開き直すと古い内容のまま「内見を足す」を押せて二重登録になる・@codex #459 R8)。
      onClose={closeLocked ? undefined : onClose}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={closeLocked}>
          閉じる
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        {/* 小窓はブラウザの最前面に出るので、外の透かしは隠れる。小窓の中にも透かしを描く(@codex #459 R8)。 */}
        {!bypass && watermarkText && <WatermarkOverlay text={watermarkText} />}
        <p className="font-medium">
          {q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name}
          <span className="ml-2 text-xs text-gray-500">{q.property.town}</span>
        </p>
        {canOpenProperty && (
          // 素の <a target> で名前付きの窓に開く(window.open はブロックされる環境がある)。
          <a href={mainWindowPropertyHref(q.property.id)} target="pm-main" className="text-teal-700 underline dark:text-teal-300">
            メイン画面で物件を開く ↗
          </a>
        )}
        <p>
          問い合わせ者:{q.contactName ?? "—"} ・ 携帯 {q.contactMobile ?? "—"} ・ メール {q.contactEmail ?? "—"}
        </p>
        <p className="text-xs text-gray-500">
          受けた日時 {formatJst(q.receivedAt)} ・ 代表 {q.agent.phone}
        </p>
        <div className="grid grid-cols-3 gap-1">
          {(["open", "in_progress", "done"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => onStatus(s)}
              className={`rounded-md border px-2 py-2 ${
                q.status === s ? "border-teal-700 bg-teal-700 font-bold text-white" : "border-gray-300 dark:border-gray-700"
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs text-gray-500">担当</span>
          <select
            value={q.assignee?.id ?? ""}
            disabled={busy}
            onChange={(e) => onAssignee(e.target.value || null)}
            className={inputCls}
          >
            <option value="">未定</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">メモ</span>
          {/* 書けない間(保存中・書く権限なし・読み直し失敗)は打てない=保存できない入力を受け付けない(@codex #459 R13)。 */}
          {readOnlyText ? (
            <ProtectedText text={note} />
          ) : (
            <textarea value={note} readOnly={busy} onChange={(e) => setNote(e.target.value)} rows={3} className={inputCls} />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={saveNote}
            className="mt-1 rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60"
          >
            メモを保存
          </button>
          {noteWarn && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{noteWarn}</p>}
        </label>
        {q.kind === "viewing" && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500">内見の予定</p>
            <ul className="space-y-1">
              {q.viewings.map((v) => (
                <ViewingRow key={v.id} v={v} users={users} busy={busy} readOnlyText={readOnlyText} onSave={(p) => onSaveViewing(v, p)} />
              ))}
            </ul>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy || addLocked}
                onClick={() => onAddViewing("guided")}
                className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
              >
                内見を足す(案内)
              </button>
              <button
                type="button"
                disabled={busy || addLocked}
                onClick={() => onAddViewing("preview")}
                className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
              >
                内見を足す(下見)
              </button>
            </div>
            {addLocked && (
              <div className="flex items-center gap-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <p>上の一覧で内見が増えていないか確かめてから押してください(増えていれば足し直さない)。</p>
                <button type="button" disabled={busy} onClick={onConfirmAdd} className="shrink-0 rounded border border-amber-300 px-2 py-0.5">
                  確かめた
                </button>
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="flex items-center justify-between gap-2 rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950 dark:text-rose-200">
            <p>{error}</p>
            {onReload && (
              <button type="button" onClick={onReload} className="shrink-0 rounded border border-rose-300 px-2 py-0.5 text-xs">
                読み直す
              </button>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/** 取得・保存を持つ親。保存のたびに読み直し、409 は文言を出してから読み直す(入力中の内容は各欄が持つ)。 */
export default function InquiryDetail({
  inquiryId,
  users,
  onClose,
  onChanged,
  canWrite = true,
  onAccessLost,
}: {
  inquiryId: string;
  users: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
  /** 書く権限。無ければ変更のボタンを押せない(押してから 403 にしない・@codex #459 R12)。 */
  canWrite?: boolean;
  /** 読む権限が外れていた(403)・ログインが切れた(401)。画面ごと隠せるよう親へ渡す(@codex #459 R18/R19)。 */
  onAccessLost?: (e: unknown) => void;
}) {
  const [data, setData] = useState<{ inquiry: InquiryView; canOpenProperty: boolean } | null>(null);
  const { writeDenied } = useDeskAccess();
  const [busy, setBusy] = useState(false);
  // 保存はできたが最新を読み直せなかった。古い内容のまま押すと内見の二重登録や版の食い違いになるので、
  // 読み直すまで操作を止める(@codex #459 R5)。
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 内見を足せたか分からない=足し直すと二重になりうる。確かめたと押すまで足すボタンを止める(@codex #459 R19)。
  const [addLocked, setAddLocked] = useState(false);
  // 読み込みの番号。後から始めた読み込みがあれば、先の応答は捨てる=古い内容で新しい内容を上書きしない(@codex #459 R17)。
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const next = await fetchAgentInquiry(inquiryId);
      if (loadSeqRef.current !== seq) return;
      setData(next);
    } catch (e) {
      if (loadSeqRef.current !== seq) return;
      throw e;
    }
  }, [inquiryId]);
  // 読み込みが権限なし・ログイン切れで断られたら、小窓の中で知らせるだけにせず親に渡す=一覧ごと隠す
  // (@codex #459 R18/R19)。
  const lostAccess = useCallback(
    (e: unknown) => {
      const code = apiErrorCode(e);
      if ((code === "FORBIDDEN" || code === "UNAUTHORIZED") && onAccessLost) {
        onAccessLost(e);
        return true;
      }
      return false;
    },
    [onAccessLost],
  );
  useEffect(() => {
    load().catch((e) => {
      if (lostAccess(e)) return;
      setError(e instanceof Error ? e.message : "読み込めませんでした");
    });
  }, [load, lostAccess]);
  const run = async (fn: () => Promise<unknown>, opts?: { addsViewing?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let conflict = false;
    let wrote = false;
    let gone = false;
    try {
      await fn();
      wrote = true;
      onChanged();
    } catch (e) {
      // 保存の途中でログインが切れたら、画面ごと隠す(@codex #459 R19)。
      if (apiErrorCode(e) === "UNAUTHORIZED" && lostAccess(e)) {
        gone = true;
        return;
      }
      // 書く権限だけ外された=権限を読み直して、書けない表示へ切り替える(@codex #459 R20)。
      if (apiErrorCode(e) === "FORBIDDEN") writeDenied(e);
      conflict = apiErrorCode(e) === "VERSION_CONFLICT";
      if (opts?.addsViewing && isAmbiguousSaveError(e)) {
        setAddLocked(true);
        setError("内見を足せたか分かりません(通信が切れました)。内見の予定の欄の案内に沿って確かめてください。");
      } else {
        setError(conflict ? CONFLICT_MESSAGE : e instanceof Error ? e.message : "保存できませんでした");
      }
    } finally {
      // 他の人が先に更新したときは自動で読み直さない=打ちかけの入力を消さない。「読み直す」で最新へ。
      if (!conflict && !gone) {
        await load().catch((e) => {
          if (lostAccess(e)) return;
          setRefreshFailed(true);
          // 「保存しましたが…」は書き込みが通ったときだけ。書き込みも失敗していたら、その失敗を残す。
          if (wrote) setError("保存しましたが、最新の内容を読み込めませんでした。「読み直す」を押してください。");
          else setError((prev) => `${prev ?? "保存できませんでした"}(最新の内容も読み込めませんでした。「読み直す」を押してください)`);
        });
      }
      setBusy(false);
    }
  };
  const reload = () => {
    // 読み直し中は書き込みを止める(古い版のまま押せる・保存後の読み込みと食い違うのを防ぐ・@codex #459 R17)。
    if (busy) return;
    setBusy(true);
    setError(null);
    load()
      .then(() => setRefreshFailed(false))
      .catch((e) => {
        if (lostAccess(e)) return;
        // 読み直しにも失敗したら、古い内容のまま押せる状態には戻さない。
        setRefreshFailed(true);
        setError(e instanceof Error ? e.message : "読み込めませんでした");
      })
      .finally(() => setBusy(false));
  };
  if (!data) {
    return error ? (
      <ModalShell size="sm" title="反響" onClose={onClose} footer={<Button onClick={onClose}>閉じる</Button>}>
        <p className="text-sm text-rose-600">{error}</p>
      </ModalShell>
    ) : null;
  }
  const q = data.inquiry;
  return (
    <InquiryDetailView
      key={q.id}
      inquiry={q}
      canOpenProperty={data.canOpenProperty}
      users={users}
      busy={busy || refreshFailed || !canWrite}
      closeLocked={busy}
      readOnlyText={refreshFailed || !canWrite}
      error={error}
      onStatus={(status) => run(() => updateAgentInquiry(q.id, { version: q.version, status }))}
      onAssignee={(assigneeId) => run(() => updateAgentInquiry(q.id, { version: q.version, assigneeId }))}
      onSaveNote={(note) => run(() => updateAgentInquiry(q.id, { version: q.version, note }))}
      onAddViewing={(viewingType) => run(() => addAgentViewing(q.id, { viewingType }), { addsViewing: true })}
      onSaveViewing={(v, patch) => run(() => updateAgentViewing(q.id, v.id, { version: v.version, ...patch }))}
      onClose={onClose}
      onReload={reload}
      addLocked={addLocked}
      onConfirmAdd={() => setAddLocked(false)}
    />
  );
}
