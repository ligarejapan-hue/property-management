import type { ReactNode } from "react";
import { THEME_SWATCHES, DENSITY_ROOT_PX, DENSITY_SAMPLE_TEXT, type ThemeSwatch } from "@/lib/appearance/swatches";
import type { DensityPref, LayoutPref, ThemePref } from "@/lib/appearance/options";

// 見た目の設定 段階4(2026-10-31): 設定 > 表示 の選択肢に付ける見本(絵だけ・操作なし=サーバー描画でテストできる)。
// 色の見本は各テーマの色の値で描く(今のテーマの変数を使うと、どの見本も今の色になってしまう)。

function MiniScreen({ s }: { s: ThemeSwatch }) {
  return (
    <div className="flex h-full w-full" style={{ background: s.page }}>
      <div className="flex w-[28%] flex-col gap-1 p-1.5" style={{ background: s.side, borderRight: `1px solid ${s.line}` }}>
        <span className="h-1.5 w-3/4 rounded-sm" style={{ background: s.sideText, opacity: 0.7 }} />
        <span className="h-2.5 rounded-sm" style={{ background: s.sideActive }} />
        <span className="h-1.5 w-2/3 rounded-sm" style={{ background: s.sideText, opacity: 0.5 }} />
        <span className="h-1.5 w-1/2 rounded-sm" style={{ background: s.sideText, opacity: 0.5 }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-1.5">
        <span className="h-2 rounded-sm" style={{ background: s.surface, border: `1px solid ${s.line}` }} />
        <div className="flex flex-1 flex-col gap-1 rounded-sm p-1.5" style={{ background: s.surface, border: `1px solid ${s.line}` }}>
          <span className="h-1.5 w-4/5 rounded-sm" style={{ background: s.text }} />
          <span className="h-1.5 w-3/5 rounded-sm" style={{ background: s.muted }} />
          <span className="mt-auto h-2.5 w-1/3 self-end rounded-sm" style={{ background: s.accent }} />
        </div>
      </div>
    </div>
  );
}

/** 色テーマの見本(ミニ画面)。自動は スタンダード と ダーク を半分ずつ。 */
export function ThemePreview({ theme }: { theme: ThemePref }) {
  return (
    <div aria-hidden="true" className="relative h-[72px] w-full overflow-hidden rounded-md border border-line">
      {theme === "auto" ? (
        <div className="flex h-full">
          <div className="w-1/2 overflow-hidden">
            <div className="h-full w-[200%]">
              <MiniScreen s={THEME_SWATCHES.standard} />
            </div>
          </div>
          <div className="w-1/2 overflow-hidden">
            <div className="h-full w-[200%] -translate-x-1/2">
              <MiniScreen s={THEME_SWATCHES.dark} />
            </div>
          </div>
        </div>
      ) : (
        <MiniScreen s={THEME_SWATCHES[theme]} />
      )}
    </div>
  );
}

/**
 * 文字サイズの見本。実際の物件の文字で、その設定のときの大きさ(px)で描く
 * (rem で描くと今の設定の大きさになり、見比べられない)。一覧の本文=text-sm(0.875rem)・補足=text-xs(0.75rem)。
 */
export function DensityPreview({ density }: { density: DensityPref }) {
  const root = DENSITY_ROOT_PX[density];
  return (
    <div aria-hidden="true" className="flex min-h-[72px] flex-col justify-center gap-0.5 rounded-md border border-line bg-surface px-2 py-1.5">
      <span className="font-medium leading-snug text-fg" style={{ fontSize: `${root * 0.875}px` }}>
        {DENSITY_SAMPLE_TEXT}
      </span>
      <span className="leading-snug text-fg-3" style={{ fontSize: `${root * 0.75}px` }}>
        3LDK・72.5㎡・2,980万円
      </span>
    </div>
  );
}

function Bar({ className }: { className: string }): ReactNode {
  return <span className={`block rounded-sm ${className}`} />;
}

/** メニューの配置の見本(今のテーマの色で、形だけ)。 */
export function LayoutPreview({ layout }: { layout: LayoutPref }) {
  return (
    <div aria-hidden="true" className="flex h-[72px] w-full overflow-hidden rounded-md border border-line bg-page">
      {layout === "side" ? (
        <>
          <div className="flex w-[28%] flex-col gap-1 border-r border-line bg-side-bg p-1.5">
            <Bar className="h-1.5 w-3/4 bg-side-text/60" />
            <Bar className="h-2.5 bg-side-active-bg" />
            <Bar className="h-1.5 w-2/3 bg-side-text/40" />
            <Bar className="h-1.5 w-1/2 bg-side-text/40" />
          </div>
          <div className="flex-1 p-1.5">
            <div className="h-full rounded-sm border border-line bg-surface" />
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b border-line bg-side-bg px-1.5 py-1">
            <Bar className="h-1.5 w-6 bg-side-text/60" />
            <Bar className="h-2.5 w-7 bg-side-active-bg" />
            <Bar className="h-1.5 w-5 bg-side-text/40" />
            <Bar className="h-1.5 w-6 bg-side-text/40" />
          </div>
          <div className="flex-1 p-1.5">
            <div className="h-full rounded-sm border border-line bg-surface" />
          </div>
        </div>
      )}
    </div>
  );
}
