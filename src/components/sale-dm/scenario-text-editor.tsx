"use client";

import { useState } from "react";
import { Loader2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchSaleDmScenarioPrompt,
  saveSaleDmScenarioTemplate,
  updateSaleDmScenario,
  apiErrorCode,
  type SaleDmScenario,
  type SaleDmScenarioPatch,
} from "@/lib/api-client";
import { DESIGN_OPTIONS, TONE_OPTIONS, LENGTH_OPTIONS, APPEAL_OPTIONS, STRENGTH_OPTIONS } from "@/lib/sale-dm-letter/adjust-model";

type Kind = "letter" | "lp";
type SettingKey = "designTemplate" | "tone" | "length" | "appeal" | "strength" | "lpTone" | "lpLength" | "lpAppeal" | "lpStrength";
type Setting = { key: SettingKey; label: string; options: readonly { value: string; label: string }[] };

// 書き方の設定(設計 §3.6)。手紙=デザイン・語調・長さ・訴求・押しの強さ(+追加の指示)/LP=語調・長さ・訴求・押しの強さ。
const SETTINGS: Record<Kind, Setting[]> = {
  letter: [
    { key: "designTemplate", label: "デザイン", options: DESIGN_OPTIONS },
    { key: "tone", label: "語調", options: TONE_OPTIONS },
    { key: "length", label: "長さ", options: LENGTH_OPTIONS },
    { key: "appeal", label: "訴求", options: APPEAL_OPTIONS },
    { key: "strength", label: "押しの強さ", options: STRENGTH_OPTIONS },
  ],
  lp: [
    { key: "lpTone", label: "語調", options: TONE_OPTIONS },
    { key: "lpLength", label: "長さ", options: LENGTH_OPTIONS },
    { key: "lpAppeal", label: "訴求", options: APPEAL_OPTIONS },
    { key: "lpStrength", label: "押しの強さ", options: STRENGTH_OPTIONS },
  ],
};

const TITLE: Record<Kind, string> = { letter: "手紙の文面", lp: "LP(ご案内ページ)の文章" };

/**
 * DMの種類(台帳)の文面づくり(設計 2026-09-27 §3.6)。手紙とLPを kind で切り替える1つの部品。
 * 流れは発送の画面の型と同じ「書き方を選ぶ → 指示文をコピー → お手元のAIで作った文面を貼り付けて保存」。
 * ⚠書き方の設定を変えると、サーバーが登録済みの文面(LPは写真と図の枠も)を消す(古い指示文で作った文面を残さない)。
 */
