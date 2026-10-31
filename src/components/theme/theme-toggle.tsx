"use client";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  THEME_OPTIONS,
  DENSITY_OPTIONS,
  LAYOUT_OPTIONS,
  fromNextTheme,
  toNextTheme,
  type DensityPref,
  type LayoutPref,
  type ThemePref,
} from "@/lib/appearance/options";
import {
  applyDensity,
  applyLayout,
  readDensity,
  readLayout,
  saveAppearance,
  subscribeAppearance,
} from "@/lib/appearance/client";

// 見た目の設定 段階2(2026-10-31): ヘッダーとスマホのメニューで「色」「文字」をすぐ切り替える。
// 押した瞬間に画面へ反映し、保存は裏で(正は DB・失敗しても画面はそのまま=次に開いたとき DB の値に戻る)。
// 選べる中身は src/lib/appearance/options.ts の1か所。詳しい設定画面は段階4。
// 文字サイズは html の data-density が1か所の値(ヘッダーとメニューの両方がここを見る=片方で変えたらもう片方も変わる)。

const selectClass =
  "min-h-[40px] rounded-md border border-line bg-surface px-2 text-sm text-fg-2 focus-visible:outline-2 focus-visible:outline-accent";

export function ThemeToggle({
  withDensity = false,
  withLayout = false,
}: {
  withDensity?: boolean;
  /** 段階3: 「配置」(左サイドバー/上部ナビ)も出す。ヘッダーだけ(スマホのメニューには出さない=狭い幅ではどちらも同じ)。 */
  withLayout?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mount guard to avoid hydration mismatch (standard next-themes pattern)
    setMounted(true);
  }, []);
  const density = useSyncExternalStore<DensityPref>(subscribeAppearance, readDensity, () => "normal");
  const layout = useSyncExternalStore<LayoutPref>(subscribeAppearance, readLayout, () => "side");
  const current: ThemePref = mounted ? fromNextTheme(theme) : "auto";

  // ヘッダー(withLayout)では選択欄が3つ並ぶので、見出しの小さな文字は広い画面(xl)だけに出す
  // (1024px 前後でヘッダーの題名が潰れないように。選択欄には aria-label があるので読み上げは変わらない)。
  const labelClass = withLayout ? "hidden xl:inline" : "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-fg-3">
        <span className={withDensity ? labelClass : "sr-only"}>色</span>
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
      {withLayout && (
        // 見た目の設定 段階3: メニューの位置。広い画面だけで意味がある(狭い幅はどちらでも左上の ≡)。
        // ヘッダーに収まるのは xl(1280px)以上だけ(1024px・左サイドバー・大きめでログアウトが画面の外へ出た)。
        // ただし上部ナビを選んでいる人には lg(1024px)以上で出す(globals.css の data-layout-select)。左サイドバーが無いぶん
        // ヘッダーが広く、出さないと 1024〜1279px で左サイドバーへ戻す手段が無くなる(自己レビュー指摘)。
        <label data-layout-select className="hidden items-center gap-1 text-xs text-fg-3 xl:flex">
          <span className={labelClass}>配置</span>
          <select
            aria-label="メニューの配置"
            value={layout}
            onChange={(e) => {
              const v = e.target.value as LayoutPref;
              applyLayout(v);
              void saveAppearance({ layout: v });
            }}
            className={selectClass}
          >
            {LAYOUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {withDensity && (
        <label className="flex items-center gap-1 text-xs text-fg-3">
          <span className={labelClass}>文字</span>
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
