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

type FormState = { label: string; options: SaleDmVariantOptions };

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
  const [form, setForm] = useState<FormState>({ label: "", options: { ...DEFAULT_OPTIONS } });
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
    setForm({ label: "", options: { ...DEFAULT_OPTIONS } });
    setEditing("new");
  };
  const startEdit = (v: SaleDmVariant) => {
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
    });
    setEditing(v.id);
  };

  const submit = () =>
    run(async () => {
      if (editing === "new") {
        await createSaleDmVariant(campaign.id, { label: form.label, options: form.options });
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
        await updateSaleDmVariant(campaign.id, editing, { label: form.label, options: form.options });
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
          onCancel={() => setEditing(null)}
          busy={busy}
          isNew={editing === "new"}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
        <span className="text-xs text-gray-500">未送付の宛先を</span>
        <select
          value={assignOrder}
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
