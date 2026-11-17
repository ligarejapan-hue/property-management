/**
 * 口座の銀行名・支店名の入力の移り変わり(純関数・2026-11-17)。
 * 名前の文字が正本(書類に出す)。コードは候補から選んだときだけ持ち、支店の候補をその銀行の中から出すのに使う。
 * 名前を打ち直したらコードを外す(打ち直した名前と、前に選んだコードが食い違わないように)。
 */
export type BankNameFields = { bankName: string; bankCode: string; branchName: string; branchCode: string };
export type DirectoryChoice = { code: string; name: string };

/** 銀行名を打った: 銀行と支店のコードを外す(支店名の文字は残す=自由入力のまま使える)。 */
export function typeBank<T extends BankNameFields>(v: T, text: string): T {
  return { ...v, bankName: text, bankCode: "", branchCode: "" };
}

/**
 * 銀行を候補から選んだ: 名前とコードを入れる。前に別の銀行を選んでいたら、その銀行の支店は消す。
 * 同じ銀行・コードの無かった銀行名からなら、支店はそのまま。
 */
export function pickBank<T extends BankNameFields>(v: T, c: DirectoryChoice): T {
  const otherBank = v.bankCode !== "" && v.bankCode !== c.code;
  return otherBank
    ? { ...v, bankName: c.name, bankCode: c.code, branchName: "", branchCode: "" }
    : { ...v, bankName: c.name, bankCode: c.code };
}

/** 支店名を打った: 支店のコードを外す。 */
export function typeBranch<T extends BankNameFields>(v: T, text: string): T {
  return { ...v, branchName: text, branchCode: "" };
}

/** 支店を候補から選んだ: 名前とコードを入れる。 */
export function pickBranch<T extends BankNameFields>(v: T, c: DirectoryChoice): T {
  return { ...v, branchName: c.name, branchCode: c.code };
}
