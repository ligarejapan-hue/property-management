"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { SelectBox, inputCls } from "@/components/deals/form-parts";
import { dealsApi, errorText } from "@/lib/deals/client";
import { REQUEST_BLANK_LABELS, type RequestBlank } from "@/lib/deals/request-drafts/templates";
import type { RequestDraftResponse } from "@/lib/deals/request-drafts/store";

/** 「空の欄:決済場所(未入力)、売主住所(権限なし)」。空のまま送らないように文面の上に出す。 */
export function RequestDraftBlanks({ blanks }: { blanks: RequestBlank[] }) {
  if (!blanks.length) return null;
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      空の欄:{blanks.map((b) => `${b.field}(${REQUEST_BLANK_LABELS[b.reason]})`).join("、")}。必要なら文面に書き足してください。
    </p>
  );
}

/**
 * 依頼文を作る小窓。文面はこの画面の中だけで直す(サーバーへ送らない・残さない)。
 * コピーのボタンでも、文面を選んで手でコピーしても履歴に残す(HTTP の入口ではボタンのコピーが使えない)。
 */
export function RequestDraftDialog({ dealId, itemId, itemLabel, onClose, onCopied }: {
  dealId: string; itemId: string; itemLabel: string; onClose: () => void; onCopied: () => void;
}) {
  const [draft, setDraft] = useState<RequestDraftResponse | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState<{ templateId?: string; recipientId?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    dealsApi.requestDraft(dealId, itemId, query)
      .then((d) => { if (alive) { setDraft(d); setText(d.text); setError(null); } })
      .catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [dealId, itemId, query]);

  const logCopy = () => {
    if (!draft) return;
    dealsApi.logRequestDraftCopy(dealId, itemId, draft.templateId).then(
      () => { setNotice("コピーしました。ご自分の LINE やメールで送ってください。"); onCopied(); },
      () => setNotice("コピーしましたが、履歴に残せませんでした。"),
    );
  };
  const copy = () => {
    setError(null);
    const done = navigator.clipboard?.writeText(text);
    if (!done) {
      setError("この画面ではボタンでコピーできません。文面を選んで手でコピーしてください。");
      area.current?.select();
      return;
    }
    done.then(logCopy, () => {
      setError("コピーできませんでした。文面を選んで手でコピーしてください。");
      area.current?.select();
    });
  };

  return (
    <ModalShell
      title={`依頼文を作る:${itemLabel}`} size="lg" onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>閉じる</Button>
          <Button disabled={!draft || !text.trim()} onClick={copy}>
            <Copy className="h-4 w-4" />
            コピー
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        {error && <p className="text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {notice && <p className="text-emerald-600 dark:text-emerald-400" role="status">{notice}</p>}
        {!draft ? (
          !error && <div className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
        ) : (
          <>
            {draft.templates.length > 1 && (
              <SelectBox
                label="ひな形" value={draft.templateId} options={draft.templates.map((t) => ({ value: t.id, label: t.label }))}
                onChange={(v) => { setNotice(null); setQuery({ templateId: v }); }}
              />
            )}
            {draft.recipients.length > 1 && (
              <SelectBox
                label={`宛先(${draft.recipientLabel})`} value={draft.recipientId ?? ""} options={draft.recipients.map((r) => ({ value: r.id, label: r.label }))}
                onChange={(v) => { setNotice(null); setQuery({ templateId: draft.templateId, recipientId: v }); }}
              />
            )}
            <RequestDraftBlanks blanks={draft.blanks} />
            <textarea
              ref={area} value={text} rows={16} aria-label="依頼文" className={inputCls}
              onChange={(e) => setText(e.target.value)} onCopy={logCopy}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">システムからは送りません。コピーしたことは履歴に残りますが、文面は残りません。</p>
          </>
        )}
      </div>
    </ModalShell>
  );
}
