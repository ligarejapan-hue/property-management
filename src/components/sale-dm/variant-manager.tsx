"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Pencil, FileText, Copy } from "lucide-react";
import type { SaleDmCampaign, SaleDmVariant, SaleDmVariantOptions } from "@/lib/api-client";
import {
  createSaleDmVariant,
  updateSaleDmVariant,
  deleteSaleDmVariant,
  assignSaleDmVariants,
  fetchSaleDmVariantPrompt,
  saveSaleDmVariantTemplate,
  applySaleDmVariantTemplate,
} from "@/lib/api-client";
import {
  DESIGN_OPTIONS,
  TONE_OPTIONS,
  LENGTH_OPTIONS,
  APPEAL_OPTIONS,
  STRENGTH_OPTIONS,
} from "@/lib/sale-dm-letter/adjust-model";

const DEFAULT_OPTIONS: SaleDmVariantOptions = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: "",
};

// lpUrl = この型のLP(印刷QRの遷移先)。空欄は既定 SALE_DM_LP_URL へ。型ごとに変えると LP の A/B ができる。
type FormState = { label: string; options: SaleDmVariantOptions; lpUrl: string };

// A/B の型(variant)を作成・編集・削除し、未送付の宛先を均等に割り当てる管理パネル。
// バックエンド(variants / assign route)を呼ぶだけで、A/B 純度の保護(送付済み凍結・本文無効化)は
// サーバー側が担保する。options 変更/割当は未送付の手紙を作り直し対象にし得るため確認ダイアログを出す。
export default function SaleDmVariantManager({
  campaign,
  onChanged,
}: {
  campaign: SaleDmCampaign;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>({ label: "", options: { ...DEFAULT_OPTIONS }, lpUrl: "" });
  const [assignOrder, setAssignOrder] = useState<"sequential" | "random">("sequential");

  // 外部AI方式（設計 §2.2/§2.3）。プロンプトを見せて、手元のAIで作った本文を貼り付け、
  // その型の全宛先へ差し込む。⚠日数や件数のような可変値は文言に焼き込まない。
  const [letterFor, setLetterFor] = useState<SaleDmVariant | null>(null);
  const [letter, setLetter] = useState<{
    prompt: string;
    digest: string;
    frozen: boolean;
    bodyTemplate: string | null;
    bodyDigest: string;
  } | null>(null);
  const [pasteBody, setPasteBody] = useState("");
  const [letterNotice, setLetterNotice] = useState<string | null>(null);

  // 文面パネルは開いたまま結果を出したいので、共通の run（編集フォームを閉じる）とは分ける。
  const runLetter = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const openLetter = (v: SaleDmVariant) =>
    runLetter(async () => {
      const res = await fetchSaleDmVariantPrompt(campaign.id, v.id);
      setLetterFor(v);
      setLetter(res);
      setPasteBody(res.bodyTemplate ?? "");
      setLetterNotice(null);
    });

  const copyPrompt = () =>
    runLetter(async () => {
      if (!letter) return;
      await navigator.clipboard.writeText(letter.prompt);
      setLetterNotice("プロンプトをコピーしました。お手元のAIに貼り付けてください");
    });

  const saveTemplate = () =>
    runLetter(async () => {
      if (!letterFor || !letter) return;
      const r = await saveSaleDmVariantTemplate(campaign.id, letterFor.id, {
        body: pasteBody,
        promptDigest: letter.digest,
        // 開いたときに見えていた原本。ほかの画面が先に保存していれば 409 で止まる。
        baseBodyDigest: letter.bodyDigest,
      });
      // 保存の応答が返した指紋へ更新する（開き直さずに続けて直せる）。
      // ⚠ここで取り直してはいけない（@codex #376 R15）。取り直すと、その一瞬に別の画面が
      //   保存していた場合に**相手の指紋**を自分の古い入力欄と組み合わせて持つことになり、
      //   次の保存が版ずれ検出をすり抜けて相手の文面を消す。書いた値の指紋を使う。
      setLetter({ ...letter, bodyTemplate: pasteBody, bodyDigest: r.bodyDigest });
      setLetterNotice(
        r.changed
          ? "本文を保存しました。続けて「この型の全宛先に適用」を押してください"
          : "同じ本文が保存済みです（変更はありません）",
      );
      onChanged();
    });

  const applyTemplate = (overwriteExisting: boolean) =>
    runLetter(async () => {
      if (!letterFor || !letter) return;
      const r = await applySaleDmVariantTemplate(campaign.id, letterFor.id, {
        overwriteExisting,
        // 画面が見ている原本。ほかの画面が差し替えていれば 409 で止まる
        // （見ていない文面を宛先へ書き込まない）。
        bodyDigest: letter.bodyDigest,
      });
      const parts = [`${r.appliedCount} 件に反映しました`];
      // 黙って減らさない: 飛ばした宛先は理由ごとに件数で伝える。
      if (r.skippedTagCount > 0) {
        parts.push(`所在や種別が入っていない ${r.skippedTagCount} 件は飛ばしました`);
      }
      if (r.skippedScopeCount > 0) {
        parts.push(`担当外の ${r.skippedScopeCount} 件は飛ばしました`);
      }
      setLetterNotice(parts.join("。"));
      onChanged();
    });

  const countByVariant = (vid: string) => campaign.recipients.filter((r) => r.variantId === vid).length;
  const sentByVariant = (vid: string) =>
    campaign.recipients.filter((r) => r.variantId === vid && r.status === "sent").length;

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    setError(null);
    setForm({ label: "", options: { ...DEFAULT_OPTIONS }, lpUrl: "" });
    setEditing("new");
  };
  const startEdit = (v: SaleDmVariant) => {
    setError(null);
    setForm({
      label: v.label,
      options: {
        designTemplate: v.designTemplate,
        tone: v.tone,
        length: v.length,
        appeal: v.appeal,
        strength: v.strength,
        extraInstruction: v.extraInstruction ?? "",
      },
      lpUrl: v.lpUrl ?? "",
    });
    setEditing(v.id);
  };

  const submit = () =>
    run(async () => {
      if (editing === "new") {
        await createSaleDmVariant(campaign.id, { label: form.label, options: form.options, lpUrl: form.lpUrl.trim() || undefined });
        return;
      }
      if (editing) {
        // ⚠警告を出すのは**プロンプトに載る4項目**を実際に変えたときだけ(@codex #376 R9)。
        //   サーバーはこの4つを変えたときにだけ文面と未送付の本文を消す。デザイン(見た目)と
        //   追加の指示は消さないので、ここで警告すると「消えないのに消える覚悟をさせる」ことに
        //   なる。label のみ・同じ値の再保存でも消えない(サーバー側 R24)。
        const cur = campaign.variants.find((v) => v.id === editing);
        const optionChanged =
          !cur ||
          form.options.tone !== cur.tone ||
          form.options.length !== cur.length ||
          form.options.appeal !== cur.appeal ||
          form.options.strength !== cur.strength;
        if (optionChanged && !window.confirm("文面の設定(トーン・長さ・訴求・押しの強さ)を変えると、この型の文面と、まだ送っていない手紙の本文が消えます。プロンプトを取り直して文面を作り直し、貼り付け直してください。続けますか？")) {
          return;
        }
        // LP(QRの遷移先)とデザイン(紙面の体裁)は本文を変えないが、**刷り上がり**が変わるため、
        // サーバー側で確定済み(印刷待ち)の宛先が確定解除され再確認が必要になる(@codex #376 R10)。
        // option 変更で既に警告済みなら二重に出さない。確定が0件なら何も起きないので黙って進む。
        const nextLp = form.lpUrl.trim() === "" ? null : form.lpUrl.trim();
        const lpUrlChanged = nextLp !== (cur?.lpUrl ?? null);
        const designChanged = !cur || form.options.designTemplate !== cur.designTemplate;
        const confirmedCount = campaign.recipients.filter((r) => r.variantId === editing && r.status === "confirmed").length;
        if (!optionChanged && (lpUrlChanged || designChanged) && confirmedCount > 0 &&
            !window.confirm(`印刷に関わる設定(デザイン・LP)を変更すると、確定済み(印刷待ち)の ${confirmedCount} 件は確定が解除され、再確認が必要になります(手紙の文面はそのまま残ります)。続けますか？`)) {
          return;
        }
        await updateSaleDmVariant(campaign.id, editing, { label: form.label, options: form.options, lpUrl: nextLp });
      }
    });

  const remove = (v: SaleDmVariant) => {
    if (!window.confirm(`型「${v.label}」を削除します。よろしいですか？(宛先が割り当てられている型は削除できません)`)) return;
    run(() => deleteSaleDmVariant(campaign.id, v.id));
  };

  const autoAssign = () => {
    if (!window.confirm("未送付の宛先を全ての型へ均等に割り当て直します。手紙の本文は作り直しが必要になる場合があります。続けますか？")) return;
    run(() => assignSaleDmVariants(campaign.id, { mode: "auto", order: assignOrder }));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">A/Bの型</h3>
        <button
          type="button"
          onClick={startNew}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> 型を追加
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <ul className="space-y-1">
        {campaign.variants.map((v) => (
          <li key={v.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
            <div>
              <span className="font-medium text-gray-700">{v.label}</span>
              <span className="ml-2 text-gray-400">
                割当 {countByVariant(v.id)} 件（送付済 {sentByVariant(v.id)}）
              </span>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => openLetter(v)}
                disabled={busy}
                aria-label={`型「${v.label}」の文面`}
                title="プロンプトを表示して、手元のAIで作った本文を貼り付けます"
                className="rounded p-1 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => startEdit(v)}
                disabled={busy}
                aria-label={`型「${v.label}」を編集`}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(v)}
                disabled={busy}
                aria-label={`型「${v.label}」を削除`}
                className="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        ))}
        {campaign.variants.length === 0 && <li className="text-xs text-gray-400">型がありません。「型を追加」で作成してください。</li>}
      </ul>

      {letterFor && letter && (
        <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-700">
              「{letterFor.label}」の文面
            </span>
            <button
              type="button"
              onClick={() => {
                setLetterFor(null);
                setLetter(null);
                setLetterNotice(null);
              }}
              className="text-gray-500 hover:underline"
            >
              閉じる
            </button>
          </div>

          {/* ⚠凍結でも**原本がまだ無い型**は入力欄を出す（@codex #376 R3）。反映前からある型は
              「確定済みの宛先はあるが原本は空」なので、ここを隠すと初期化ができず、
              割当で移ってきた宛先（本文は空）に何も入れられない。 */}
          {letter.frozen && letter.bodyTemplate ? (
            <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">
              この型はすでに送付の実績があるため、文面は変更できません。文面を変えるときは新しい型を追加してください。
              なお、保存済みの文面を「まだ本文が入っていない宛先」へ入れ直すことはできます（下のボタン）。
            </p>
          ) : (
            <>
              {letter.frozen && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">
                  この型には送付の実績がありますが、文面がまだ保存されていません。最初の1回だけ登録できます（登録済みの宛先の文面は変わりません）。
                </p>
              )}
              <p className="mt-2 text-gray-600">
                下の指示文をコピーして、お手元のAIに貼り付けてください。できた本文をこの下の欄に貼り付けて保存します。
              </p>
              <div className="mt-1.5 flex items-start gap-2">
                <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-[11px] leading-relaxed text-gray-700">
                  {letter.prompt}
                </pre>
                <button
                  type="button"
                  onClick={copyPrompt}
                  disabled={busy}
                  className="flex items-center gap-1 rounded border border-indigo-300 bg-white px-2 py-1 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                >
                  <Copy className="h-3.5 w-3.5" />
                  コピー
                </button>
              </div>

              <textarea
                value={pasteBody}
                onChange={(e) => setPasteBody(e.target.value)}
                placeholder="ここに、お手元のAIで作った本文を貼り付けてください"
                rows={6}
                className="mt-2 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />

            </>
          )}

          {/* ⚠適用は凍結済みでも使える（@codex #376）。割当で別の型へ移された宛先は
              本文が空になるため、ここを隠すと1件ずつ手で書くしかなくなる。
              禁止すべきは「差し替え」であって「保存済みの文面の適用」ではない。 */}
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveTemplate}
                disabled={busy}
                className="rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                本文を保存
              </button>
              <button
                type="button"
                onClick={() => applyTemplate(false)}
                disabled={busy}
                className="rounded border border-indigo-300 bg-white px-2.5 py-1 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
              >
                この型の全宛先に適用
              </button>
              <button
                type="button"
                onClick={() => applyTemplate(true)}
                disabled={busy}
                title="手直しした本文も置き換えます"
                className="rounded border border-gray-300 bg-white px-2.5 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                手直し分も置き換えて適用
              </button>
            </div>

          {letterNotice && (
            <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700">{letterNotice}</p>
          )}
        </div>
      )}

      {editing && (
        <VariantForm
          form={form}
          setForm={setForm}
          onSubmit={submit}
          onCancel={() => { setError(null); setEditing(null); }}
          busy={busy}
          isNew={editing === "new"}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
        <span className="text-xs text-gray-500">未送付の宛先を</span>
        <select
          value={assignOrder}
          aria-label="割り当て順"
          onChange={(e) => setAssignOrder(e.target.value as "sequential" | "random")}
          disabled={busy}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        >
          <option value="sequential">順番に</option>
          <option value="random">ランダムに</option>
        </select>
        <button
          type="button"
          onClick={autoAssign}
          disabled={busy || campaign.variants.length === 0}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          均等に割り当て
        </button>
      </div>
    </div>
  );
}

function VariantForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  busy,
  isNew,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  isNew: boolean;
}) {
  const setOpt = (k: keyof SaleDmVariantOptions, value: string) =>
    setForm({ ...form, options: { ...form.options, [k]: value } });

  return (
    <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-2">
      <input
        type="text"
        value={form.label}
        aria-label="型の名前"
        onChange={(e) => setForm({ ...form, label: e.target.value })}
        placeholder="型の名前(例: B案)"
        maxLength={40}
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
      <div className="grid grid-cols-2 gap-2">
        <Select label="デザイン" value={form.options.designTemplate} options={DESIGN_OPTIONS} onChange={(v) => setOpt("designTemplate", v)} />
        <Select label="トーン" value={form.options.tone} options={TONE_OPTIONS} onChange={(v) => setOpt("tone", v)} />
        <Select label="長さ" value={form.options.length} options={LENGTH_OPTIONS} onChange={(v) => setOpt("length", v)} />
        <Select label="訴求" value={form.options.appeal} options={APPEAL_OPTIONS} onChange={(v) => setOpt("appeal", v)} />
        <Select label="強さ" value={form.options.strength} options={STRENGTH_OPTIONS} onChange={(v) => setOpt("strength", v)} />
      </div>
      {/* ⚠「追加の指示」の入力欄は出さない（設計 §2.2 @codex R12/R46）。外部AIへ渡す
          プロンプトは選択値だけから作るのでこの欄は反映されず、所有者名や物件の事実が
          書かれていても運べない。値は既存データ保全のため列としては残している。 */}
      <div className="flex flex-col gap-0.5">
        <input
          type="url"
          value={form.lpUrl}
          aria-label="この型のLP URL"
          onChange={(e) => setForm({ ...form, lpUrl: e.target.value })}
          placeholder="この型のLP URL(任意・例 https://lp.example.com/a)"
          maxLength={2000}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <p className="text-[11px] text-gray-400">空欄の型は既定のLPへ。型ごとに変えると LP の A/B（振り分け）ができます。</p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || form.label.trim() === ""}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {isNew ? "作成" : "保存"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-gray-500">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
