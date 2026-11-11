/**
 * 名前の異体字(旧字・俗字)と、そろえる先の字(2026-11-11 発注者決定「異体字で表示・普通の字で検索」)。
 *
 * - 表示・保存の名前は変えない(謄本の字のまま出す)。
 * - 名前を比べるとき(謄本の名義の確認・取引の照合・売主の自動入力・DM の業者の名前)は、この表で
 *   普通の字にそろえてから比べる。そろえて初めて同じなら「表記の違い」(同じ人として扱う)。
 * - 名前を検索するときは、打った字の異体字も候補に入れる(「山崎」で「山﨑」も出る)。
 *
 * ⚠字を足すときはこの表に足す(左=異体字・右=そろえる先)。
 * ⚠左右とも**1文字(1つの符号位置)**にする。DM の業者の名前の照合は SQL の translate で1字ずつ置き換える。
 * ⚠左の字は NFKC で変わらない字だけ(比べる前に NFKC をかけるため。変わる字は NFKC が先にそろえる)。
 * ⚠そろえる先(右)を左に書かない(連鎖させない)。
 */
export const NAME_VARIANTS: Readonly<Record<string, string>> = {
  "髙": "高",
  "﨑": "崎", "嵜": "崎", "碕": "崎",
  "齋": "斎",
  "齊": "斉",
  "邊": "辺", "邉": "辺",
  "𠮷": "吉",
  "廣": "広",
  "靜": "静",
  "禮": "礼",
  "惠": "恵",
  "强": "強",
  "眞": "真",
  "產": "産",
  "鄉": "郷",
  "曾": "曽",
  "帶": "帯",
  "總": "総",
  "聰": "聡",
  "莊": "荘",
  "澤": "沢",
  "濱": "浜",
  "嶋": "島", "嶌": "島",
  "櫻": "桜",
  "國": "国",
  "德": "徳",
  "黑": "黒",
  "冨": "富",
  "榮": "栄",
  "舘": "館",
};

/** そろえる先の字 → その字と異体字(そろえる先が先頭)。 */
const VARIANT_GROUPS: ReadonlyMap<string, readonly string[]> = (() => {
  const groups = new Map<string, string[]>();
  for (const [variant, base] of Object.entries(NAME_VARIANTS)) {
    const g = groups.get(base) ?? [base];
    g.push(variant);
    groups.set(base, g);
  }
  return groups;
})();

/** 1字の異体字をそろえる(表に無ければそのまま)。 */
export function foldVariantChar(c: string): string {
  return NAME_VARIANTS[c] ?? c;
}

/** その字と同じ扱いの字の一覧(打った字を先頭に・表に無ければその字だけ)。 */
export function variantSpellings(c: string): string[] {
  const group = VARIANT_GROUPS.get(foldVariantChar(c));
  if (!group) return [c];
  return [...new Set([c, ...group])];
}

/** 候補が増えすぎないよう、異体字のある字は先頭から3つまで広げる。 */
const MAX_VARIANT_POSITIONS = 3;

/**
 * 名前の検索語の書き方の候補(元の語を含む・重複なし)。異体字のある字を、同じ組のほかの字に変えた形。
 * 「山崎」→ 山崎・山﨑・山嵜・山碕。
 */
export function nameVariantSpellings(q: string): string[] {
  const chars = Array.from(q);
  let out = [q];
  let positions = 0;
  for (let i = 0; i < chars.length && positions < MAX_VARIANT_POSITIONS; i++) {
    const options = variantSpellings(chars[i]);
    if (options.length === 1) continue;
    positions++;
    out = out.flatMap((s) => {
      const cs = Array.from(s);
      return options.map((o) => {
        cs[i] = o;
        return cs.join("");
      });
    });
  }
  return [...new Set(out)];
}
