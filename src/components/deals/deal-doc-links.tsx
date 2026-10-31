"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Download, FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls } from "./form-parts";
import { dealsApi, errorText } from "@/lib/deals/client";
import {
  DOC_LINK_DEFAULT_DAYS, DOC_LINK_MAX_DAYS, DOC_LINK_REJECT_REASON_MAX, DOC_LINK_ROLE_LABELS, DOC_LINK_STATE_LABELS, DOC_REQUEST_STATUS_LABELS,
} from "@/lib/deals/doc-links/constants";
import type { DocLinkRequestView, DocLinksResponse, DocLinkView } from "@/lib/deals/doc-links/staff-store";

const STATUS_CLS: Record<DocLinkRequestView["status"], string> = {
  pending: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  submitted: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  received: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export interface DocLinkActions {
  busy: boolean;
  onIssue: (body: { partyId: string; itemIds: string[]; days: number; rotate: boolean }) => Promise<boolean>;
  onRevoke: (linkId: string) => void;
  onReview: (requestId: string, body: { action: "receive" } | { action: "reject"; reason: string }) => void;
  onCopy: (text: string, what: string) => void;
}

function RequestRow({ dealId, r, canReview, actions }: { dealId: string; r: DocLinkRequestView; canReview: boolean; actions: DocLinkActions }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const current = r.files.filter((f) => f.reviewState !== "rejected");
  return (
    <li className="space-y-1 py-2" data-doc-request={r.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLS[r.status]}`}>{DOC_REQUEST_STATUS_LABELS[r.status]}</span>
        <span className="text-gray-900 dark:text-gray-100">{r.label}</span>
        {r.fileCount > 0 && <span className="text-xs text-gray-500 dark:text-gray-400">{r.fileCount}ファイル</span>}
      </div>
      {r.status === "rejected" && r.rejectReason && <p className="text-xs text-red-700 dark:text-red-300">理由:{r.rejectReason}</p>}
      {canReview && current.length > 0 && (
        <p className="flex flex-wrap gap-2 text-xs">
          {current.map((f, i) => (
            <a key={f.id} href={dealsApi.docFileUrl(dealId, f.id)} className="inline-flex items-center gap-1 text-blue-700 underline dark:text-blue-300">
              <Download className="h-3 w-3" aria-hidden="true" />
              ファイル{i + 1}をダウンロード
            </a>
          ))}
        </p>
      )}
      {canReview && r.status === "submitted" && (rejecting ? (
        <div className="flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={DOC_LINK_REJECT_REASON_MAX} aria-label={`${r.label}の差し戻しの理由`} placeholder="差し戻しの理由(例:文字が読めません)" className={`${inputCls} max-w-md`} />
          <Button variant="secondary" size="sm" disabled={actions.busy || !reason.trim()} onClick={() => actions.onReview(r.id, { action: "reject", reason: reason.trim() })}>差し戻す</Button>
          <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => setRejecting(false)}>やめる</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={actions.busy} onClick={() => actions.onReview(r.id, { action: "receive" })}>受領</Button>
          <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => setRejecting(true)}>差し戻し</Button>
        </div>
      ))}
    </li>
  );
}

function LinkCard({ dealId, link, data, actions }: { dealId: string; link: DocLinkView; data: DocLinksResponse; actions: DocLinkActions }) {
  return (
    <section className="mt-3 rounded-md border border-gray-200 p-3 dark:border-gray-800" data-doc-link={link.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-gray-900 dark:text-gray-100">
          {DOC_LINK_ROLE_LABELS[link.partyRole]} {link.partyName ?? ""}
          <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">{DOC_LINK_STATE_LABELS[link.state]}・期限 {link.expiresOn}</span>
        </h3>
        {data.canManage && (
          <div className="flex flex-wrap gap-2">
            {link.guidance && (
              <Button variant="secondary" size="sm" onClick={() => actions.onCopy(link.guidance as string, "案内の文面")}>
                <Copy className="h-3.5 w-3.5" />
                案内の文面をコピー
              </Button>
            )}
            {link.missingText && (
              <Button variant="ghost" size="sm" onClick={() => actions.onCopy(link.missingText as string, "足りない書類の一覧")}>足りない書類をコピー</Button>
            )}
            {link.state === "active" && (
              <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.onRevoke(link.id)}>無効にする</Button>
            )}
          </div>
        )}
      </div>
      <ul className="mt-1 divide-y divide-gray-100 text-sm dark:divide-gray-800">
        {link.requests.map((r) => <RequestRow key={r.id} dealId={dealId} r={r} canReview={data.canReview} actions={actions} />)}
      </ul>
    </section>
  );
}

function IssueForm({ data, actions }: { data: DocLinksResponse; actions: DocLinkActions }) {
  const [partyId, setPartyId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState(DOC_LINK_DEFAULT_DAYS);
  const [rotate, setRotate] = useState(false);
  const existing = data.links.find((l) => l.partyId === partyId);
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  const submit = async () => {
    if (await actions.onIssue({ partyId, itemIds: picked, days, rotate })) {
      setPicked([]);
      setRotate(false);
    }
  };
  if (!data.available) return <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">提出用リンクの設定が済んでいないため、発行できません。管理者に連絡してください。</p>;
  if (!data.dealOpen) return <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">中止・決済済の取引には発行できません。</p>;
  if (data.parties.length === 0) return <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">「当事者」タブに売主か買主を入れると発行できます。</p>;
  return (
    <div className="mt-3 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400">提出用リンクを発行</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="相手">
          <SelectBox label="相手" value={partyId} onChange={setPartyId} options={data.parties.map((p) => ({ value: p.id, label: `${DOC_LINK_ROLE_LABELS[p.role]} ${p.name}` }))} allowEmpty />
        </Field>
        <Field label="有効な日数">
          <input type="number" min={1} max={DOC_LINK_MAX_DAYS} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="有効な日数" className={inputCls} />
        </Field>
      </div>
      <fieldset>
        <legend className="text-xs text-gray-600 dark:text-gray-400">提出してもらう書類(書類確認書の「決済時」から)</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {data.options.map((o) => (
            <label key={o.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={picked.includes(o.id)} onChange={(e) => toggle(o.id, e.target.checked)} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      {existing && (
        <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input type="checkbox" className="mt-0.5" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />
          リンクを作り直す(前に送ったリンクは使えなくなります)
        </label>
      )}
      <Button variant="secondary" size="sm" disabled={actions.busy || !partyId || picked.length === 0 || days < 1 || days > DOC_LINK_MAX_DAYS} onClick={() => void submit()}>
        {existing ? "書類と期限を更新" : "発行"}
      </Button>
    </div>
  );
}

/** 見た目。確認待ちがあれば開いて出す。 */
export function DealDocLinksView({ dealId, data, actions, notice }: { dealId: string; data: DocLinksResponse; actions: DocLinkActions; notice: string | null }) {
  const waiting = data.links.flatMap((l) => l.requests).filter((r) => r.status === "submitted").length;
  return (
    <details open={waiting > 0 || undefined} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-800 dark:bg-gray-900">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-semibold text-gray-800 dark:text-gray-200">
        <FileCheck2 className="h-4 w-4" aria-hidden="true" />
        お客様の書類提出
        {waiting > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">確認待ち {waiting}件</span>}
      </summary>
      {notice && <p className="mt-2 text-xs text-green-700 dark:text-green-300" role="status">{notice}</p>}
      {data.links.map((l) => <LinkCard key={l.id} dealId={dealId} link={l} data={data} actions={actions} />)}
      {data.canManage && <IssueForm data={data} actions={actions} />}
    </details>
  );
}

/** 読んで出す。保存のたびに読み直し、段取りにも知らせる。 */
export function DealDocLinks({ dealId, revision, onChanged }: { dealId: string; revision: string; onChanged: () => void }) {
  const [data, setData] = useState<DocLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await dealsApi.docLinks(dealId));
    setError(null);
  }, [dealId]);

  useEffect(() => {
    let alive = true;
    dealsApi.docLinks(dealId)
      .then((res) => { if (alive) { setData(res); setError(null); } })
      .catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [dealId, revision]);

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p> : null;
  return (
    <div className="space-y-1">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <DealDocLinksView
        dealId={dealId} data={data} notice={notice}
        actions={{
          busy,
          onIssue: (body) => run(() => dealsApi.issueDocLink(dealId, body)),
          onRevoke: (linkId) => void run(() => dealsApi.revokeDocLink(dealId, linkId)),
          onReview: (requestId, body) => void run(() => dealsApi.reviewDocRequest(dealId, requestId, body)),
          onCopy: (text, what) => {
            navigator.clipboard.writeText(text).then(
              () => { setError(null); setNotice(`${what}をコピーしました。ご自分の LINE やメールで送ってください。`); },
              () => setError("コピーできませんでした。もう一度お試しください。"),
            );
          },
        }}
      />
    </div>
  );
}
