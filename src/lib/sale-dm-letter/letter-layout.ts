/**
 * 売却DMの手紙の紙面(2026-10-17 発注者決定: 案A=緑・A4 1枚・社名の帯・困りごとの枠と絵を横並び・
 * 問い合わせ枠(電話+無料査定QR)・配信停止QRは小さく・会社のロゴは下の中央)。
 *
 * 文面は外部AIが書く平文で、印は【イラスト】しか無い。そのため紙面の枠は段落の「形」から決める(純関数):
 *   - 最初の段落 = キャッチ(大きく・色付き)
 *   - 1行目が見出し+2行目以降が全部「・」の段落 = 困りごとの枠(✓付き)
 *   - 「なお、」で始まる段落・「特例」と「確定申告」を含む段落 = ご参考の枠(小さく)
 *   - 「追伸」で始まる段落 = 追伸
 *   - 「このお手紙は、公開されている」で始まる段落 = 脚注(問い合わせ枠の下へ移す)
 *   - 【イラスト】の行(行全体が印) = 絵の位置。最初の1つだけ・2つ目以降は消す(letter-illustration と同じ決まり)
 * どの形にも当てはまらない平文は普通の段落として描く(落とさない)。
 */

export type LetterBlock =
  | { kind: "catch"; lines: string[] }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "concerns"; heading: string | null; items: string[] }
  | { kind: "note"; lines: string[] }
  | { kind: "ps"; lines: string[] }
  | { kind: "illustration" };

export interface LetterLayout {
  blocks: LetterBlock[];
  /** 「このお手紙は、公開されている…」の一文(無ければ null)。問い合わせ枠の下の脚注に出す */
  basis: string | null;
  /** 本文に【イラスト】の印があったか(無ければ描く側が置き場所を決める) */
  hasMarker: boolean;
}

/** 紙面の決まり文句(文面に依らない固定の文字)。変えるときはここだけ */
export const LETTER_FIXED_TEXT = {
  /** 社名の横の添え書き(地域名は入れない=都内全域に出す可能性があるため) */
  tagline: "相続・不動産のご相談窓口",
  badge: "査定・ご相談",
  badgeStrong: "無料",
  contactHead: "まずは、今の価値を知ることから。",
  contactSub: "査定・ご相談は無料です",
  aiLine: "最新のAI査定も取り入れ、根拠のある価格をお伝えします。",
  telLabel: "お電話でのお問い合わせ",
  telHint: "「お手紙を見た」とお伝えください",
  noteLabel: "ご参考",
  /** 差出人が未設定のとき(画面の見本)に出す仮の文字 */
  senderPlaceholder: "（差出人名）",
  contactPlaceholder: "（差出人の連絡先）",
  /** QR が未指定のとき(画面の見本)に、印刷と同じ大きさで置く仮の枠の文字(見本と印刷の収まりを揃える) */
  qrPlaceholderHint: "印刷時にこの宛先専用のQRが入ります",
  unsubscribeText: "今後このようなお手紙が不要な方は、左のQRコードからお申し出ください（配信停止）。",
} as const;

// \s は全角空白・ノーブレークスペース・BOM も含む(letter-illustration.ts と同じ)
const MARKER_LINE = /^\s*【イラスト】\s*$/;
const BULLET = /^[・•]\s*/;
const BASIS_HEAD = "このお手紙は、公開されている";

function classify(lines: string[], isFirst: boolean): LetterBlock {
  const text = lines.join("\n");
  const bullets = lines.map((l) => BULLET.test(l));
  if (bullets.every(Boolean)) {
    return { kind: "concerns", heading: null, items: lines.map((l) => l.replace(BULLET, "")) };
  }
  if (lines.length > 1 && !bullets[0] && bullets.slice(1).every(Boolean)) {
    return { kind: "concerns", heading: lines[0], items: lines.slice(1).map((l) => l.replace(BULLET, "")) };
  }
  if (isFirst) return { kind: "catch", lines };
  if (/^追伸/.test(text)) return { kind: "ps", lines };
  if (/^なお、/.test(text) || (text.includes("特例") && text.includes("確定申告"))) return { kind: "note", lines };
  return { kind: "paragraph", lines };
}

export function parseLetterBody(body: string): LetterLayout {
  const rawLines = body.split(/\r\n|\r|\n/);
  // 段落に切る。空白だけの行と【イラスト】の行が区切り。
  const paragraphs: Array<string[] | "illustration"> = [];
  let cur: string[] = [];
  let markerSeen = false;
  const flush = () => {
    if (cur.length) paragraphs.push(cur);
    cur = [];
  };
  for (const raw of rawLines) {
    if (MARKER_LINE.test(raw)) {
      flush();
      if (!markerSeen) paragraphs.push("illustration");
      markerSeen = true;
      continue;
    }
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();

  const blocks: LetterBlock[] = [];
  let basis: string | null = null;
  let first = true;
  for (const p of paragraphs) {
    if (p === "illustration") {
      blocks.push({ kind: "illustration" });
      continue;
    }
    // 脚注へ移すのは最初の1行だけ。同じ段落に続く行(空行なしで追伸が続く等)は普通の段落として残す。
    let lines = p;
    if (basis === null && p[0].startsWith(BASIS_HEAD)) {
      basis = p[0];
      lines = p.slice(1);
      if (lines.length === 0) continue;
    }
    blocks.push(classify(lines, first));
    first = false;
  }
  return { blocks, basis, hasMarker: markerSeen };
}
