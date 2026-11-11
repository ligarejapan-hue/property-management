/**
 * 謄本の外字(私用領域の字)を見分ける(2026-11-11 実機確認)。
 *
 * 登記の外字は PDF の本文で私用領域(U+E000〜U+F8FF)の字として出る。どの字かは分からない
 * (画面では □ や別の形に見える)ので、名前に入っていたら「読めない字がある」として扱う:
 * 所有者として自動で登録しない・名義の比べで「同じ」にしない・DM の宛名に出さない。
 */
const PRIVATE_USE = /[\uE000-\uF8FF]/u;

/** 名前に謄本の外字(私用領域の字)が入っているか。 */
export function hasPrivateUseChar(value: string | null | undefined): boolean {
  return !!value && PRIVATE_USE.test(value);
}

/** 私用領域の字を除く。 */
export function stripPrivateUse(value: string): string {
  return value.replace(/[\uE000-\uF8FF]/gu, "");
}

/** 1字が私用領域の字か。 */
export function isPrivateUseChar(c: string): boolean {
  return c.length === 1 && PRIVATE_USE.test(c);
}
