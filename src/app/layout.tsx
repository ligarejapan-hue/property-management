import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { Geist_Mono, Noto_Sans_JP, Schibsted_Grotesk } from "next/font/google";
import type { ComponentType } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { NEXT_THEMES, NEXT_THEME_VALUES, toNextTheme } from "@/lib/appearance/options";
import { appearanceBootScript } from "@/lib/appearance/boot-script";
import { loadAppearanceForRequest } from "@/lib/appearance/server";

// dev限定 テーマ調整パネル。本番ビルドでは三項が定数畳み込みされて
// `() => null` になり、dynamic import ごと除去される（クライアントバンドル非同梱）。
const DevThemeTuner: ComponentType =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("@/components/dev/theme-tuner/ThemeTunerPanel"))
    : () => null;

// UIトーン統一 v2: 欧文・数字 = Schibsted Grotesk / 和文 = Noto Sans JP。
// 等幅(ID・コード表示)は従来どおり Geist Mono を維持。
const appSans = Schibsted_Grotesk({
  variable: "--font-app-sans",
  subsets: ["latin"],
});

const appSansJp = Noto_Sans_JP({
  variable: "--font-app-sans-jp",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // タブ名(UI総点検 B-6): 既定は「物件管理システム」。各ページが title を出す場合は「<ページ名> | 物件管理システム」。
  title: {
    default: "物件管理システム",
    template: "%s | 物件管理システム",
  },
  description: "不動産の物件・所有者・DM・現地調査を一元管理する社内システム",
  // 通知 段階1: iPhone でホーム画面に追加したときのアイコン(manifest は src/app/manifest.ts)。
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 見た目の設定(2026-10-31): ログイン中なら DB の設定を正として、画面を描く前に付ける(別の PC でも同じ見た目・ちらつかない)。
  const loaded = await loadAppearanceForRequest();
  const appearance = loaded?.appearance ?? null;
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${appSans.variable} ${appSansJp.variable} ${geistMono.variable} h-full antialiased`}
      data-density={appearance?.density}
      data-layout={appearance?.layout}
      data-appearance-user={loaded?.userId}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript(appearance) }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* 色テーマは今までのダークモードの仕組み(next-themes)に乗せる。html の class と data-theme に
            standard / blue / dark / washi / navy / forest / paper が付く(自動=パソコンの設定で standard か dark)。 */}
        <ThemeProvider
          attribute={["class", "data-theme"]}
          themes={[...NEXT_THEMES]}
          value={NEXT_THEME_VALUES}
          // ログイン中は DB の色を初期値に(端末に保存できない環境でも DB の色になる・@codex #618)。
          defaultTheme={appearance ? toNextTheme(appearance.theme) : "system"}
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <DevThemeTuner />
      </body>
    </html>
  );
}
