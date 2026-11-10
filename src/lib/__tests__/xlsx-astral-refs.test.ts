import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { fixAstralCharRefs, readXlsx } from "../xlsx-astral-refs";

/**
 * 1セルのワークブックを作り、そのセルの XML を `cellXml` に差し替えた xlsx を返す。
 * (実物の DM 用 Excel は、日本語を `&#134071;` のような数値文字参照で持っている。)
 */
type CellShape = "sst" | "inlineStr" | "str";

function xlsxWithCellText(cellXml: string, shape: CellShape | boolean, deflate = false): Uint8Array {
  const mode: CellShape = shape === true ? "sst" : shape === false ? "str" : shape;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PLACEHOLDER"]]), "S");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx", bookSST: mode === "sst" }) as ArrayBuffer;
  const cfb = XLSX.CFB.read(new Uint8Array(buf), { type: "array" });
  let replaced = 0;
  for (const entry of cfb.FileIndex) {
    if (!entry.content || !entry.name.endsWith(".xml")) continue;
    const text = new TextDecoder().decode(entry.content as Uint8Array);
    if (!text.includes("PLACEHOLDER")) continue;
    // inlineStr = 実物の DM 用 Excel の形(`<is><t>…</t></is>`)。SheetJS が書くのは t="str" なので差し替える。
    const next =
      mode === "inlineStr"
        ? text.replace('t="str"><v>PLACEHOLDER</v>', `t="inlineStr"><is><t>${cellXml}</t></is>`)
        : text.replace("PLACEHOLDER", cellXml);
    expect(next).not.toBe(text);
    entry.content = new TextEncoder().encode(next);
    replaced++;
  }
  expect(replaced).toBe(1);
  // deflate=true は実物の Excel と同じく中身を圧縮した zip にする。
  return new Uint8Array(
    XLSX.CFB.write(cfb, {
      type: "array",
      fileType: "zip",
      compression: deflate,
    } as Parameters<typeof XLSX.CFB.write>[1]) as ArrayBuffer,
  );
}

const cell = (data: Uint8Array): string => {
  const wb = readXlsx(data, { type: "array" });
  return String(wb.Sheets[wb.SheetNames[0]].A1.v);
};

describe("Excel の第2面の字(𠮷 など)を化けさせない", () => {
  it("前提: SheetJS は &#134071; を U+0BB7(ஷ)に切り詰める(この直しが要る理由)", () => {
    const data = xlsxWithCellText("&#134071;田", true);
    const wb = XLSX.read(data, { type: "array" });
    expect(wb.Sheets.S.A1.v).toBe("ஷ田");
  });

  it.each<[string, string, CellShape]>([
    ["共有文字列・10進", "&#134071;田", "sst"],
    ["共有文字列・16進", "&#x20BB7;田", "sst"],
    ["インライン文字列(DM 用 Excel の形)", "&#134071;田", "inlineStr"],
    ["数式の文字列(t=str)", "&#134071;田", "str"],
  ])("%s の 𠮷 を正しく読む", (_label, xml, shape) => {
    expect(cell(xlsxWithCellText(xml, shape))).toBe("𠮷田");
  });

  it("中身を圧縮した zip(実物の Excel の形)でも 𠮷 を正しく読む", () => {
    const data = xlsxWithCellText("&#134071;田", "inlineStr", true);
    // 圧縮されていること(stored なら生の参照の文字列が見える)
    expect(Buffer.from(data).includes("&#134071;")).toBe(false);
    expect(cell(data)).toBe("𠮷田");
  });

  it("𠮷 以外の第2面の字(𫟯・𩸽)も正しく読む", () => {
    expect(cell(xlsxWithCellText("&#178159;&#x29E3D;", true))).toBe("𫟯𩸽");
  });

  it("第1面の数値文字参照・生の 𠮷・特殊記号の参照はそのまま", () => {
    expect(cell(xlsxWithCellText("&#12354;&amp;&#38;𠮷", true))).toBe("あ&&𠮷");
  });

  it("直す参照が無いファイルは、同じ中身をそのまま返す(作り直さない)", () => {
    const data = xlsxWithCellText("山田", true);
    expect(fixAstralCharRefs(data)).toBe(data);
  });

  it("Unicode の範囲外の番号は触らない(壊れた参照を作らない)", () => {
    const data = xlsxWithCellText("&#1114112;", true);
    expect(fixAstralCharRefs(data)).toBe(data);
  });

  it("zip でない中身(壊れたファイル)はそのまま返し、読み取りの失敗は今までどおり", () => {
    const junk = new TextEncoder().encode("not a zip");
    expect(fixAstralCharRefs(junk)).toBe(junk);
  });

  it("Buffer で渡しても読める(サーバーの取込)", () => {
    const data = xlsxWithCellText("&#134071;田", true);
    const wb = readXlsx(Buffer.from(data), { type: "buffer" });
    expect(wb.Sheets.S.A1.v).toBe("𠮷田");
  });

  it("sheetRows などの読み方の指定はそのまま渡る", () => {
    const data = xlsxWithCellText("&#134071;田", true);
    const wb = readXlsx(Buffer.from(data), { type: "buffer", sheetRows: 1 });
    expect(wb.Sheets.S.A1.v).toBe("𠮷田");
  });
});

describe("守り: Excel は readXlsx を通して読む", () => {
  it("src の中で XLSX.read を直接呼ぶのは xlsx-astral-refs.ts だけ", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__tests__" || e.name === "generated" || e.name === "node_modules") continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith(path.join("lib", "xlsx-astral-refs.ts"))) {
          const src = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
          // XLSX.read(…) と、"xlsx" から read / readFile を名前で取り込む書き方(別名を含む)
          if (
            /\bXLSX\.read(File)?\s*\(/.test(src) ||
            /import\s*\{[^}]*\bread(File)?\b[^}]*\}\s*from\s*["']xlsx["']/.test(src)
          ) {
            offenders.push(path.relative(root, p));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
