"use client";

import { useEffect, useState } from "react";
import { FileOutput, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { Field, inputCls } from "./form-parts";
import { dealsApi, dealDocumentFileUrl, DealApiError, errorText, type AvailableDocument } from "@/lib/deals/client";

const RECEIPTS = new Set(["deposit_receipt", "balance_receipt", "settlement_receipt"]);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * 業務書類(段5)。その取引で出せる書類を並べ、「発行」→ 出す前の確認(空欄の項目・発行のときに選ぶもの)→ 発行。
 * 空欄があっても発行できる(「空欄のまま出す」)。判定はサーバーの一覧表の結果をそのまま出す(設計 §4.3)。
 */
/** refresh = 書類タブの「読み込み直す」の回数(押したら出せる書類と取引の版も読み直す・最終レビュー)。 */
export default function BusinessDocsSection({ dealId, active, refresh, onIssued }: { dealId: string; active: boolean; refresh: number; onIssued: () => void }) {
  const [docs, setDocs] = useState<AvailableDocument[] | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AvailableDocument | null>(null);
  const [done, setDone] = useState<{ id: string; title: string; version: number } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    dealsApi.availableDocuments(dealId)
      .then((r) => { if (alive) { setDocs(r.documents); setVersion(r.version); setError(null); } })
      .catch((e) => { if (alive) setError(`出せる書類を読み込めませんでした: ${errorText(e)}`); });
    return () => { alive = false; };
  }, [dealId, active, tick, refresh]);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">決済の書類</h3>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {docs === null && !error && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>}
      {done && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200" role="status">
          {done.title} 第{done.version}版を発行しました。
          <a href={dealDocumentFileUrl(dealId, done.id, "pdf")} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            <FileText className="h-4 w-4" />
            PDF を開く
          </a>
        </p>
      )}
      {docs && (
        <ul className="flex flex-wrap gap-2">
          {docs.map((d) => (
            <li key={d.docType}>
              <Button variant="secondary" size="sm" onClick={() => { setDone(null); setOpen(d); }}>
                <FileOutput className="h-4 w-4" />
                {d.label}
                {d.missing.length > 0 && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(空欄 {d.missing.length})</span>}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <IssueDialog
          key={open.docType}
          dealId={dealId}
          doc={open}
          version={version}
          onCancel={() => setOpen(null)}
          onDone={(r) => { setOpen(null); setDone(r); setTick((t) => t + 1); onIssued(); }}
        />
      )}
    </section>
  );
}

function IssueDialog({ dealId, doc, version, onCancel, onDone }: {
  dealId: string; doc: AvailableDocument; version: number;
  onCancel: () => void; onDone: (r: { id: string; title: string; version: number }) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(doc.defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));
  const receipt = RECEIPTS.has(doc.docType);
  const issuer = doc.issuers?.find((i) => i.value === values.issuer) ?? null;
  // 個人の発行者は、非課税か課税かを決めるまで発行できない(設計 §4.3)。
  const needsDecision = receipt && issuer?.individual === true && values.exempt == null;

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = receipt
        ? { ...values, exempt: issuer?.individual ? values.exempt ?? null : null, receivedOn: str(values.receivedOn) || null }
        : values;
      const r = await dealsApi.issueDocument(dealId, doc.docType, version, options);
      onDone({ id: r.id, title: r.title, version: r.version });
    } catch (e) {
      setError(e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "取引がほかの人に更新されました。書類タブを開き直してから、もう一度発行してください。"
        : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`${doc.label}を発行`}
      size="lg"
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>入力に戻る</Button>
          <Button onClick={() => void issue()} disabled={busy || needsDecision || doc.blocking.length > 0} loading={busy} loadingLabel="発行中">
            {doc.missing.length ? "空欄のまま出す" : "発行する"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {doc.blocking.length > 0 && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">{doc.blocking.join("・")}が無いと出せません。取引の画面で入れてください。</p>
        )}
        {doc.missing.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" role="alert">
            <p>次の項目が空欄です。取引の画面で入れるか、空欄のまま出してください。</p>
            <ul className="mt-1 list-disc pl-5">{doc.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">必要な項目はそろっています。</p>
        )}
        {receipt && doc.issuers && (
          <>
            <Field label="発行者(受け取る人)">
              <select aria-label="発行者" value={str(values.issuer)} onChange={(e) => set("issuer", e.target.value)} className={inputCls}>
                {doc.issuers.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </Field>
            {issuer?.individual && (
              <fieldset className="space-y-1 text-sm">
                <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">印紙(個人の方が発行するとき・必ず選ぶ)</legend>
                <label className="flex items-center gap-2"><input type="radio" name="exempt" checked={values.exempt === "yes"} onChange={() => set("exempt", "yes")} />非課税(事業用でない物件の売買)</label>
                <label className="flex items-center gap-2"><input type="radio" name="exempt" checked={values.exempt === "no"} onChange={() => set("exempt", "no")} />課税(収入印紙を貼る)</label>
              </fieldset>
            )}
            <Field label="受領日(空なら日付の欄を空けて出す)">
              <input type="date" value={str(values.receivedOn)} onChange={(e) => set("receivedOn", e.target.value)} aria-label="受領日" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">個人の方が発行する領収書には自社の角印を付けず、署名・押印の欄を空けて出します。</p>
          </>
        )}
        {doc.docType === "settlement_guide" && (
          <>
            <Field label="お振込先">
              <textarea value={str(values.payee)} onChange={(e) => set("payee", e.target.value || null)} maxLength={300} rows={2} aria-label="お振込先" className={inputCls} />
            </Field>
            <Field label="お持ちいただくもの(1行に1つ)">
              <textarea value={str(values.belongings)} onChange={(e) => set("belongings", e.target.value || null)} maxLength={500} rows={4} aria-label="お持ちいただくもの" className={inputCls} />
            </Field>
          </>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
}
