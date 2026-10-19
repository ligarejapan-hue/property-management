"use client";

import { useEffect, useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import {
  apiErrorCode,
  applyMaterialSends,
  fetchMaterialCandidates,
  fetchMaterialSends,
  sendMaterial,
  type MaterialCandidates,
  type MaterialSendView,
} from "@/lib/api-client";
import { afterSendError, afterSendResponse, materialFormState } from "@/lib/agent-inquiry/material-send-form";
import { MATERIAL_SEND_LIMITS } from "@/lib/agent-inquiry/material-send";
import { safeUuidV4 } from "@/lib/random-id";

const inputCls = "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900";
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
/** 上限の表示(サーバーが返す上限から作る=数字を画面に書かない)。 */
const limitLabel = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10}MB`;
const jst = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

/** 資料を送る小窓の見た目(spec §2.2)。状態は持たない=親(MaterialSendDialog)が持つ。 */
export function MaterialSendDialogView({
  c,
  loadError,
  to,
  subject,
  body,
  picked,
  busy,
  error,
  hidden,
  onTo,
  onSubject,
  onBody,
  onToggle,
  onSend,
  onHide,
  onCancel,
}: {
  c: MaterialCandidates | null;
  loadError: string | null;
  to: string;
  subject: string;
  body: string;
  picked: string[];
  busy: boolean;
  error: string | null;
  hidden: boolean;
  onTo: (v: string) => void;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  onToggle: (id: string) => void;
  onSend: () => void;
  onHide: () => void;
  onCancel: () => void;
}) {
  // 隠しているあいだは描かない(×で閉じた=入力は親の状態に残す・既存の決まり)。
  if (hidden) return null;
  const st = c
    ? materialFormState({
        files: c.files,
        picked,
        to,
        subject,
        body,
        mailConfigured: c.mailConfigured,
        maxTotalBytes: c.maxTotalBytes,
        maxFiles: c.maxFiles,
        busy,
      })
    : null;
  return (
    <ModalShell
      size="lg"
      title="資料を送る"
      onClose={busy ? undefined : onHide}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </Button>
          <Button onClick={onSend} disabled={!st?.canSend}>
            {busy ? "送信中…" : "送信"}
          </Button>
        </div>
      }
    >
      {loadError ? (
        <p role="alert" className="text-sm text-rose-600">{loadError}</p>
      ) : !c || !st ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {!c.mailConfigured && (
            <p className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              管理画面のメール設定が必要です。
              <a href="/admin/mail-settings" className="underline">メール設定を開く</a>
            </p>
          )}
          <label className="block">
            <span className="text-xs text-gray-500">宛先</span>
            <input aria-label="宛先" type="email" value={to} readOnly={busy} onChange={(e) => onTo(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">件名</span>
            <input aria-label="件名" value={subject} readOnly={busy} onChange={(e) => onSubject(e.target.value)} maxLength={MATERIAL_SEND_LIMITS.subject} className={inputCls} />
            {st.subjectTooLong && (
              <span className="text-xs font-bold text-rose-600">{`件名は ${MATERIAL_SEND_LIMITS.subject} 文字までです。短くしてください`}</span>
            )}
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">本文</span>
            <textarea aria-label="本文" value={body} readOnly={busy} onChange={(e) => onBody(e.target.value)} rows={8} maxLength={MATERIAL_SEND_LIMITS.body} className={inputCls} />
            {st.bodyTooLong && (
              <span className="text-xs font-bold text-rose-600">{`本文は ${MATERIAL_SEND_LIMITS.body} 文字までです。短くしてください`}</span>
            )}
          </label>
          <fieldset>
            <legend className="text-xs text-gray-500">付けるファイル(資料一覧から)</legend>
            {c.files.length === 0 ? (
              <p>資料一覧にファイルがありません。物件画面の「添付」タブでアップロードしてから送ってください。</p>
            ) : (
              <ul className="space-y-1">
                {c.files.map((f) => (
                  <li key={f.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={picked.includes(f.id)} disabled={busy} onChange={() => onToggle(f.id)} />
                      <span>{f.fileName}</span>
                      <span className="text-xs text-gray-500">{mb(f.fileSize)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className={`mt-1 text-xs ${st.tooLarge ? "font-bold text-rose-600" : "text-gray-500"}`}>
              合計 {mb(st.total)} / {limitLabel(c.maxTotalBytes)}
              {st.tooLarge && `(${limitLabel(c.maxTotalBytes)} を超えています。ファイルを減らしてください)`}
            </p>
            {st.tooMany && <p className="text-xs font-bold text-rose-600">{`一度に送れるのは ${c.maxFiles} ファイルまでです`}</p>}
          </fieldset>
          {st.warnings.map((w) => (
            <p key={w} className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200">{w}</p>
          ))}
          {error && (
            <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>
          )}
        </div>
      )}
    </ModalShell>
  );
}

/**
 * 資料を送る小窓(状態つき)。×=onHide(親は hidden にするだけ=入力が残る)・キャンセル=onClose(親が外す=消える)。
 */
export function MaterialSendDialog({
  inquiryId,
  hidden = false,
  onHide,
  onClose,
  onSent,
}: {
  inquiryId: string;
  hidden?: boolean;
  onHide: () => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [c, setC] = useState<MaterialCandidates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(() => safeUuidV4());

  useEffect(() => {
    let alive = true;
    fetchMaterialCandidates(inquiryId)
      .then((d) => {
        if (!alive) return;
        setC(d);
        setTo(d.to);
        setSubject(d.subject);
        setBody(d.body);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : "読み込めませんでした");
      });
    return () => {
      alive = false;
    };
  }, [inquiryId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendMaterial(inquiryId, { to: to.trim(), subject, body, attachmentIds: picked, clientToken: token });
      // 押し直しで前の結果が返った(同じ鍵)ときも含めて、送れたときだけ閉じる。
      const d = afterSendResponse(r);
      if (d.renewToken) setToken(safeUuidV4());
      if (d.kind === "sent") {
        onSent();
        return;
      }
      setError(
        d.kind === "failed"
          ? "前回の送信は送れませんでした。もう一度「送信」を押してください"
          : d.kind === "unknown"
            ? "前回の送信は途中で止まり、届いたか分かりません。送った記録や相手に確かめてから、必要ならもう一度「送信」を押してください"
            : "送信中です。少し待ってから、もう一度「送信」を押して結果を確かめてください",
      );
    } catch (e) {
      // はっきり送れなかったときだけ鍵を替える。通信切れなどは送れていることがある=同じ鍵で押し直すと
      // サーバーが前の結果を返す(2通目は出ない・最終レビュー I1)。
      const d = afterSendError(apiErrorCode(e));
      if (d.renewToken) setToken(safeUuidV4());
      setError(
        d.unknown
          ? "送れたか分かりません(通信が切れました)。もう一度「送信」を押すと、送れていたかを確かめます(2通目は出ません)"
          : e instanceof Error
            ? e.message
            : "送れませんでした",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <MaterialSendDialogView
      c={c}
      loadError={loadError}
      to={to}
      subject={subject}
      body={body}
      picked={picked}
      busy={busy}
      error={error}
      hidden={hidden}
      onTo={setTo}
      onSubject={setSubject}
      onBody={setBody}
      onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
      onSend={() => void submit()}
      onHide={onHide}
      onCancel={onClose}
    />
  );
}

/** 送った記録の見た目(spec §2.3)。行を押すと件名・本文・ファイル名を開く。 */
export function MaterialSendHistoryView({
  items,
  openId,
  onToggle,
}: {
  items: MaterialSendView[];
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500">資料送付の記録</p>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.id} className="rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
            <button type="button" className="w-full text-left text-xs" onClick={() => onToggle(s.id)}>
              {`${jst(s.createdAt)} ・ ${s.sentBy.name} ・ ${s.toAddress} ・ ${s.attachments.length}ファイル ・ `}
              <span className={s.state === "送信済み" ? "text-teal-700 dark:text-teal-300" : "text-rose-600"}>{s.state}</span>
            </button>
            {openId === s.id && (
              <div className="mt-1 space-y-1 text-xs">
                <p className="font-medium">{s.subject}</p>
                <p className="whitespace-pre-wrap">{s.body}</p>
                <ul>
                  {s.attachments.map((a) => (
                    <li key={a.attachmentId}>{`${a.fileName}(${mb(a.fileSize)})`}</li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 送った記録(状態つき)。reloadKey が変わると読み直す。
 * 送れたのに反響へ反映できていない記録があれば(needsApply)、反映し直しの口を1回呼び、反映できたら親に知らせる
 * (親は反響を読み直す)。書けない人は口が断る=何もしない(@codex 2巡目 P2)。
 */
export function MaterialSendHistory({
  inquiryId,
  reloadKey,
  onApplied,
}: {
  inquiryId: string;
  reloadKey: number;
  onApplied?: () => void;
}) {
  const [items, setItems] = useState<MaterialSendView[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchMaterialSends(inquiryId)
      .then((d) => {
        if (!alive) return;
        setItems(d.items);
        if (d.needsApply) {
          applyMaterialSends(inquiryId)
            .then((r) => {
              if (alive && r.applied) onApplied?.();
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
    // onApplied は親が毎回作り直す=依存に入れると読み直しが続く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inquiryId, reloadKey]);
  return <MaterialSendHistoryView items={items} openId={openId} onToggle={(id) => setOpenId((o) => (o === id ? null : id))} />;
}
