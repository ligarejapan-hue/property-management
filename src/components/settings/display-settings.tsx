"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Check, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  THEME_OPTIONS,
  DENSITY_OPTIONS,
  LAYOUT_OPTIONS,
  DEFAULT_APPEARANCE,
  fromNextTheme,
  toNextTheme,
  type Appearance,
  type AppearancePatch,
  type DensityPref,
  type LayoutPref,
  type ThemePref,
} from "@/lib/appearance/options";
import {
  applyDensity,
  applyLayout,
  loadPreferences,
  readDensity,
  readLayout,
  savePreferences,
  subscribeAppearance,
  PREFERENCES_SAVED_EVENT,
  type PreferencesData,
} from "@/lib/appearance/client";
import { ThemePreview, DensityPreview, LayoutPreview } from "./display-previews";

// 見た目の設定 段階4(2026-10-31): 設定 > 表示。
// - 3つの設定を見本付きの選択肢で並べる。選択肢は本物のラジオボタン(キーボードの矢印で選べる・読み上げで分かる)。
// - 押した瞬間に画面全体へ反映し、保存は自動(「保存しました」を小さく出す)。
// - 「会社の標準に戻す」= 3つとも null を保存(個人の設定を消す)して、会社の標準で描き直す。
// - 管理者(canEditCompany)には「会社の標準」の欄も出す。こちらは皆に効くので、保存のボタンで確定する。
// 選択肢の中身は src/lib/appearance/options.ts の1か所。

type Status = { kind: "ok" | "err"; text: string } | null;

const labelOf = (options: readonly { value: string; label: string }[], value: string | undefined) =>
  options.find((o) => o.value === value)?.label;

