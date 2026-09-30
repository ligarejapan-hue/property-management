import type { MetadataRoute } from "next";

/**
 * ホーム画面に追加できるようにする設定(通知 段階1・設計書 §4.5・D13)。
 * iPhone の通知はホーム画面に追加して開いた場合のみ使えるため、段階1で入れる。
 * ⚠`/manifest.webmanifest`・`/icons/`・`/sw.js` はログイン前にも読むため
 *   `src/proxy.ts` で認証を免除している(中身は静的・PII なし)。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "物件管理システム",
    short_name: "物件管理",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    lang: "ja",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
