"use client";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  THEME_OPTIONS,
  DENSITY_OPTIONS,
  fromNextTheme,
  toNextTheme,
  type AppearancePatch,
  type DensityPref,
  type ThemePref,
} from "@/lib/appearance/options";
import { STORAGE_KEYS } from "@/lib/appearance/boot-script";

// 見た目の設定 段階2(2026-10-31): ヘッダー(色だけ)とスマホのメニュー(色+文字サイズ)ですぐ切り替える。
// 押した瞬間に画面へ反映し、保存は裏で(正は DB・失敗しても画面はそのまま=次に開いたとき DB の値に戻る)。
// 選べる中身は src/lib/appearance/options.ts の1か所。詳しい設定画面は段階4。

export async function saveAppearance(patch: AppearancePatch): Promise<boolean> {
  try {
    const res = await fetch("/api/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function applyDensity(value: DensityPref) {
  document.documentElement.setAttribute("data-density", value);
  try {
    window.localStorage.setItem(STORAGE_KEYS.density, value);
  } catch {
    // 端末に覚えられなくても、画面には反映済み・DB には保存する
  }
}

const isDensity = (v: string | null): v is DensityPref => DENSITY_OPTIONS.some((o) => o.value === v);

const selectClass =
  "min-h-[40px] rounded-md border border-line bg-surface px-2 text-sm text-fg-2 focus-visible:outline-2 focus-visible:outline-accent";

export function ThemeToggle({ withDensity = false }: { withDensity?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [density, setDensity] = useState<DensityPref>("normal");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mount guard to avoid hydration mismatch (standard next-themes pattern)
    setMounted(true);
    const d = document.documentElement.getAttribute("data-density");
    if (isDensity(d)) setDensity(d);
  }, []);
  const current: ThemePref = mounted ? fromNextTheme(theme) : "auto";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-fg-3">
        <span className={withDensity ? "" : "sr-only"}>色</span>
        <select
          aria-label="色テーマ"
          value={current}
          onChange={(e) => {
            const v = e.target.value as ThemePref;
            setTheme(toNextTheme(v));
            void saveAppearance({ theme: v });
          }}
          className={selectClass}
        >
          {THEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {withDensity && (
        <label className="flex items-center gap-1 text-xs text-fg-3">
          <span>文字</span>
          <select
            aria-label="文字サイズ"
            value={density}
            onChange={(e) => {
              const v = e.target.value as DensityPref;
              setDensity(v);
              applyDensity(v);
              void saveAppearance({ density: v });
            }}
            className={selectClass}
          >
            {DENSITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
