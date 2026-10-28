"use client";

import { useEffect, useState } from "react";
import { FileOutput, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { Field, inputCls } from "./form-parts";
import { dealsApi, dealDocumentFileUrl, DealApiError, errorText, type AvailableDocument } from "@/lib/deals/client";

const RECEIPTS = new Set(["deposit_receipt", "balance_receipt", "settlement_receipt"]);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const CHECKLISTS = new Set(["checklist_contract", "checklist_settlement"]);
const payOf = (v: unknown): Record<string, string> => (v && typeof v === "object" ? (v as Record<string, string>) : {});
/** 書類タブのまとまり(一覧表の group と同じ順)。 */
const GROUPS = [
  { key: "contract", label: "契約・媒介の書類" },
  { key: "settlement", label: "決済の書類" },
  { key: "other", label: "そのほかの書類" },
  { key: "oc", label: "OC の書類" },
  { key: "checklist", label: "書類確認書" },
] as const;
type KeyRow = { label: string; count: string };
const keyRowsOf = (v: unknown): KeyRow[] => (Array.isArray(v) ? (v as KeyRow[]) : []);
/** 鍵の行が出せる形か(番号・種類があり、本数が 1〜99)。 */
const keyRowOk = (k: KeyRow) => k.label.trim() !== "" && /^\d+$/.test(k.count) && Number(k.count) >= 1 && Number(k.count) <= 99;
type CostRow = { label: string; amount: string };
const costRowsOf = (v: unknown): CostRow[] => (Array.isArray(v) ? (v as CostRow[]) : []);
/** 諸費用の行が出せる形か(項目名があり、金額が 0 以上の整数)。 */
const costRowOk = (r: CostRow) => r.label.trim() !== "" && /^\d{1,13}$/.test(r.amount.replace(/,/g, ""));

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
      {docs && GROUPS.map((g) => {
        const list = docs.filter((d) => d.group === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key} className="space-y-1.5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{g.label}</h3>
            <ul className="flex flex-wrap gap-2">
              {list.map((d) => (
                <li key={d.docType}>
                  <Button variant="secondary" size="sm" onClick={() => { setDone(null); setOpen(d); }}>
                    <FileOutput className="h-4 w-4" />
                    {d.label}
                    {d.missing.length > 0 && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(空欄 {d.missing.length})</span>}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
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
  // 鍵の行は入力しやすいよう本数を文字で持ち、送るときに数にする。
  const [values, setValues] = useState<Record<string, unknown>>(
    doc.docType === "key_receipt" ? { ...doc.defaults, keys: [{ label: "", count: "1" }] }
      // 諸費用の金額は入力しやすいよう文字で持ち、送るときに数にする。
      : doc.docType === "settlement_guide_seller"
        ? { ...doc.defaults, costs: (doc.defaults.costs as { label: string; amount: number }[] ?? []).map((r) => ({ label: r.label, amount: String(r.amount) })) }
        : doc.defaults,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));
  const receipt = RECEIPTS.has(doc.docType);
  const issuer = doc.issuers?.find((i) => i.value === values.issuer) ?? null;
  // 個人の発行者は、非課税か課税かを決めるまで発行できない(設計 §4.3)。
  const needsDecision = receipt && issuer?.individual === true && values.exempt == null;
  const matters = Array.isArray(values.matters) ? (values.matters as string[]) : [];
  const keyRows = keyRowsOf(values.keys);
  const costRows = costRowsOf(values.costs);
  // 委任状は委任する事項が1つ以上・鍵受領書は鍵の行がすべて埋まっているまで発行できない(サーバーも 422)。
  const incomplete = (doc.docType === "power_of_attorney" && !matters.length && !str(values.otherMatter).trim())
    || (doc.docType === "key_receipt" && (!keyRows.length || !keyRows.every(keyRowOk)))
    || (doc.docType === "settlement_guide_seller" && !costRows.every(costRowOk));
  const setCost = (i: number, patch: Partial<CostRow>) => set("costs", costRows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setKey = (i: number, patch: Partial<KeyRow>) => set("keys", keyRows.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  const choices = doc.choices ?? {};
  const pay = payOf(values.pay);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = receipt
        ? { ...values, exempt: issuer?.individual ? values.exempt ?? null : null, receivedOn: str(values.receivedOn) || null }
        : doc.docType === "key_receipt"
          ? { ...values, keys: keyRows.map((k) => ({ label: k.label.trim(), count: Number(k.count) })), receivedOn: str(values.receivedOn) || null }
          : doc.docType === "power_of_attorney"
            ? { ...values, otherMatter: str(values.otherMatter).trim() || null, signedOn: str(values.signedOn) || null }
            : doc.docType === "landlord_change_notice"
              ? { ...values, changeOn: str(values.changeOn) || null }
              : doc.docType === "settlement_guide_seller"
                ? { ...values, costs: costRows.map((r) => ({ label: r.label.trim(), amount: Number(r.amount.replace(/,/g, "")) })) }
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
          <Button onClick={() => void issue()} disabled={busy || needsDecision || incomplete || doc.blocking.length > 0} loading={busy} loadingLabel="発行中">
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
        {doc.docType === "contract_guide" && (
          <>
            <Field label="宛先">
              <select aria-label="宛先" value={str(values.addressee)} onChange={(e) => set("addressee", e.target.value)} className={inputCls}>
                {(choices.addressee ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="お持ちいただくもの(1行に1つ)">
              <textarea value={str(values.belongings)} onChange={(e) => set("belongings", e.target.value || null)} maxLength={500} rows={4} aria-label="お持ちいただくもの" className={inputCls} />
            </Field>
            <Field label="ご連絡事項(空なら載せない)">
              <textarea value={str(values.notes)} onChange={(e) => set("notes", e.target.value || null)} maxLength={500} rows={3} aria-label="ご連絡事項" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">前に発行したことがあれば、そのときの入力が初めから入っています。</p>
          </>
        )}
        {doc.docType === "completion_confirmation" && (
          <>
            <Field label="引き渡した書類など(1行に1つ・チェック欄は空けて出す)">
              <textarea value={str(values.handover)} onChange={(e) => set("handover", e.target.value || null)} maxLength={1000} rows={6} aria-label="引き渡した書類など" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">署名・押印の欄は空けて出します。前に発行したことがあれば、そのときの入力が初めから入っています。</p>
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
        {doc.docType === "settlement_guide_seller" && (
          <>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">諸費用(お受取額から差し引くもの・初めは取引の費用)</p>
              {costRows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={r.label} onChange={(e) => setCost(i, { label: e.target.value })} maxLength={50} placeholder="例: 抵当権などの抹消費用" aria-label={`諸費用の項目 ${i + 1}`} className={inputCls} />
                  <input value={r.amount} onChange={(e) => setCost(i, { amount: e.target.value })} inputMode="numeric" aria-label={`諸費用の金額 ${i + 1}`} className={`${inputCls} w-36`} />
                  <span className="text-sm">円</span>
                  <Button variant="secondary" size="sm" aria-label={`諸費用の${i + 1}行目を消す`} onClick={() => set("costs", costRows.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {costRows.length < 30 && (
                <Button variant="secondary" size="sm" onClick={() => set("costs", [...costRows, { label: "", amount: "" }])}>
                  <Plus className="h-4 w-4" />
                  諸費用の行を足す
                </Button>
              )}
            </div>
            <Field label="お受け取りの口座(空なら「当日までにお知らせください」)">
              <textarea value={str(values.receiveTo)} onChange={(e) => set("receiveTo", e.target.value || null)} maxLength={300} rows={2} aria-label="お受け取りの口座" className={inputCls} />
            </Field>
            <Field label="お持ちいただくもの(1行に1つ)">
              <textarea value={str(values.belongings)} onChange={(e) => set("belongings", e.target.value || null)} maxLength={500} rows={4} aria-label="お持ちいただくもの" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">残代金+精算金−諸費用=当日のお受取額を出します。</p>
          </>
        )}
        {doc.docType === "power_of_attorney" && (
          <>
            <Field label="委任する人(委任者)">
              <select aria-label="委任者" value={str(values.principal)} onChange={(e) => set("principal", e.target.value)} className={inputCls}>
                {(choices.principal ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="委任を受ける人(代理人)">
              <select aria-label="代理人" value={str(values.agent)} onChange={(e) => set("agent", e.target.value)} className={inputCls}>
                {(choices.agent ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <fieldset className="space-y-1 text-sm">
              <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">委任する事項(1つ以上)</legend>
              {(choices.matters ?? []).map((m) => (
                <label key={m.value} className="flex items-center gap-2">
                  <input type="checkbox" checked={matters.includes(m.value)}
                    onChange={(e) => set("matters", e.target.checked ? [...matters, m.value] : matters.filter((x) => x !== m.value))} />
                  {m.label}
                </label>
              ))}
            </fieldset>
            <Field label="そのほかに委任する事項(任意)">
              <input value={str(values.otherMatter)} onChange={(e) => set("otherMatter", e.target.value)} maxLength={200} aria-label="そのほかに委任する事項" className={inputCls} />
            </Field>
            <Field label="日付(空なら日付の欄を空けて出す)">
              <input type="date" value={str(values.signedOn)} onChange={(e) => set("signedOn", e.target.value)} aria-label="日付" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">委任者の署名・実印の欄は空けて出します。</p>
          </>
        )}
        {doc.docType === "key_receipt" && (
          <>
            <Field label="受け取る人(受領者)">
              <select aria-label="受領者" value={str(values.receiver)} onChange={(e) => set("receiver", e.target.value)} className={inputCls}>
                {(choices.receiver ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">鍵の番号・種類と本数</p>
              {keyRows.map((k, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={k.label} onChange={(e) => setKey(i, { label: e.target.value })} maxLength={50} placeholder="例: 玄関 No.12" aria-label={`鍵の番号・種類 ${i + 1}`} className={inputCls} />
                  <input value={k.count} onChange={(e) => setKey(i, { count: e.target.value })} inputMode="numeric" aria-label={`本数 ${i + 1}`} className={`${inputCls} w-20`} />
                  <span className="text-sm">本</span>
                  <Button variant="secondary" size="sm" aria-label={`${i + 1}行目を消す`} onClick={() => set("keys", keyRows.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {keyRows.length < 30 && (
                <Button variant="secondary" size="sm" onClick={() => set("keys", [...keyRows, { label: "", count: "1" }])}>
                  <Plus className="h-4 w-4" />
                  行を足す
                </Button>
              )}
            </div>
            <Field label="受領日(空なら日付の欄を空けて出す)">
              <input type="date" value={str(values.receivedOn)} onChange={(e) => set("receivedOn", e.target.value)} aria-label="受領日" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">受領者の署名・押印の欄は空けて出します(自社が受け取るときも角印は付けません)。</p>
          </>
        )}
        {doc.docType === "landlord_change_notice" && (
          <>
            <Field label="変更日(初期値は決済日)">
              <input type="date" value={str(values.changeOn)} onChange={(e) => set("changeOn", e.target.value)} aria-label="変更日" className={inputCls} />
            </Field>
            <Field label="賃料のお振込先">
              <textarea value={str(values.payee)} onChange={(e) => set("payee", e.target.value || null)} maxLength={300} rows={2} aria-label="賃料のお振込先" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">賃借人のいる部屋ごとに1枚ずつ作ります。売主・買主の押印の欄は空けて出します。</p>
          </>
        )}
        {CHECKLISTS.has(doc.docType) && (
          <>
            {(choices.payItems ?? []).map((it) => (
              <Field key={it.value} label={`${it.label}の払い方`}>
                <select aria-label={`${it.label}の払い方`} value={pay[it.value] ?? "cash"} onChange={(e) => set("pay", { ...pay, [it.value]: e.target.value })} className={inputCls}>
                  {(choices.payMethods ?? []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Field>
            ))}
            <p className="text-xs text-gray-500">チェック欄は空けて出します(紙に手で付けてください)。持参する金額は決済の計算と取引の値を使います。</p>
          </>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
}
