/**
 * 何行かに分かれて書かれた項目を1つにつなぐ。純関数。
 *
 * 実サンプル(HOME4U 査定依頼の表の形 2026-10-26):
 *   物件の住所 = 物件都道府県 / 物件市区町村 / 物件町字 / 物件丁目番地号
 *   氏名 = 姓 / 名、フリガナ = カナ姓 / カナ名
 *   申込者の住所 = 査定依頼者郵便番号 / 査定依頼者住所 / 査定依頼者建物名号室
 * ⚠つないだ元の行は取り除く(備考や「備考に入れない項目」に二重に出さない)。
 * ⚠つなぐのは**先頭の見出し**(都道府県か市区町村・姓・申込者の住所の部品)があるときだけ。
 *   「名」だけの行を氏名にしない(他の書式の「名」が何を指すか分からないため)。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { isBlankValue, type LabeledLine } from "./parse-labeled-lines";
import type { DraftFieldKey } from "./label-dictionary";
import { toHalfWidth } from "./normalize";

export interface MergedLines {
  labeled: LabeledLine[];
  /** つないで作った行の欄(辞書を引かずにこの欄へ入れる)。 */
  keys: Map<LabeledLine, DraftFieldKey>;
}

const ADDRESS_PARTS = ["物件都道府県", "物件市区町村", "物件町字", "物件丁目番地号"] as const;
const ADDRESS_HEADS = ["物件都道府県", "物件市区町村"];
const APPLICANT_ADDRESS_PARTS = ["査定依頼者郵便番号", "査定依頼者住所", "査定依頼者建物名号室"] as const;
const APPLICANT_ADDRESS_HEADS = ["査定依頼者住所", "査定依頼者建物名号室"];
const ROOM_LABEL = "物件号室";
const HYPHENS = /[-‐−－ー―]/;

interface Group {
  parts: readonly string[];
  heads: readonly string[];
  key: DraftFieldKey;
  join: (values: string[], byLabel: Map<string, string>) => string;
}

/**
 * 丁目番地号の末尾が号室の欄と同じ番号なら外す(`1-2-3-405` と号室 `405` → `1-2-3`)。
 * ⚠4つ以上に区切られているときだけ。`1-2-405` は番地の一部かもしれないので外さない。推測しない。
 */
export function stripRoomFromBlockNumber(block: string, room: string | undefined): string {
  if (!room) return block;
  const half = toHalfWidth(block).trim();
  const parts = half.split(HYPHENS);
  if (parts.length < 4) return block;
  const roomHalf = toHalfWidth(room).trim().replace(/号室?$/, "");
  if (parts[parts.length - 1] !== roomHalf) return block;
  // toHalfWidth は1文字を1文字に置き換えるので、長さで元の表記を切り戻せる。
  return block.trim().slice(0, half.length - roomHalf.length - 1);
}

const GROUPS: Group[] = [
  {
    parts: ADDRESS_PARTS,
    heads: ADDRESS_HEADS,
    key: "address",
    join: (_values, byLabel) =>
      ADDRESS_PARTS.map((l) => {
        const v = byLabel.get(l);
        if (v === undefined) return "";
        return l === "物件丁目番地号" ? stripRoomFromBlockNumber(v, byLabel.get(ROOM_LABEL)) : v;
      }).join(""),
  },
  { parts: ["姓", "名"], heads: ["姓"], key: "ownerName", join: (v) => v.join("　") },
  { parts: ["カナ姓", "カナ名"], heads: ["カナ姓"], key: "ownerNameKana", join: (v) => v.join("　") },
  { parts: APPLICANT_ADDRESS_PARTS, heads: APPLICANT_ADDRESS_HEADS, key: "ownerAddress", join: (v) => v.join(" ") },
];

export function mergeSplitFields(labeled: readonly LabeledLine[]): MergedLines {
  const byLabel = new Map<string, string>();
  for (const l of labeled) {
    if (!byLabel.has(l.label) && !isBlankValue(l.value)) byLabel.set(l.label, l.value.trim());
  }
  let lines = [...labeled];
  const keys = new Map<LabeledLine, DraftFieldKey>();
  for (const g of GROUPS) {
    if (!g.heads.some((h) => byLabel.has(h))) continue;
    const present = g.parts.filter((p) => byLabel.has(p));
    const values = present.map((p) => byLabel.get(p)!);
    const first = lines.find((l) => (g.parts as readonly string[]).includes(l.label));
    const merged: LabeledLine = {
      label: present.join("・"),
      value: g.join(values, byLabel),
      lineNumber: first?.lineNumber ?? 0,
    };
    // 元の行はすべて取り除き、最初の行の位置につないだ行を置く。
    const at = first ? lines.indexOf(first) : lines.length;
    lines = [
      ...lines.slice(0, at).filter((l) => !(g.parts as readonly string[]).includes(l.label)),
      merged,
      ...lines.slice(at).filter((l) => !(g.parts as readonly string[]).includes(l.label)),
    ];
    keys.set(merged, g.key);
  }
  return { labeled: lines, keys };
}