/** 見本付きの選択肢1つ(ラジオボタン)。選ばれている・キーボードで選んでいる が枠で分かる。 */
export function ChoiceCard({
  name,
  value,
  checked,
  label,
  hint,
  preview,
  onSelect,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  hint?: string;
  preview: ReactNode;
  onSelect: (value: string) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer flex-col gap-2 rounded-lg border bg-surface p-2.5 transition-colors motion-reduce:transition-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
        checked ? "border-accent ring-1 ring-accent" : "border-line hover:border-fg-3"
      }`}
    >
      {preview}
      <span className="flex items-start gap-2">
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={() => onSelect(value)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-fg">{label}</span>
          {hint && <span className="block text-xs text-fg-3">{hint}</span>}
        </span>
      </span>
    </label>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="rounded-lg border border-line bg-surface p-4">
      <legend className="px-1 text-base font-semibold text-fg">{title}</legend>
      {note && <p className="mb-3 text-xs text-fg-3">{note}</p>}
      {children}
    </fieldset>
  );
}

/** 「会社の標準: ○○」と、個人で選んでいないときの「(会社の標準を使用中)」。 */
function companyNote(
  options: readonly { value: string; label: string }[],
  company: string | undefined,
  fallback: string,
  personal: string | null | undefined,
) {
  const name = labelOf(options, company) ?? labelOf(options, fallback);
  return (
    <>
      会社の標準: {name}
      {!personal && <span className="ml-1 text-fg-2">(いまは会社の標準を使っています)</span>}
    </>
  );
}

export default function DisplaySettings() {
  const { theme: nextTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 続けて選んだとき、先に送った保存の応答があとから届いても表示を古い値で上書きしない(最後の保存だけ使う)
  const saveSeq = useRef(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mount guard to avoid hydration mismatch (standard next-themes pattern)
    setMounted(true);
    let alive = true;
    void loadPreferences(true).then((d) => {
      if (!alive) return;
      if (d) setPrefs(d);
      else setLoadFailed(true);
    });
    // 利用者メニュー・スマホのメニューで保存したときも表示(会社の標準を使用中か・戻すボタン)を合わせる(@codex #623)
    const onSaved = (e: Event) => {
      if (alive) setPrefs((e as CustomEvent<PreferencesData>).detail);
    };
    window.addEventListener(PREFERENCES_SAVED_EVENT, onSaved);
    return () => {
      alive = false;
      clearTimeout(timer.current);
      window.removeEventListener(PREFERENCES_SAVED_EVENT, onSaved);
    };
  }, []);

  const density = useSyncExternalStore<DensityPref>(subscribeAppearance, readDensity, () => "normal");
  const layout = useSyncExternalStore<LayoutPref>(subscribeAppearance, readLayout, () => "side");
  const theme: ThemePref = mounted ? fromNextTheme(nextTheme) : "auto";

  const show = (s: Status) => {
    setStatus(s);
    clearTimeout(timer.current);
    // 「保存しました」は少しで消す(失敗の知らせは消さない)
    if (s?.kind === "ok") timer.current = setTimeout(() => setStatus(null), 2500);
  };

  const applyAll = (a: Appearance) => {
    setTheme(toNextTheme(a.theme));
    applyDensity(a.density);
    applyLayout(a.layout);
  };

  const save = async (patch: AppearancePatch) => {
    const seq = ++saveSeq.current;
    const saved = await savePreferences(patch);
    // 後から別の選択をしていたら、この応答は使わない(null=呼び出し側も反映しない・@codex #623)
    if (seq !== saveSeq.current) return null;
    if (saved) {
      setPrefs(saved);
      show({ kind: "ok", text: "保存しました" });
    } else {
      show({ kind: "err", text: "保存できませんでした。画面には反映していますが、次に開いたときは元に戻ります。" });
    }
    return saved;
  };

  const resetToCompany = async () => {
    const saved = await save({ theme: null, density: null, layout: null });
    if (saved) applyAll(saved.effective);
  };

  const allowed = prefs?.allowedThemes ?? THEME_OPTIONS.map((o) => o.value);
  const themeChoices = THEME_OPTIONS.filter((o) => allowed.includes(o.value));
  const usingCompany = prefs && !prefs.user.theme && !prefs.user.density && !prefs.user.layout;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-fg-2">選ぶとすぐに画面が変わり、自動で保存されます。ほかのパソコン・スマホでも同じ見た目になります。</p>
        <span role="status" aria-live="polite" className="min-h-[1.25rem] text-xs">
          {status && (
            <span className={`inline-flex items-center gap-1 ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
              {status.kind === "ok" && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              {status.text}
            </span>
          )}
        </span>
      </div>
      {loadFailed && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          設定を読み込めませんでした。選んだ見た目は画面に反映しますが、会社の標準は表示できません。
        </p>
      )}

      <Section
        title="色テーマ"
        note={prefs && companyNote(THEME_OPTIONS, prefs.company.theme, DEFAULT_APPEARANCE.theme, prefs.user.theme)}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {themeChoices.map((o) => (
            <ChoiceCard
              key={o.value}
              name="theme"
              value={o.value}
              checked={theme === o.value}
              label={o.label}
              hint={o.hint}
              preview={<ThemePreview theme={o.value} />}
              onSelect={(v) => {
                setTheme(toNextTheme(v as ThemePref));
                void save({ theme: v as ThemePref });
              }}
            />
          ))}
        </div>
      </Section>

      <Section
        title="文字サイズ"
        note={prefs && companyNote(DENSITY_OPTIONS, prefs.company.density, DEFAULT_APPEARANCE.density, prefs.user.density)}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {DENSITY_OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              name="density"
              value={o.value}
              checked={density === o.value}
              label={o.label}
              hint={o.hint}
              preview={<DensityPreview density={o.value} />}
              onSelect={(v) => {
                applyDensity(v as DensityPref);
                void save({ density: v as DensityPref });
              }}
            />
          ))}
        </div>
      </Section>

      <Section
        title="メニューの配置"
        note={
          <>
            {prefs && companyNote(LAYOUT_OPTIONS, prefs.company.layout, DEFAULT_APPEARANCE.layout, prefs.user.layout)}
            <span className="block">スマホ・タブレットの幅では、どちらを選んでも左上の ≡ のメニューになります。</span>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
          {LAYOUT_OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              name="layout"
              value={o.value}
              checked={layout === o.value}
              label={o.label}
              hint={o.hint}
              preview={<LayoutPreview layout={o.value} />}
              onSelect={(v) => {
                applyLayout(v as LayoutPref);
                void save({ layout: v as LayoutPref });
              }}
            />
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void resetToCompany()} disabled={!prefs || !!usingCompany}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          会社の標準に戻す
        </Button>
        <span className="text-xs text-fg-3">
          {usingCompany ? "いまは3つとも会社の標準です。" : "色・文字サイズ・配置の3つを、会社の標準にそろえます。"}
        </span>
      </div>

      {prefs?.canEditCompany && <CompanyDefaults prefs={prefs} onSaved={(d) => { setPrefs(d); applyAll(d.effective); }} />}
    </div>
  );
}

