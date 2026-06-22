import { defineConfig } from "vitest/config";
import path from "path";

// scripts/*.mjs を test から import する経路 (例:
// src/lib/storage/__tests__/migrate-local-to-s3-env.test.ts) で、
// shebang (#!) を vitest の parser が拒否する問題を回避する。
// Node の直接実行 (`node scripts/...mjs`) には shebang が必要なので、
// script 本体は触らず、vitest 取り込み時のみ 1 行目を strip する。
const stripShebangFromMjs = {
  name: "strip-shebang-from-mjs",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.endsWith(".mjs")) return null;
    if (!code.startsWith("#!")) return null;
    const nl = code.indexOf("\n");
    const stripped = nl >= 0 ? code.slice(nl + 1) : "";
    return { code: stripped, map: null };
  },
};

export default defineConfig({
  plugins: [stripShebangFromMjs],
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts?(x)"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
