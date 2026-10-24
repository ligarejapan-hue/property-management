/**
 * 区分建物の謄本から、**専有部分の床面積**(登記簿の専有面積=内法)を読む。純関数。
 * 2026-10-25 発注者「謄本から面積を自動で入れるようにしましょう」(区分の専有面積を2つにした続き)。
 *
 * 謄本の並び(登記事項全部証明書・区分建物):
 *   表題部(一棟の建物の表示) … ③床面積 = 「１階 ５００：００」など**建物全体**の階ごとの面積(読まない)
 *   表題部(専有部分の建物の表示) … ③床面積 = 「３階部分 ６３：５０」(これを読む)
 *   (附属建物の表示)・(敷地権の表示)・権利部 … 読まない
 *
 * ⚠**迷ったら読まない**(空のまま=人が入れる):
 *   - 同じ階が2つ以上の数字で出る(床面積の変更の履歴。古い値は下線=抹消で、文字だけでは見分けられない)
 *   - 専有部分の表示が見つからない(土地・一般の建物の謄本)
 *   メゾネット(4階部分と5階部分のように別の階)は**足し合わせる**(専有部分の床面積は各階の合計)。
 * ⚠「：」「・」「．」は小数点(謄本の書き方)。全角数字も読む。
 */

export interface UnitFloorAreaResult {
  /** 専有部分の床面積(㎡・小数2桁の文字。例 "63.50")。読めなければ null。 */
  value: string | null;
  /** 読まなかった理由(画面・ログ用の短い文。数字や住所は入れない)。読めたときは null。 */
  skippedReason: string | null;
}

function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

/** 罫線を空白にする(pdf-registry-parser の前処理と同じ文字)。 */
function stripRules(s: string): string {
  return s.replace(/[│┃╎｜─━═┄┅┌┐└┘┏┓┗┛╔╗╚╝┼╋┬┴├┤┠┨┯┷┳┻╠╣╦╩╬]/g, " ");
}

const SECTION_START = /専\s*有\s*部\s*分\s*の\s*建\s*物\s*の\s*表\s*示/;
const SECTION_END = /附\s*属\s*建\s*物\s*の\s*表\s*示|敷\s*地\s*権\s*の\s*表\s*示|権\s*利\s*部|甲\s*区/;
/** 「(地下)N階部分 X：YY」。小数点は ：・．. のどれか、または空白(列の区切りで割れたとき)。 */
const FLOOR_AREA = /(地\s*下\s*)?([0-9]{1,3})\s*階\s*部\s*分\s*([0-9]{1,5})\s*[:：・．.\s]\s*([0-9]{2})(?![0-9])/g;

export function parseUnitFloorArea(raw: string): UnitFloorAreaResult {
  const lines = stripRules(toHalfWidth(raw)).split("\n");
  const start = lines.findIndex((l) => SECTION_START.test(l));
  if (start === -1) return { value: null, skippedReason: "専有部分の表示がありません" };
  let end = lines.findIndex((l, i) => i > start && SECTION_END.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end).join("\n");

  const byFloor = new Map<string, Set<number>>();
  for (const m of section.matchAll(FLOOR_AREA)) {
    const floor = `${m[1] ? "B" : ""}${Number(m[2])}`;
    // 小数は100分の1㎡の整数で持つ(浮動小数の誤差で同じ値を別物と見ない)。
    const hundredths = Number(m[3]) * 100 + Number(m[4]);
    const set = byFloor.get(floor) ?? new Set<number>();
    set.add(hundredths);
    byFloor.set(floor, set);
  }
  if (byFloor.size === 0) return { value: null, skippedReason: "専有部分の床面積が読めません" };
  let total = 0;
  for (const values of byFloor.values()) {
    if (values.size > 1) {
      return { value: null, skippedReason: "床面積に変更の履歴があり、今の値を決められません" };
    }
    total += [...values][0];
  }
  return { value: `${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`, skippedReason: null };
}
