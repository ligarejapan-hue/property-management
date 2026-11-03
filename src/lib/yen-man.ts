/**
 * 物件の販売価格・うち消費税の円 ⇄ 万円(2026-11-03 発注者「万円表示にしない・1000円単位が出たら困る」)。
 * 保存は今までどおり万円(小数4桁=1円まで)。画面の入力と表示だけ円にする。
 * ⚠浮動小数で掛け割りしない(0.1万円 → 999.9999円 のような誤差を出さない)=文字で桁をずらす。
 */

const toHalf = (s: string) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/，/g, ",");

/** 「32,801,500」「32801500円」の数字部分(カンマは3桁区切りのときだけ)。 */
const PLAIN = /^(\d{1,3}(?:,\d{3})+|\d+)$/;

function plainInt(s: string): number | null {
  const t = s.trim();
  if (t === "") return 0;
  if (!PLAIN.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** 円の入力を整数の円へ。「3,280万1,500円」「3280万」も読む。読めなければ null。 */
export function parseYenText(s: string | null | undefined): number | null {
  if (typeof s !== "string") return null;
  const t = toHalf(s).replace(/\s/g, "").replace(/円$/, "");
  if (t === "") return null;
  const m = /^([^万]+)万(.*)$/.exec(t);
  if (m) {
    const man = plainInt(m[1]);
    const rest = plainInt(m[2]);
    if (man === null || rest === null || m[1] === "" || rest >= 10000) return null;
    const n = man * 10000 + rest;
    return Number.isSafeInteger(n) ? n : null;
  }
  return plainInt(t);
}

/** 円の整数を「3,280万円」「3,280万1,500円」「1,500円」に。億は使わない(今までの「12,000万円」と同じ)。 */
export function formatYenJa(yen: number): string {
  const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const man = Math.floor(yen / 10000);
  const rest = yen % 10000;
  if (man === 0) return `${group(rest)}円`;
  return rest === 0 ? `${group(man)}万円` : `${group(man)}万${group(rest)}円`;
}

/** 円の入力の文字を表示用に。読めない文字(「価格応談」など)はそのまま。 */
export function formatYenText(s: string | null | undefined): string {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return "";
  const n = parseYenText(t);
  return n === null ? t : formatYenJa(n);
}

/** 保存値(万円・Decimal の文字や数値)を円の整数の文字へ。空は ""、読めなければ元の文字。 */
export function manToYen(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (s === "") return "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? "").padEnd(4, "0");
  // 5桁目以降は列に入らない(小数4桁)。入っていても切らずに元の文字を返す=黙って値を変えない。
  if (/[1-9]/.test(frac.slice(4))) return s;
  const joined = (m[1] + frac.slice(0, 4)).replace(/^0+(?=\d)/, "");
  return joined;
}

/** 円の入力を保存用の万円の文字へ(「3280.15」)。読めなければ null。 */
export function yenToMan(s: string | null | undefined): string | null {
  const n = parseYenText(s);
  if (n === null) return null;
  const str = String(n).padStart(5, "0");
  const int = str.slice(0, -4).replace(/^0+(?=\d)/, "");
  const frac = str.slice(-4).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
