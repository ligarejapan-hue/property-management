import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse is a Node.js-only library and must not be bundled by webpack
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
