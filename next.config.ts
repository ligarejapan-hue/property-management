import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse and playwright are Node.js-only libraries and must not be bundled by webpack.
  // playwright は謄本自動取得（registry auto-fetch）で動的 import するため external 固定する
  // （C-1: サーバーバンドルへ混入させない）。
  serverExternalPackages: ["pdf-parse", "playwright"],

  // フレームワーク名の露出を避ける（`X-Powered-By: Next.js` を出さない）。
  poweredByHeader: false,

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
    ];
  },
};

export default nextConfig;
