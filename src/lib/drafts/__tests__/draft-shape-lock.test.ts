/**
 * 貼り付けて物件化・Excelからまとめて物件化の控えは、サーバーの応答の部分を一部の欄だけ確かめて戻す
 * (src/lib/drafts/screens/paste.ts・paste-excel.ts)。中身の型を変えたのに rev を上げ忘れると、
 * 古い形の控えが検査を通って画面に戻り、欄が欠けたまま描かれる。
 *
 * ここでは控えの形を決める型の定義(コメントと空白を除く)の指紋を固定する。
 *   - 型だけのファイルはファイルごと
 *   - 処理と同じファイルにある型は、その宣言だけ(控えの interface 自身・BuildingChoice など)
 * 落ちたら:
 *   1. 変えた型が控えの形に関わるなら、parsePasteDraft / parsePasteExcelDraft の rev を上げる
 *      (古い控えは捨てられ、最初からやり直しになるだけ)。
 *   2. 下の指紋を新しい値に書き換える。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");

function normalize(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `export interface Name {…}` / `export type Name = …;` の宣言だけを切り出す(括弧の深さ0で終わる所まで)。 */
function declaration(src: string, name: string): string {
  const text = normalize(src);
  const m = new RegExp(`export (interface|type) ${name}\\b`).exec(text);
  if (!m) throw new Error(`宣言 ${name} が見つかりません`);
  const isInterface = m[1] === "interface";
  let depth = 0;
  for (let i = m.index; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if (c === "}" || c === ")" || c === "]" || (c === ">" && text[i - 1] !== "=")) {
      depth--;
      if (isInterface && c === "}" && depth === 0) return text.slice(m.index, i + 1);
    } else if (!isInterface && c === ";" && depth === 0) return text.slice(m.index, i + 1);
  }
  throw new Error(`宣言 ${name} の終わりが見つかりません`);
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LOCKED_FILES: Array<{ file: string; rev: string; hash: string }> = [
  { file: "src/lib/paste-import/types.ts", rev: "paste rev 1 / excel rev 1", hash: "f04d6a93a40474f1" },
  { file: "src/lib/paste-import/review-types.ts", rev: "paste rev 1", hash: "8c209d8a4708f652" },
  { file: "src/lib/paste-import/excel-lead-types.ts", rev: "excel rev 1", hash: "6053181d1c374b44" },
];

const LOCKED_DECLS: Array<{ file: string; name: string; rev: string; hash: string }> = [
  { file: "src/lib/drafts/screens/paste.ts", name: "PasteReviewDraft", rev: "paste rev 1", hash: "ac416542687afa24" },
  { file: "src/lib/drafts/screens/paste.ts", name: "PasteScreenDraft", rev: "paste rev 1", hash: "96c418309246cb1f" },
  { file: "src/lib/drafts/screens/paste-excel.ts", name: "PasteExcelDraft", rev: "excel rev 1", hash: "a370ecd5b537bce5" },
  { file: "src/lib/building-link/resolve.ts", name: "BuildingChoice", rev: "paste rev 1", hash: "2602bc115ea2dc6b" },
  { file: "src/lib/paste-import/lead-sheet.ts", name: "LeadRowStatus", rev: "excel rev 1", hash: "0f6e872f3df5c97d" },
  { file: "src/lib/paste-import/source-profiles.ts", name: "SourceProfileId", rev: "paste rev 1 / excel rev 1", hash: "7a8ef0d30c3369bd" },
];

const MESSAGE = "の型が変わりました。控えの形に関わるなら src/lib/drafts/screens/paste.ts・paste-excel.ts の rev を上げてから、この指紋を書き換えてください。";

describe("控えの中身になる型の指紋(変えたら控えの rev を上げる)", () => {
  for (const { file, rev, hash: expected } of LOCKED_FILES) {
    it(`${file}(${rev})`, () => {
      expect(hash(normalize(read(file))), `${file} ${MESSAGE}`).toBe(expected);
    });
  }
  for (const { file, name, rev, hash: expected } of LOCKED_DECLS) {
    it(`${file} の ${name}(${rev})`, () => {
      expect(hash(declaration(read(file), name)), `${file} の ${name} ${MESSAGE}`).toBe(expected);
    });
  }
});

describe("宣言の切り出し", () => {
  it("interface は閉じ括弧まで・type はセミコロンまで", () => {
    const src = "export interface A { x: { y: number }; z: string[] }\nexport type B = { k: \"a\" } | Record<string, number>;\nconst q = 1;";
    expect(declaration(src, "A")).toBe("export interface A { x: { y: number }; z: string[] }");
    expect(declaration(src, "B")).toBe('export type B = { k: "a" } | Record<string, number>;');
  });
  it("中身を変えると指紋が変わる", () => {
    const a = declaration("export interface A { x: number }", "A");
    const b = declaration("export interface A { x: number; y: string }", "A");
    expect(hash(a)).not.toBe(hash(b));
  });
});
