/**
 * 日本語の見出しを「文節(意味のまとまり)の切れ目」で分ける純関数(公開LPの見出しの折り返し用・2026-10-21)。
 * ブラウザは日本語をどの字の間でも折り返すため、「ま/とめて」「建/てられた」のように言葉の途中で折れる。
 * ここで切れ目を決め、lp-page.ts が <wbr> を入れ、CSS(word-break:keep-all)で字の途中では折らないようにする。
 *
 * 切れ目の決まり(形態素解析は使わない・字種だけで判定):
 *  - 読点・句点・閉じ括弧・中黒などの後(次が空白や閉じ記号でなければ) / 空白の後 / 開き括弧の前
 *  - ひらがなの並びから漢字・カタカナ・英数へ移る所。ただし
 *      ・「ご」「お」+漢字は敬語の頭なので、その前で切って間では切らない(まとめて|ご相談)
 *      ・漢字+ひらがな1字+漢字で、その1字が助詞(の・を・に…)でなければ送り仮名=1語なので切らない(売り方・買い戻し)
 *  - 漢字⇔カタカナ⇔英数の間は切らない(築50年超・2件まとめて)
 */

const PARTICLES_1 = new Set(["の", "を", "に", "は", "が", "と", "で", "も", "へ", "や", "か", "な"]);
const HONORIFIC = new Set(["ご", "お"]);
const CLOSE_PUNCT = new Set(["、", "。", "，", "．", "！", "？", "!", "?", "」", "』", "）", ")", "〕", "】", "］", "]", "…", "・", "：", "；", ":", ";"]);
const OPEN_PUNCT = new Set(["「", "『", "（", "(", "〔", "【", "［", "["]);

type Kind = "h" | "c" | "close" | "open" | "space" | "other";

function kindOf(ch: string): Kind {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === " " || ch === "　" || ch === "\t") return "space";
  if (CLOSE_PUNCT.has(ch)) return "close";
  if (OPEN_PUNCT.has(ch)) return "open";
  if (cp >= 0x3041 && cp <= 0x309f) return "h"; // ひらがな
  if (cp >= 0x30a0 && cp <= 0x30ff) return "c"; // カタカナ(ー を含む)
  if (cp >= 0x31f0 && cp <= 0x31ff) return "c";
  if (cp >= 0xff66 && cp <= 0xff9f) return "c"; // 半角カナ
  if (cp >= 0x4e00 && cp <= 0x9fff) return "c"; // 漢字
  if (cp >= 0x3400 && cp <= 0x4dbf) return "c";
  if (ch === "々" || ch === "〆" || ch === "〜" || ch === "～") return "c";
  if (/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/.test(ch)) return "c";
  return "other";
}

/** 文節の切れ目で分けた配列(結合すると元の文字列に戻る)。 */
export function jaChunks(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const kinds = chars.map(kindOf);
  const out: string[] = [];
  let cur = chars[0];
  for (let i = 1; i < chars.length; i++) {
    const k = kinds[i];
    const prev = kinds[i - 1];
    let brk = false;
    if (k === "open") {
      brk = prev !== "open";
    } else if (k === "space" || k === "close") {
      brk = false;
    } else if (prev === "close" || prev === "space") {
      brk = true;
    } else if (k === "c" && prev === "h") {
      // ひらがなの並びの長さ(直前の連続ひらがな)
      let j = i - 1;
      while (j >= 0 && kinds[j] === "h") j--;
      const runLen = i - 1 - j;
      if (HONORIFIC.has(chars[i - 1])) {
        brk = false; // 「ご相談」「お住まい」の間では切らない(切れ目は ご/お の前=下で入れる)
      } else if (runLen === 1 && j >= 0 && kinds[j] === "c" && !PARTICLES_1.has(chars[i - 1])) {
        brk = false; // 送り仮名(売り方・買い戻し・持ち続ける)
      } else {
        brk = true;
      }
    } else if (k === "h" && HONORIFIC.has(chars[i]) && i + 1 < chars.length && kinds[i + 1] === "c" && prev !== "open") {
      brk = true; // まとめて|ご相談 / 重ねた|お住まい
    }
    if (brk) {
      out.push(cur);
      cur = chars[i];
    } else {
      cur += chars[i];
    }
  }
  out.push(cur);
  return out;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 文節の切れ目に <wbr> を入れた HTML(動的な値は escape 済み)。 */
export function jaWrapHtml(text: string): string {
  return jaChunks(text).map(esc).join("<wbr>");
}

/**
 * 見出し用: 読点「、」「，」を表示から抜き、あった場所は折り返しの余地(<wbr>)として残す
 * (発注者 2026-10-21「みだしに、はいらないのでは」)。句点・疑問符・括弧・中黒はそのまま。
 */
export function jaHeadingHtml(text: string): string {
  return jaChunks(text)
    .map((c) => c.replace(/[、，]/g, ""))
    .filter((c) => c.length > 0)
    .map(esc)
    .join("<wbr>");
}
