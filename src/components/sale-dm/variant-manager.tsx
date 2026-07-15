"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Pencil } from "lucide-react";
import type { SaleDmCampaign, SaleDmVariant, SaleDmVariantOptions } from "@/lib/api-client";
import {
  createSaleDmVariant,
  updateSaleDmVariant,
  deleteSaleDmVariant,
  assignSaleDmVariants,
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
        // options を「実際に」変えたときだけ未送付下書きが無効化(本文クリア+確定解除=要再生成)される
        // (サーバー側 R24: label のみ/同値は無効化しない)。option が変わる場合のみ確認ダイアログを出す
        // (label だけの変更で誤った「作り直し」警告を出さない)。
        const cur = campaign.variants.find((v) => v.id === editing);
        const optionChanged =
          !cur ||
          form.options.designTemplate !== cur.designTemplate ||
          form.options.tone !== cur.tone ||
          form.options.length !== cur.length ||
          form.options.appeal !== cur.appeal ||
          form.options.strength !== cur.strength ||
          (form.options.extraInstruction ?? "") !== (cur.extraInstruction ?? "");
        if (optionChanged && !window.confirm("型の設定を変更すると、この型を使う未送付の手紙は作り直しが必要になります(確定も解除されます)。続けますか？")) {
          return;
        }
        // lpUrl は本文に影響しない(QR遷移先のみ・空欄=null=既定LPへ戻す)が、変更するとサーバー側でこの型の
        // 確定済み(印刷待ち)宛先が確定解除され再確認が必要になる。option 変更で既に警告済みなら二重に出さない。
        const nextLp = form.lpUrl.trim() === "" ? null : form.lpUrl.trim();
        const lpUrlChanged = nextLp !== (cur?.lpUrl ?? null);
        const confirmedCount = campaign.recipients.filter((r) => r.variantId === editing && r.status === "confirmed").length;
        if (!optionChanged && lpUrlChanged && confirmedCount > 0 &&
            !window.confirm(`この型のLPを変更すると、確定済み(印刷待ち)の ${confirmedCount} 件は確定が解除され、再確認が必要になります(本文の作り直しは不要)。続けますか？`)) {
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
    <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-2 dark:border-indigo-800 dark:bg-indigo-950/30">
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
      <textarea
        value={form.options.extraInstruction ?? ""}
        onChange={(e) => setOpt("extraInstruction", e.target.value)}
        placeholder="追加の指示(任意・最大1000文字)"
        maxLength={1000}
        rows={2}
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
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
