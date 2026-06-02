// デプロイ build 手順（Option C: devDependencies 込み build → prune）の配線固定テスト。
//
// 背景:
// - next build は TypeScript 型チェックを行い、typescript / @types/* や
//   ルートの vitest.config.ts ("import vitest/config") の解決に devDependencies を必要とする。
//   このため "npm ci --omit=dev" のままだと build が失敗する。
// - 恒久対応 (Option C): build 手順を「full npm ci → build → npm prune --omit=dev」へ統一する。
//   build 時は devDependencies を含めて入れる（vitest 等が解決できる）ので、
//   test / vitest 設定を tsconfig から除外する必要は無い。
// - Codex P2 対応: tsconfig の exclude から test sources を除外しない。
//   test/__tests__ を exclude すると tsc --noEmit の型チェックからテストソースが外れ、
//   vitest run はデフォルト型チェックしないため route/import/storage 系の型崩れを検出できなくなる。
//   よって exclude は "node_modules" のみに保ち、test sources も tsc --noEmit で型チェックし続ける。
//   package.json / package-lock.json は変更しない（型ツールチェーンは devDependencies のまま）。
//
// 本テストは vitest run（source 文字列検証）で上記の配線が崩れていないことを固定する。
//
// NOTE: 本ファイルのコメントは "//" 行コメントを用いる。glob ("**/" を含む) を JSDoc の
// ブロックコメント内に書くと "*/" がコメントを途中終了させるため。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const tsconfig = JSON.parse(readRepoFile("tsconfig.json")) as {
  include?: string[];
  exclude?: string[];
};
const packageJson = JSON.parse(readRepoFile("package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const deploySrc = readRepoFile("docs/deploy.md");

describe("deploy build: devDeps 込み build + prune (Option C) の配線固定", () => {
  describe("tsconfig.json: test sources を型チェック対象に残す (Codex P2)", () => {
    it("exclude は node_modules を含み、test sources を除外しない", () => {
      expect(tsconfig.exclude).toContain("node_modules");
      // Codex P2: test/__tests__ を exclude すると tsc --noEmit の型チェックから外れ、
      // route/import/storage 系テストの型崩れを検出できなくなるため除外しない。
      expect(tsconfig.exclude).not.toContain("**/__tests__/**");
      expect(tsconfig.exclude).not.toContain("**/*.test.ts");
    });

    it("アプリ本体・test sources (.ts / .tsx) の型チェックを維持する", () => {
      expect(tsconfig.include).toContain("**/*.ts");
      expect(tsconfig.include).toContain("**/*.tsx");
      // src 本体や全 .ts/.tsx を除外していない（型チェック品質を落とさない）
      expect(tsconfig.exclude).not.toContain("src/**");
      expect(tsconfig.exclude).not.toContain("**/*.ts");
      expect(tsconfig.exclude).not.toContain("**/*.tsx");
    });
  });

  describe("package.json: Option C は依存を移動しない", () => {
    it("型ツールチェーンは devDependencies のまま（dependencies へ移さない）", () => {
      for (const pkg of [
        "typescript",
        "@types/node",
        "@types/react",
        "@types/react-dom",
      ]) {
        expect(packageJson.devDependencies?.[pkg]).toBeDefined();
        expect(packageJson.dependencies?.[pkg]).toBeUndefined();
      }
    });
  });

  describe("docs/deploy.md: full npm ci → build → prune の手順", () => {
    it("build 用に full npm ci（--omit=dev なし）の行を持つ", () => {
      const hasFullCi = deploySrc
        .split("\n")
        .some((l) => /\bnpm ci\b/.test(l) && !l.includes("--omit=dev"));
      expect(hasFullCi).toBe(true);
    });

    it("build 後に npm prune --omit=dev を行う", () => {
      expect(deploySrc).toContain("npm prune --omit=dev");
    });

    it("prune は build の後に記載されている", () => {
      const buildIdx = deploySrc.indexOf("npm run build");
      const pruneIdx = deploySrc.indexOf("npm prune --omit=dev");
      expect(buildIdx).toBeGreaterThan(-1);
      expect(pruneIdx).toBeGreaterThan(buildIdx);
    });

    it("失敗原因（vitest.config.ts / devDependencies）を明記している", () => {
      expect(deploySrc).toContain("vitest.config.ts");
      expect(deploySrc).toContain("devDependencies");
    });
  });
});
