import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse and playwright are Node.js-only libraries and must not be bundled by webpack.
  // playwright は謄本自動取得（registry auto-fetch）で動的 import するため external 固定する
  // （C-1: サーバーバンドルへ混入させない）。
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "playwright"],

  // フレームワーク名の露出を避ける（`X-Powered-By: Next.js` を出さない）。
  poweredByHeader: false,

  // ⚠experimental.proxyClientMaxBodySize(既定 10MB)は**上げない**。大きいPDFを受け取る口は
  //   proxy の対象から外してある(src/proxy.ts の matcher・@codex PR#498 P1)。

  // 全レスポンス共通の防御ヘッダ。
  // ⚠あえて入れないもの:
  //   - Permissions-Policy: 現地調査がカメラ(getUserMedia)とGPS(geolocation)を使うため、
  //     雑に絞ると撮影・現在地が壊れる。入れるなら self を明示許可する形で別途慎重に。
  //   - Content-Security-Policy: Google Maps + Next の inline と相性が難しく、雑な CSP は
  //     地図やスタイルを割る。Report-Only で影響を測ってから別タスクで入れる。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // クリックジャッキング防止（同一オリジンの iframe は許容）。
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Content-Type の推測を禁止。
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 参照元の送出を絞る（Next.js 既定と同じ穏当な方針）。
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HTTPS 応答（Tailscale 経路）でのみブラウザが採用する。tailnet ホスト名なので
          // includeSubDomains / preload は付けない（他ホストや将来のサブドメインに波及させない）。
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
      // 公開ページ(QR・配信停止・広告用ページ・その写真)。route が付ける strict-origin(src/lib/sale-dm-letter/unsubscribe-page.ts の理由)を
      // 全体の指定で上書きしないよう、ここでも同じ値にする。⚠ここの値は route の応答ヘッダより強い(後ろの指定が勝つ)。
      ...["/t/:path*", "/u/:path*", "/lp/:path*", "/lp-assets/:path*"].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "strict-origin" }],
      })),
      // お客様の書類提出。URL のトークンを外へ漏らさない。⚠ここの値は route の応答ヘッダより強いので、route だけでは足りない(後ろの指定が勝つ)。
      {
        source: "/submit/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
