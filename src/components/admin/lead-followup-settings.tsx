"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getLeadFollowupSettings,
  updateLeadFollowupSettings,
  type LeadFollowupSettings,
  type LeadFollowupStep,
} from "@/lib/api-client";
import {
  FOLLOWUP_LIMITS,
  FOLLOWUP_SERIES,
  FOLLOWUP_SERIES_LABELS,
  type FollowupSeries,
} from "@/lib/lead-followup/steps";

// 追客メール(ステップメール)の区画(メール設定の画面の下)。設計 2026-11-16 §6。
// 一括査定・査定申込のお客様へ、登録した順番の文面を、登録した日数後に送る。
// ⚠第1段では送信の仕組みがまだ無い(設定だけ)。送信は第3段の定期実行で始まる。

/** 画面の入力(日数は打ちかけを許すため文字で持つ)。 */
export type StepDraft = { delayDays: string; subject: string; body: string };
export type StepDrafts = Record<FollowupSeries, StepDraft[]>;

export function toDrafts(steps: LeadFollowupSettings["steps"]): StepDrafts {
  return {
    new: steps.new.map((s) => ({ delayDays: String(s.delayDays), subject: s.subject, body: s.body })),
    hold: steps.hold.map((s) => ({ delayDays: String(s.delayDays), subject: s.subject, body: s.body })),
  };
}

/** 入力を保存の形へ。日数が数字でない通があれば、その場所を日本語で返す。 */
export function draftsToSteps(
  drafts: StepDrafts,
): { ok: true; steps: Record<FollowupSeries, LeadFollowupStep[]> } | { ok: false; error: string } {
  const steps: Record<FollowupSeries, LeadFollowupStep[]> = { new: [], hold: [] };
  for (const series of FOLLOWUP_SERIES) {
    for (const [i, d] of drafts[series].entries()) {
      const t = d.delayDays.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      if (!/^\d{1,3}$/.test(t)) {
        return { ok: false, error: `${FOLLOWUP_SERIES_LABELS[series]}の${i + 1}通目: 日数を数字で入れてください` };
      }
      steps[series].push({ delayDays: Number(t), subject: d.subject, body: d.body });
    }
  }
  return { ok: true, steps };
}

export function LeadFollowupSettingsSection() {
  const [settings, setSettings] = useState<LeadFollowupSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    let alive = true;
    getLeadFollowupSettings()
      .then((res) => {
        if (alive) setSettings(res.data);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loadError) {
    return (
      <SectionFrame>
        <p className="text-xs text-red-700 dark:text-red-300">追客メールの設定を読み込めませんでした。画面を再読み込みしてください。</p>
      </SectionFrame>
    );
  }
  if (!settings) {
    return (
      <SectionFrame>
        <p className="text-xs text-gray-500 dark:text-gray-400">読み込み中…</p>
      </SectionFrame>
    );
  }
  // 保存のたびに版番号が変わる=key で入力を作り直す(保存後の値で始める)。
  return (
    <LeadFollowupSettingsForm
      key={settings.version}
      initial={settings}
      savedNotice={savedOnce}
      onSaved={(s) => {
        setSavedOnce(true);
        setSettings(s);
      }}
    />
  );
}

function SectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700" aria-labelledby="lead-followup-title">
      <div>
        <h2 id="lead-followup-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          追客メール(一括査定・査定申込のお客様へ)
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          一括査定で登録した物件の所有者と、査定申込のお客様へ、下の順番の文面を、決めた日数後に1通ずつ送ります。
          お名前や入力内容はメールに載せません。
        </p>
      </div>
      {children}
    </section>
  );
}