export default function ScenarioTextEditor({
  scenario,
  kind,
  onChanged,
}: {
  scenario: SaleDmScenario;
  kind: Kind;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 指示文をコピーしたときの指紋。保存のときに「その後で設定・文面が変わっていないか」をサーバーが確かめる。
  const [prompt, setPrompt] = useState<{ prompt: string; digest: string; bodyDigest: string } | null>(null);
  const [paste, setPaste] = useState("");
  const [extra, setExtra] = useState(scenario.extraInstruction ?? "");

  const currentBody = kind === "letter" ? scenario.letterBodyTemplate : scenario.lpRawTemplate;
  const settings = SETTINGS[kind];
  const settingsComplete = settings.every((s) => !!scenario[s.key]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const saveSetting = (patch: SaleDmScenarioPatch) =>
    run(async () => {
      if (currentBody && !window.confirm("書き方の設定を変えると、登録済みの文面が消えます(作り直しになります)。続けますか？")) return;
      const r = await updateSaleDmScenario(scenario.id, patch);
      if (r.changedFields.length === 0) return;
      // 指示文が変わったので、手元の指紋は使えない(コピーし直してもらう)。
      setPrompt(null);
      if (currentBody) setNotice("設定を変えたので、文面を作り直してください");
      onChanged();
    });

  const copyPrompt = () =>
    run(async () => {
      const r = await fetchSaleDmScenarioPrompt(scenario.id, kind);
      setPrompt({ prompt: r.prompt, digest: r.digest, bodyDigest: r.bodyDigest });
      try {
        await navigator.clipboard.writeText(r.prompt);
        setNotice("指示文をコピーしました。お手元のAIに貼り付け、できた文面を下の欄に貼り付けて「保存」を押してください");
      } catch {
        setNotice("コピーできませんでした。下に出した指示文を選んでコピーしてください");
      }
    });

  const saveTemplate = () =>
    run(async () => {
      if (!prompt) {
        setError("先に「指示文をコピー」を押してください");
        return;
      }
      try {
        const r = await saveSaleDmScenarioTemplate(scenario.id, kind, {
          body: paste,
          promptDigest: prompt.digest,
          baseBodyDigest: prompt.bodyDigest,
        });
        // 書いた値の指紋に更新する(取り直すと、別の画面の保存を自分の指紋として持ってしまう)。
        setPrompt({ ...prompt, bodyDigest: r.bodyDigest });
        setPaste("");
        setNotice(r.changed ? "文面を保存しました" : "同じ文面が保存済みです(変更はありません)");
        onChanged();
      } catch (e) {
        if (apiErrorCode(e) === "PROMPT_STALE") {
          setPrompt(null);
          throw new Error("設定が変わりました。指示文をコピーし直してください");
        }
        throw e;
      }
    });

  const selectClass =
    "rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{TITLE[kind]}</h2>
        <span className={`text-xs ${currentBody ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}>
          {currentBody ? "登録済み" : "未登録"}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        {settings.map((s) => (
          <label key={s.key} className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            {s.label}
            <select
              value={scenario[s.key] ?? ""}
              disabled={busy}
              onChange={(e) => { if (e.target.value) void saveSetting({ [s.key]: e.target.value }); }}
              className={selectClass}
            >
              {!scenario[s.key] && <option value="">選んでください</option>}
              {s.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {kind === "letter" && (
        <div className="mt-3">
          <label className="block text-xs text-gray-600 dark:text-gray-400" htmlFor={`extra-${scenario.id}`}>追加の指示(任意)</label>
          <div className="mt-1 flex items-start gap-2">
            <textarea
              id={`extra-${scenario.id}`}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="例: 季節のあいさつを入れる"
              className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || extra.trim() === (scenario.extraInstruction ?? "")}
              onClick={() => void saveSetting({ extraInstruction: extra })}
            >
              追加の指示を保存
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-800/50">
        <p className="text-gray-600 dark:text-gray-300">
          「指示文をコピー」を押して、お手元のAIに貼り付けてください。できた文面をこの下の欄に貼り付けて保存します。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copyPrompt()} disabled={busy || !settingsComplete}>
            <Copy className="h-3.5 w-3.5" />
            指示文をコピー
          </Button>
          {!settingsComplete && <span className="text-xs text-gray-500 dark:text-gray-400">先に書き方の設定をすべて選んでください</span>}
        </div>
        {prompt && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-[11px] leading-relaxed text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
            {prompt.prompt}
          </pre>
        )}
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={kind === "letter" ? "ここに、お手元のAIで作った手紙の文面を貼り付けてください" : "ここに、お手元のAIで作った文章を貼り付けてください(【見出し】から始まります)"}
          rows={8}
          aria-label={`${TITLE[kind]}の貼り付け欄`}
          className="mt-2 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" onClick={() => void saveTemplate()} disabled={busy || paste.trim() === ""}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            保存
          </Button>
        </div>
        {notice && <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700 dark:bg-gray-900 dark:text-gray-200">{notice}</p>}
        {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}
      </div>

      {currentBody && (
        <div className="mt-4">
          <div className="text-xs font-medium text-gray-600 dark:text-gray-400">いま登録されている文面</div>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-3 text-sm leading-relaxed text-gray-800 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-200">
            {currentBody}
          </pre>
        </div>
      )}
    </section>
  );
}