const selectClass =
  "min-h-[40px] w-full rounded-md border border-line bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent";

/** 管理者だけ: 会社の標準(個人で選んでいない人の見た目)と、選べる色テーマ(将来用・今は全部)。 */
function CompanyDefaults({ prefs, onSaved }: { prefs: PreferencesData; onSaved: (d: PreferencesData) => void }) {
  const pickOr = <T extends string>(options: readonly { value: T }[], v: string | undefined): T | "" =>
    options.some((o) => o.value === v) ? (v as T) : "";
  const [theme, setThemeValue] = useState<ThemePref | "">(pickOr(THEME_OPTIONS, prefs.company.theme));
  const [density, setDensity] = useState<DensityPref | "">(pickOr(DENSITY_OPTIONS, prefs.company.density));
  const [layout, setLayout] = useState<LayoutPref | "">(pickOr(LAYOUT_OPTIONS, prefs.company.layout));
  const [allowed, setAllowed] = useState<ThemePref[]>(prefs.allowedThemes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Status>(null);

  const companyTheme = theme || DEFAULT_APPEARANCE.theme;
  const invalid = allowed.length === 0 || !allowed.includes(companyTheme);

  const submit = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/appearance-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: theme || null, density: density || null, layout: layout || null, allowedThemes: allowed }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setMessage({ kind: "err", text: j?.error?.message ?? "保存できませんでした" });
        return;
      }
      const fresh = await loadPreferences(true);
      if (fresh) onSaved(fresh);
      setMessage({ kind: "ok", text: "会社の標準を保存しました" });
    } catch {
      setMessage({ kind: "err", text: "保存できませんでした(通信の失敗)" });
    } finally {
      setSaving(false);
    }
  };

  const defaultName = (options: readonly { value: string; label: string }[], v: string) => `既定(${labelOf(options, v)})`;

  return (
    <section id="company" className="scroll-mt-20 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-fg">会社の標準(管理者)</h2>
      <p className="mt-1 text-xs text-fg-3">
        自分で選んでいない人の見た目です。保存するとその人たちの画面が次に開いたときから変わります(自分で選んだ人はそのまま)。
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-fg-2">
          色テーマ
          <select className={selectClass} value={theme} onChange={(e) => setThemeValue(e.target.value as ThemePref | "")}>
            <option value="">{defaultName(THEME_OPTIONS, DEFAULT_APPEARANCE.theme)}</option>
            {THEME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-2">
          文字サイズ
          <select className={selectClass} value={density} onChange={(e) => setDensity(e.target.value as DensityPref | "")}>
            <option value="">{defaultName(DENSITY_OPTIONS, DEFAULT_APPEARANCE.density)}</option>
            {DENSITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-2">
          メニューの配置
          <select className={selectClass} value={layout} onChange={(e) => setLayout(e.target.value as LayoutPref | "")}>
            <option value="">{defaultName(LAYOUT_OPTIONS, DEFAULT_APPEARANCE.layout)}</option>
            {LAYOUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-fg-2">選べる色テーマ(外した色は、各自の画面の選択肢から消えます)</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {THEME_OPTIONS.map((o) => (
            <label key={o.value} className="inline-flex min-h-[32px] items-center gap-1.5 text-sm text-fg">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={allowed.includes(o.value)}
                onChange={(e) =>
                  setAllowed((cur) =>
                    THEME_OPTIONS.map((t) => t.value).filter((v) => (v === o.value ? e.target.checked : cur.includes(v))),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
        {invalid && (
          <p className="mt-1.5 text-xs text-err">
            {allowed.length === 0 ? "1つ以上選んでください。" : "会社の標準の色は、選べる色テーマに入れてください。"}
          </p>
        )}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void submit()} disabled={saving || invalid}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
          会社の標準を保存
        </Button>
        <span role="status" aria-live="polite" className={`text-xs ${message?.kind === "err" ? "text-err" : "text-ok"}`}>
          {message?.text}
        </span>
      </div>
    </section>
  );
}