export function LeadFollowupSettingsForm({
  initial,
  onSaved,
  savedNotice = false,
}: {
  initial: LeadFollowupSettings;
  onSaved: (s: LeadFollowupSettings) => void;
  /** 直前に保存した(版番号が変わって作り直された)ときに「保存しました」を出す */
  savedNotice?: boolean;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [drafts, setDrafts] = useState<StepDrafts>(() => toDrafts(initial.steps));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    savedNotice ? { kind: "ok", text: "保存しました" } : null,
  );

  const update = (series: FollowupSeries, next: StepDraft[]) => setDrafts((d) => ({ ...d, [series]: next }));

  const save = async () => {
    setMessage(null);
    const parsed = draftsToSteps(drafts);
    if (!parsed.ok) {
      setMessage({ kind: "err", text: parsed.error });
      return;
    }
    setSaving(true);
    try {
      const res = await updateLeadFollowupSettings({ version: initial.version, enabled, steps: parsed.steps });
      onSaved(res.data);
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "保存できませんでした" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionFrame>
      <ul className="list-disc space-y-1 pl-5 text-xs text-gray-600 dark:text-gray-300">
        <li>新規の流れ: 一括査定の物件を登録した日(査定申込は申し込んだ日)から数えます。日数が0の通は登録の直後に送る挨拶です(査定申込には送りません=受付メールが挨拶を兼ねます)。2通目からは、案件の状態が「未着手」「コンタクト中」のお客様だけに送ります。</li>
        <li>保留の流れ: 案件の状態が「保留」になった日から数え直して送ります。</li>
        <li>受付メールが届いた査定申込だけが対象です。追客を ON にした時刻より前の登録・申込には送りません。</li>
        <li>1つのアドレスへは1日1通まで、朝9時〜夜8時に送ります。末尾には会社の情報と配信停止のリンクが自動で付きます。</li>
      </ul>

      <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        ON にして保存すると、15分ごとの見回りで送り始めます。ON にする前に、査定サイトの規約に「参加会社から連絡が来る」旨があるかを確かめてください。
      </p>

      <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
        <input
          id="lead-followup-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        追客メールを送る(OFF にすると、全員への追客がすぐ止まります)
      </label>
      {initial.enabled && initial.enabledAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          ON にした時刻: {new Date(initial.enabledAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}(これより後の登録・申込が対象)
        </p>
      )}
      {initial.setupProblems.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="font-medium">ON にする前に、次をそろえてください。</p>
          <ul className="mt-1 list-disc pl-5">
            {initial.setupProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {FOLLOWUP_SERIES.map((series) => (
        <SeriesEditor key={series} series={series} drafts={drafts[series]} onChange={(next) => update(series, next)} />
      ))}

      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">末尾に自動で付く文(最初の1通の見本)</p>
        <pre className="whitespace-pre-wrap break-words rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
          {initial.footerPreview}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
          <Save className="h-4 w-4" />
          追客メールの設定を保存
        </Button>
        {message && (
          <span
            role="alert"
            className={`text-xs ${message.kind === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </SectionFrame>
  );
}

function SeriesEditor({
  series,
  drafts,
  onChange,
}: {
  series: FollowupSeries;
  drafts: StepDraft[];
  onChange: (next: StepDraft[]) => void;
}) {
  const set = (i: number, patch: Partial<StepDraft>) => onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= drafts.length) return;
    const next = [...drafts];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const base = series === "new" ? "登録" : "保留になった日";
  return (
    <fieldset className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{FOLLOWUP_SERIES_LABELS[series]}</legend>
      {drafts.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">まだ1通もありません。</p>}
      {drafts.map((d, i) => (
        <div key={i} className="space-y-2 rounded-md bg-gray-50 p-3 dark:bg-gray-900/40" data-step={`${series}-${i + 1}`}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-gray-700 dark:text-gray-200">{i + 1}通目</span>
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
              {base}から
              <input
                id={`lead-followup-${series}-${i}-days`}
                inputMode="numeric"
                value={d.delayDays}
                onChange={(e) => set(i, { delayDays: e.target.value })}
                className="w-16 rounded border border-gray-300 px-2 py-1 text-right text-sm dark:border-gray-600 dark:bg-gray-800"
                aria-label={`${FOLLOWUP_SERIES_LABELS[series]}の${i + 1}通目の日数`}
              />
              日後
            </label>
            <span className="ml-auto flex gap-1">
              <IconButton label="上へ" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="h-4 w-4" />
              </IconButton>
              <IconButton label="下へ" onClick={() => move(i, 1)} disabled={i === drafts.length - 1}>
                <ArrowDown className="h-4 w-4" />
              </IconButton>
              <IconButton label="この通を消す" onClick={() => onChange(drafts.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </span>
          </div>
          <input
            id={`lead-followup-${series}-${i}-subject`}
            value={d.subject}
            maxLength={FOLLOWUP_LIMITS.subject}
            onChange={(e) => set(i, { subject: e.target.value })}
            placeholder="件名"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
            aria-label={`${FOLLOWUP_SERIES_LABELS[series]}の${i + 1}通目の件名`}
          />
          <textarea
            id={`lead-followup-${series}-${i}-body`}
            value={d.body}
            maxLength={FOLLOWUP_LIMITS.body}
            onChange={(e) => set(i, { body: e.target.value })}
            placeholder="本文(お名前などは入りません。末尾の会社の情報と配信停止のリンクは自動で付きます)"
            rows={5}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
            aria-label={`${FOLLOWUP_SERIES_LABELS[series]}の${i + 1}通目の本文`}
          />
        </div>
      ))}
      {drafts.length < FOLLOWUP_LIMITS.stepsPerSeries && (
        <Button
          variant="secondary"
          onClick={() => {
            const last = drafts.at(-1);
            const lastDays = last && /^\d+$/.test(last.delayDays.trim()) ? Number(last.delayDays.trim()) : 0;
            onChange([...drafts, { delayDays: String(Math.min(lastDays + 30, FOLLOWUP_LIMITS.maxDelayDays)), subject: "", body: "" }]);
          }}
        >
          <Plus className="h-4 w-4" />
          通を足す
        </Button>
      )}
    </fieldset>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="px-1.5"
    >
      {children}
    </Button>
  );
}
