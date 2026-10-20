/**
 * 見本データ(seed・mock)は、やめた案件ステータスを使わない(@codex #538 R5 P2)。
 * やめた値は DB の enum に残してあるので、使っていても seed は黙って通り、見本の物件が
 * 「（旧）」付きで出て、12段階の絞り込み・まとめて変更で選べなくなる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CASE_STATUS_DEPRECATED_MAP } from "../property-types";

const FILES = ["prisma/seed.ts", "src/lib/mock-data.ts"];

describe.each(FILES)("%s", (file) => {
  const src = readFileSync(resolve(process.cwd(), file), "utf8");
  const used = [...src.matchAll(/caseStatus:\s*"(\w+)"/g)].map((m) => m[1]);

  it("案件ステータスを使っている(走査が空振りしていない)", () => {
    expect(used.length).toBeGreaterThan(0);
  });

  it("やめた値を使わない", () => {
    expect(used.filter((v) => Object.prototype.hasOwnProperty.call(CASE_STATUS_DEPRECATED_MAP, v))).toEqual([]);
  });
});
