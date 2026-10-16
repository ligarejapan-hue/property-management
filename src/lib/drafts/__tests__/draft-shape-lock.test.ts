/**
 * 貼り付けて物件化・Excelからまとめて物件化の控えは、サーバーの応答の部分を一部の欄だけ確かめて戻す
 * (src/lib/drafts/screens/paste.ts・paste-excel.ts)。中身の型を変えたのに rev を上げ忘れると、
 * 古い形の控えが検査を通って画面に戻り、欄が欠けたまま描かれる。
 *
 * ここでは控えの中身になる型の定義(コメントと空白を除く)の指紋を固定する。落ちたら:
 *   1. 変えた型が控えの形に関わるなら、parsePasteDraft / parsePasteExcelDraft の rev を上げる
 *      (古い控えは捨てられ、最初からやり直しになるだけ)。
 *   2. 下の指紋を新しい値に書き換える。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");

function fingerprint(rel: string): string {
  const src = readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

const LOCKED: Array<{ file: string; rev: string; hash: string }> = [
  { file: "src/lib/paste-import/types.ts", rev: "paste rev 1 / excel rev 1", hash: "f04d6a93a40474f1" },
  { file: "src/lib/paste-import/review-types.ts", rev: "paste rev 1", hash: "8c209d8a4708f652" },
  { file: "src/lib/paste-import/excel-lead-types.ts", rev: "excel rev 1", hash: "6053181d1c374b44" },
];

describe("控えの中身になる型の指紋(変えたら控えの rev を上げる)", () => {
  for (const { file, rev, hash } of LOCKED) {
    it(`${file}(${rev})`, () => {
      expect(
        fingerprint(file),
        `${file} の型が変わりました。控えの形に関わるなら src/lib/drafts/screens/paste.ts・paste-excel.ts の rev を上げてから、この指紋を書き換えてください。`,
      ).toBe(hash);
    });
  }
});
