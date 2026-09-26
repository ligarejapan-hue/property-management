/**
 * まとめて反映の行(物件の住所入り)を外へ返す窓口は、**すべて**住所外しを通すこと。
 *
 * ⚠なぜ必要か(@codex 第10R P1): 取込の記録は「取込」の権限で見られるので、物件を見る
 *   権限が無い人にも住所が見えてしまう。詳細画面だけ直すと、エラーのCSV・行の操作の
 *   応答から同じ住所が出る(同種の穴は全箇所を洗う)。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf-8").replace(/\r\n/g, "\n");

/** 取込の記録の行(rawData)をそのまま返しうる窓口。 */
const ROW_EXITS = [
  "src/app/api/import/jobs/[jobId]/route.ts",
  "src/app/api/import/jobs/[jobId]/export-errors/route.ts",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/retry/route.ts",
];

describe("まとめて反映の行の住所外し", () => {
  for (const file of ROW_EXITS) {
    it(`${file} は住所外しを通す`, () => {
      const src = read(file);
      expect(src).toContain("redactRegistryOwnerApplyRow(");
      // 物件を見る権限で判定する
      expect(src).toMatch(/hasPermission\(perms, "property", "read"\)/);
    });
  }
});
