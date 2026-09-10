"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Pencil, FileText, Copy, Image as ImageIcon } from "lucide-react";
import type { SaleDmCampaign, SaleDmLpVariant, SaleDmLpVariantOptions } from "@/lib/api-client";
import {
  createSaleDmLpVariant,
  updateSaleDmLpVariant,
  deleteSaleDmLpVariant,
  fetchSaleDmLpVariantPrompt,
  saveSaleDmLpVariantTemplate,
} from "@/lib/api-client";
import { TONE_OPTIONS, LENGTH_OPTIONS, APPEAL_OPTIONS, STRENGTH_OPTIONS } from "@/lib/sale-dm-letter/adjust-model";
import LpMediaPanel from "./lp-media-panel";

const DEFAULT_OPTIONS: SaleDmLpVariantOptions = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
type FormState = { label: string; options: SaleDmLpVariantOptions };

// LP型(設計 2026-09-08 §2.1/§2.2)の管理パネル。DM型と独立の A/B 軸。
// 割当はDM型のパネルの「均等に割り当て」が両軸をまとめて行う(assign route)。
export default function SaleDmLpVariantManager({ campaign, onChanged }: { campaign: SaleDmCampaign; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>({ label: "", options: { ...DEFAULT_OPTIONS } });

  const [letterFor, setLetterFor] = useState<SaleDmLpVariant | null>(null);
  const [letter, setLetter] = useState<{ prompt: string; digest: string; frozen: boolean; rawTemplate: string | null; bodyDigest: string } | null>(null);
  const [pasteBody, setPasteBody] = useState("");
  const [letterNotice, setLetterNotice] = useState<string | null>(null);
  const [mediaFor, setMediaFor] = useState<SaleDmLpVariant | null>(null);

  const run = async (fn: () => Promise<unknown>, keepPanel = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (!keepPanel) setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const countByLp = (lid: string) => campaign.recipients.filter((r) => r.lpVariantId === lid).length;
  const sentByLp = (lid: string) => campaign.recipients.filter((r) => r.lpVariantId === lid && r.status === "sent").length;

  const startNew = () => { setForm({ label: "", options: { ...DEFAULT_OPTIONS } }); setEditing("new"); };
  const startEdit = (v: SaleDmLpVariant) => { setForm({ label: v.label, options: { tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength } }); setEditing(v.id); };
  const copyFromDm = (variantId: string) => {
    const v = campaign.variants.find((x) => x.id === variantId);
    if (!v) return;
    setForm((f) => ({ ...f, options: { tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength } }));
  };
  const setOpt = (k: keyof SaleDmLpVariantOptions, value: string) => setForm((f) => ({ ...f, options: { ...f.options, [k]: value } }));

  const submit = () => {
    if (editing === "new") return run(() => createSaleDmLpVariant(campaign.id, { label: form.label, options: form.options }));
    if (!editing) return;
    const prev = campaign.lpVariants.find((v) => v.id === editing);
    const optionChanged = !!prev && (["tone", "length", "appeal", "strength"] as const).some((k) => prev[k] !== form.options[k]);
    if (optionChanged && !window.confirm("文体の設定を変えると、このLP型に保存済みの文章は消えます(貼り直しが必要です)。続けますか？")) return;
    return run(() => updateSaleDmLpVariant(campaign.id, editing, { label: form.label, options: form.options }));
  };
  const remove = (v: SaleDmLpVariant) => {
    if (!window.confirm(`LP型「${v.label}」を削除します。割り当て中の未送付宛先は割当なしに戻ります。よろしいですか？(確定・送付済みの宛先があるLP型は削除できません)`)) return;
    run(() => deleteSaleDmLpVariant(campaign.id, v.id));
  };

  const openLetter = (v: SaleDmLpVariant) =>
    run(async () => {
      setMediaFor(null);
      const res = await fetchSaleDmLpVariantPrompt(campaign.id, v.id);
      setLetterFor(v);
      setLetter(res);
      setPasteBody(res.rawTemplate ?? "");
      setLetterNotice(null);
    }, true);
  const copyPrompt = () =>
    run(async () => {
      if (!letter) return;
      await navigator.clipboard.writeText(letter.prompt);
      setLetterNotice("プロンプトをコピーしました。お手元のAIに貼り付けてください");
    }, true);
  const saveTemplate = () =>
    run(async () => {
      if (!letterFor || !letter) return;
      const r = await saveSaleDmLpVariantTemplate(campaign.id, letterFor.id, { body: pasteBody, promptDigest: letter.digest, baseBodyDigest: letter.bodyDigest });
      // 保存の応答が返した指紋へ更新する(取り直さない。DM型と同じ理由)。
      setLetter({ ...letter, rawTemplate: pasteBody, bodyDigest: r.bodyDigest });
      const mediaDropped = r.parts?.mediaDropped ?? 0;
      setLetterNotice(
        r.changed && r.parts
          ? `保存しました。見出し「${r.parts.headline}」・本文 ${r.parts.bodyLength} 字・よくある質問 ${r.parts.faqCount} 組${r.parts.lead ? "・リード文あり" : "・リード文なし"}${mediaDropped > 0 ? `・小見出しが変わったため写真や図を外した節 ${mediaDropped}` : ""}`
          : "同じ文章が保存済みです(変更はありません)",
      );
    }, true);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">LP型(ご案内ページの A/B)</h3>
        <button type="button" onClick={startNew} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> LP型を追加
        </button>
      </div>
      {campaign.lpVariants.length === 0 && (
        <p className="text-xs text-gray-500">LP型がまだありません。この段階で作れるのは文章とA/Bの割当までで、QRの飛び先は当面これまでどおり外部LPです(アプリ内のご案内ページは次の段階で公開されます)。</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      <ul className="space-y-1">
        {campaign.lpVariants.map((v) => (
          <li key={v.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
            <div>
              <span className="font-medium text-gray-700">{v.label}</span>
              <span className="ml-2 text-gray-400">割当 {countByLp(v.id)} 件(送付済 {sentByLp(v.id)})</span>
              {v.headline ? <span className="ml-2 text-gray-500">「{v.headline}」</span> : <span className="ml-2 text-amber-700">文章なし</span>}
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => openLetter(v)} disabled={busy} aria-label={`LP型「${v.label}」の文章`} title="プロンプトを表示して、手元のAIで作った文章を貼り付けます" className="rounded p-1 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"><FileText className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => { setLetterFor(null); setLetter(null); setMediaFor(v); }} disabled={busy || !v.headline} aria-label={`LP型「${v.label}」の写真と図`} title={v.headline ? "写真と図" : "先に文章を保存してください"} className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"><ImageIcon className="h-3.5 w-3.5" />写真と図</button>
              <button type="button" onClick={() => startEdit(v)} disabled={busy} aria-label={`LP型「${v.label}」を編集`} className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => remove(v)} disabled={busy} aria-label={`LP型「${v.label}」を削除`} className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
          <label className="block">
            <span className="text-gray-600">ラベル</span>
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} maxLength={40} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
          </label>
          {campaign.variants.length > 0 && (
            <label className="block">
              <span className="text-gray-600">DM型の設定を写す</span>
              <select defaultValue="" onChange={(e) => copyFromDm(e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm">
                <option value="">(選ぶと文体4項目を写します)</option>
                {campaign.variants.map((v) => <option key={v.id} value={v.id}>型 {v.label}</option>)}
              </select>
            </label>
          )}
          {([["tone", "トーン", TONE_OPTIONS], ["length", "長さ", LENGTH_OPTIONS], ["appeal", "訴求の軸", APPEAL_OPTIONS], ["strength", "押しの強さ", STRENGTH_OPTIONS]] as const).map(([k, name, opts]) => (
            <label key={k} className="block">
              <span className="text-gray-600">{name}</span>
              <select value={form.options[k]} onChange={(e) => setOpt(k, e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm">
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} disabled={busy} className="rounded border border-gray-300 bg-white px-2.5 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50">キャンセル</button>
            <button type="button" onClick={submit} disabled={busy || form.label.trim().length === 0} className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy && <Loader2 className="h-3 w-3 animate-spin" />} 保存
            </button>
          </div>
        </div>
      )}

      {letterFor && letter && (
        <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-700">「{letterFor.label}」の文章</span>
            <button type="button" onClick={() => { setLetterFor(null); setLetter(null); setLetterNotice(null); }} className="text-gray-500 hover:underline">閉じる</button>
          </div>
          {letter.frozen && letter.rawTemplate ? (
            <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型はすでに送付の実績があるため、文章は変更できません。文章を変えるときは新しいLP型を追加してください。</p>
          ) : (
            <>
              {letter.frozen && <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型には送付の実績がありますが、文章がまだ保存されていません。最初の1回だけ登録できます。</p>}
              <p className="mt-2 text-gray-600">下の指示文をコピーして、お手元のAIに貼り付けてください。返ってきた文章(【見出し】〜【よくある質問】まで)をそのまま下の欄に貼り付けて保存します。</p>
              <div className="mt-1.5 flex items-start gap-2">
                <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-[11px] leading-relaxed text-gray-700">{letter.prompt}</pre>
                <button type="button" onClick={copyPrompt} disabled={busy} className="flex items-center gap-1 rounded border border-indigo-300 bg-white px-2 py-1 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"><Copy className="h-3.5 w-3.5" />コピー</button>
              </div>
              <textarea value={pasteBody} onChange={(e) => setPasteBody(e.target.value)} placeholder="ここに、お手元のAIで作った文章を貼り付けてください(【見出し】から始まります)" rows={10} className="mt-2 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
              <div className="mt-1.5 flex justify-end gap-2">
                <button type="button" onClick={saveTemplate} disabled={busy} className="rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-700 disabled:opacity-50">文章を保存</button>
              </div>
            </>
          )}
          {letterNotice && <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700">{letterNotice}</p>}
        </div>
      )}

      {mediaFor && <LpMediaPanel campaignId={campaign.id} lpId={mediaFor.id} label={mediaFor.label} onClose={() => setMediaFor(null)} />}
    </div>
  );
}
