/**
 * Excel(xlsx)の第2面の字(𠮷 U+20BB7 など)を化けさせずに読む(2026-11-10)。
 *
 * ⚠SheetJS(0.20.3)は XML の数値文字参照を `String.fromCharCode` で戻すので、
 *   U+FFFF を超える番号は上の桁が落ちる。`&#134071;`(𠮷)→ U+0BB7「ஷ」になり、
 *   本番で所有者15人の氏名が化けた(9月の所有者の取込・DM 用の Excel は日本語を参照で持つ)。
 *
 * 読む前に、xlsx の中の XML にある「U+FFFF を超える番号の参照」を、**字そのもの**(UTF-8)に
 * 書き換える。生の字は SheetJS がどのセルの形(共有文字列・インライン・数式の文字列)でも正しく読む。
 * ⚠サロゲートの2つの参照(`&#55362;&#57271;`)にする手は、数式の文字列(t="str")の読み方で
 *   また化けるので使わない(実測)。第2面の字は XML の特殊文字ではないので、生で書いて安全。
 * 書き換える参照が無いファイルは、受け取った中身をそのまま使う(作り直さない)。
 *
 * ⚠展開後の大きさの守り(assertZipExpandsWithin)は、これより**前に**元の中身で行うこと。
 * ブラウザでも動く(Buffer に頼らない)。
 */
import * as XLSX from "xlsx";

const CHAR_REF = /&#(?:[xX]([0-9A-Fa-f]+)|([0-9]+));/g;

/** XML の文字列の中の、U+FFFF を超える数値文字参照を字そのものにする。無ければ null。 */
function expandAstralRefs(xml: string): string | null {
  let changed = false;
  const out = xml.replace(CHAR_REF, (whole, hex: string | undefined, dec: string | undefined) => {
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    if (!(cp > 0xffff && cp <= 0x10ffff)) return whole;
    changed = true;
    return String.fromCodePoint(cp);
  });
  return changed ? out : null;
}

/**
 * xlsx の中身を受け取り、第2面の字の参照を直した中身を返す。直すものが無い・zip として
 * 読めないときは、受け取ったものをそのまま返す(読み取りの失敗は XLSX.read に任せる)。
 */
export function fixAstralCharRefs<T extends Uint8Array>(data: T): T | Uint8Array {
  let cfb: ReturnType<typeof XLSX.CFB.read>;
  try {
    cfb = XLSX.CFB.read(data, { type: "array" });
  } catch {
    return data;
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let changed = false;
  for (const entry of cfb.FileIndex) {
    if (!entry.content || !/\.(xml|rels)$/i.test(entry.name)) continue;
    const bytes = entry.content as Uint8Array;
    const xml = decoder.decode(bytes);
    if (!xml.includes("&#")) continue;
    const fixed = expandAstralRefs(xml);
    if (fixed === null) continue;
    entry.content = encoder.encode(fixed);
    changed = true;
  }
  if (!changed) return data;
  return new Uint8Array(XLSX.CFB.write(cfb, { type: "array", fileType: "zip" }) as ArrayBuffer);
}

/**
 * XLSX.read の代わり。第2面の字を直してから読む。
 * `type` は "buffer"(Buffer)か "array"(Uint8Array)だけ。
 */
export function readXlsx(
  data: Uint8Array,
  opts: XLSX.ParsingOptions & { type: "buffer" | "array" },
): XLSX.WorkBook {
  const fixed = fixAstralCharRefs(data);
  if (fixed === data) return XLSX.read(data, opts);
  // 作り直した中身は Uint8Array。Buffer で受けた呼び出し元にも同じ形で渡す。
  return XLSX.read(fixed, { ...opts, type: "array" });
}
