import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse and playwright are Node.js-only libraries and must not be bundled by webpack.
  // playwright は謄本自動取得（registry auto-fetch）で動的 import するため external 固定する
  // （C-1: サーバーバンドルへ混入させない）。
  serverExternalPackages: ["pdf-parse", "playwright"],
};

export default nextConfig;
