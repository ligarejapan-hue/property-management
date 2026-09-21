/**
 * 「所有者事項」PDF の所有者の表を読む。
 *
 * 登記情報提供サービスが出す所有者事項は、罫線で囲まれた表になっている:
 *
 *   ┏━━━━━━━━━━━━━━━┓
 *   ┃ 所 有 者 ┃                     ← 表題(1セル)
 *   ┠──────┬────────┨
 *   ┃ 住 所 │ 氏 名 ┃                 ← 見出し
 *   ┠──────┼────────┨
 *   ┃東京都…12番3号 │山田太郎 ┃       ← 中身
 *   ┗━━━━━━┷━━━━━━━━┛
 *
 * 共有のときは「住所 │ 持分 │ 氏名」の3列になり、住所や氏名が長いと次の行へ
 * 折り返す(折り返しの行は、その列以外が空)。
 *
 * ⚠ この関数は **罫線が残っている生のテキスト** を受け取る。
 *   `pdf-registry-parser.ts` の前処理は罫線をスペースへ潰すため、そのあとでは
 *   「見出しの "住 所 氏 名"」と「中身の "住所 氏名"」を見分けられない
 *   (実際に見出しを所有者の氏名として登録しかけた)。
 *
 * ⚠ 表の最後の行では、氏名の列に **サービス側の刷り込み**(検索用の番号・整理番号)が
 *   入り込む。実物300本の実測で21件あった。これを所有者にしてはいけない。
 */
import { joinSpacedKanji, toHalfWidthDigits } from "./registry-text-normalize";

export interface RegistryTableOwner {
  name: string;
  address: string | null;
  share: string | null;
}

/** セルの区切りに使われる縦罫線。表題・見出し・中身の行だけがこれを含む。 */
const VERTICAL_RULE = /[┃│｜|]/;

/** 見出しに使われる語(スペースを除いて比較する)。 */
const HEADER_ADDRESS = ["住所", "所有者の住所", "住所又は本店"];
const HEADER_NAME = ["氏名", "名称", "氏名又は名称", "所有者", "氏名・名称"];
const HEADER_SHARE = ["持分", "持分割合"];

function stripSpaces(s: string): string {
  return s.replace(/[\s　]/g, "");
}

/** 1行を罫線で区切ってセルの配列にする。両端の罫線は落とす。 */
function splitCells(line: string): string[] {
  return line
    .replace(/^[\s　]*[┃│｜|]/, "")
    .replace(/[┃│｜|][\s　]*$/, "")
    .split(VERTICAL_RULE)
    .map((cell) => cell.replace(/　/g, " ").replace(/ {2,}/g, " ").trim());
}

/**
 * 氏名の列に入り込む「サービス側の刷り込み」かどうか。
 *
 * 実物で確認できた形:
 *   - 整理番号などの数字だけの行           例) "14425"
 *   - 「…番号 0801-01-0」の形              例) "検索用資料番号 0801-01-0"
 *   - サービス名そのもの
 *
 * ⚠ 法人名には数字が入りうる(「第一ビル3号館」等)ので、「数字を含む=除外」には
 *   しない。上の3つの形だけを狙って外す。
 */
function isServiceImprint(cell: string): boolean {
  const compact = stripSpaces(cell);
  if (!compact) return false;
  if (/^[0-9０-９\-－―ー]+$/.test(compact)) return true;
  if (/番号[0-9０-９]{3,}[-－―]/.test(compact)) return true;
  if (compact.includes("登記情報提供サービス")) return true;
  return false;
}

interface HeaderLayout {
  address: number;
  name: number;
  share: number | null;
  cellCount: number;
}

/** 見出しの行かどうかを判定し、列の並びを返す。 */
function readHeader(cells: string[]): HeaderLayout | null {
  if (cells.length < 2) return null;
  const normalized = cells.map(stripSpaces);
  const address = normalized.findIndex((c) => HEADER_ADDRESS.includes(c));
  const name = normalized.findIndex((c) => HEADER_NAME.includes(c));
  if (address < 0 || name < 0 || address === name) return null;
  const share = normalized.findIndex((c) => HEADER_SHARE.includes(c));
  return {
    address,
    name,
    share: share >= 0 ? share : null,
    cellCount: cells.length,
  };
}

function cleanValue(raw: string): string {
  return joinSpacedKanji(raw.trim());
}

/**
 * 所有者の表を読む。
 *
 * @returns 表が見つからなければ `null`(従来の行ベースの読み取りに任せる)。
 *          表はあるが中身が無ければ空配列。
 */
export function parseRegistryOwnerTable(
  rawText: string,
): RegistryTableOwner[] | null {
  const lines = rawText.split(/\r?\n/);
  if (!lines.some((line) => VERTICAL_RULE.test(line))) return null;

  // ⚠`let layout = null` のままだと、TSが flushGroup 内の代入を追えず
  //   ループ側で never に狭まる。明示的に型を書く。
  let layout: HeaderLayout | null = null as HeaderLayout | null;
  const owners: RegistryTableOwner[] = [];

  /** いま読んでいる「1行のまとまり」に属するセルの行。 */
  let group: string[][] = [];

  /** まとまりを1人ぶんとして取り込む。 */
  const flushGroup = () => {
    if (group.length === 0) return;
    const rows = group;
    group = [];

    // 見出しの行(2ページ目以降にも出る)は中身ではない
    if (!layout) {
      layout = readHeader(rows[0]);
      return;
    }
    if (readHeader(rows[0])) return;

    /**
     * 列ごとに断片をつなぐ。
     *
     * @param dropImprints サービスの刷り込み(整理番号など)を除くか。
     *   ⚠**氏名の列だけ**に使う。住所に当てると「101」のような
     *   数字だけの続き(部屋番号)まで消えて、住所が切れる。
     *   実物では刷り込みは氏名の列にだけ現れる。
     */
    const column = (index: number, dropImprints: boolean): string => {
      const parts: string[] = [];
      for (const cells of rows) {
        const cell = (cells[index] ?? "").trim();
        if (!cell) continue;
        if (dropImprints && isServiceImprint(cell)) continue;
        parts.push(cell);
      }
      return cleanValue(parts.join(""));
    };

    const name = column(layout.name, true);
    if (!name) return; // 氏名が無ければ所有者として扱わない
    const address = column(layout.address, false);
    const share =
      layout.share === null
        ? ""
        : toHalfWidthDigits(stripSpaces(column(layout.share, false)));

    owners.push({
      name,
      address: address || null,
      share: share || null,
    });
  };

  for (const line of lines) {
    if (VERTICAL_RULE.test(line)) {
      const cells = splitCells(line);
      // 表題など、列が足りない行はまとまりに入れない
      if (layout && cells.length < layout.cellCount) continue;
      group.push(cells);
      continue;
    }
    // 罫線(区切り・上枠・下枠)や空行は、まとまりの終わり
    flushGroup();
  }
  flushGroup();

  if (!layout) return null; // 罫線はあったが所有者の表ではなかった
  return owners;
}
