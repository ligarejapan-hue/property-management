// デプロイ build 手順（Option C: devDependencies 込み build → prune）の配線固定テスト。
//
// 背景:
// - `next build` は tsconfig の include ("**/*.ts" 等) でルートの vitest.config.ts や
//   src 配下 __tests__ の *.test.ts まで型チェックする。これらは devDependency (vitest 等) を
//   import するため、`npm ci --omit=dev` のままだと build が
//   `Cannot find module 'vitest/config'` で失敗する。さらに typescript / @types/* も
//   devDependencies のため、test を除外しても本番ソースの型チェックに必要。
// - 恒久対応 (Option C): (1) tsconfig.json の exclude で test / vitest 設定を build 型チェックから外し、
//   (2) deploy 手順を「full `npm ci` → build → `npm prune --omit=dev`」へ寄せた。
//   package.json / package-lock.json は変更しない（型ツールチェーンは devDependencies のまま）。
//
// 本テストは vitest run（source 文字列検証）で上記の配線が崩れていないことを固定する。
// 本ファイル自身は __tests__ 配下のため tsconfig exclude 対象（build 型チェック外）だが、
// vitest の test.include で実行される。
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
  describe("tsconfig.json: test / vitest 設定を Next build 型チェックから除外", () => {
    it("exclude に node_modules と test / vitest.config.ts を含む", () => {
      expect(tsconfig.exclude).toContain("node_modules");
      expect(tsconfig.exclude).toContain("**/__tests__/**");
      expect(tsconfig.exclude).toContain("**/*.test.ts");
      expect(tsconfig.exclude).toContain("vitest.config.ts");
    });

    it("アプリ本体 (.ts / .tsx) の型チェックは維持する", () => {
      expect(tsconfig.include).toContain("**/*.ts");
      expect(tsconfig.include).toContain("**/*.tsx");
      // 全 .ts/.tsx や src 本体を除外していない（型チェック品質を落とさない）
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
    it("build 用に full `npm ci`（--omit=dev なし）の行を持つ", () => {
      const hasFullCi = deploySrc
        .split("\n")
        .some((l) => /\bnpm ci\b/.test(l) && !l.includes("--omit=dev"));
      expect(hasFullCi).toBe(true);
    });

    it("build 後に `npm prune --omit=dev` を行う", () => {
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
