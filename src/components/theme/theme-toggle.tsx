"use client";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  THEME_OPTIONS,
  DENSITY_OPTIONS,
  fromNextTheme,
  toNextTheme,
  type DensityPref,
  type ThemePref,
} from "@/lib/appearance/options";
import { applyDensity, readDensity, saveAppearance, subscribeAppearance } from "@/lib/appearance/client";

// 見た目の設定 段階2(2026-10-31): ヘッダーとスマホのメニューで「色」「文字」をすぐ切り替える。
// 押した瞬間に画面へ反映し、保存は裏で(正は DB・失敗しても画面はそのまま=次に開いたとき DB の値に戻る)。
// 選べる中身は src/lib/appearance/options.ts の1か所。詳しい設定画面は段階4。
// 文字サイズは html の data-density が1か所の値(ヘッダーとメニューの両方がここを見る=片方で変えたらもう片方も変わる)。

const selectClass =
  "min-h-[40px] rounded-md border border-line bg-surface px-2 text-sm text-fg-2 focus-visible:outline-2 focus-visible:outline-accent";

export function ThemeToggle({ withDensity = false }: { withDensity?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mount guard to avoid hydration mismatch (standard next-themes pattern)
    setMounted(true);
  }, []);
  const density = useSyncExternalStore<DensityPref>(subscribeAppearance, readDensity, () => "normal");
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
