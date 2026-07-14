import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { Geist_Mono, Noto_Sans_JP, Schibsted_Grotesk } from "next/font/google";
import type { ComponentType } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";

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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${appSans.variable} ${appSansJp.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
        <DevThemeTuner />
      </body>
    </html>
  );
}
