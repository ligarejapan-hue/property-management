export const OTHER_OPTION = "その他";

export function hasOtherOption(options?: readonly string[]): boolean {
  return !!options && options.includes(OTHER_OPTION);
}

/** select: value が options 外（非空）or「その他」なら その他モード。freeText は options外の実値。 */
export function selectOtherState(value: string, options: readonly string[]): { isOther: boolean; freeText: string } {
  const inOptions = options.includes(value);
  const isOther = value === OTHER_OPTION || (value !== "" && !inOptions);
  return { isOther, freeText: isOther && value !== OTHER_OPTION ? value : "" };
}

/** multiselect: options外の要素＝自由入力値。 */
export function multiOtherState(arr: string[], options: readonly string[]): { isOther: boolean; freeText: string; optionSelections: string[] } {
  const optionSelections = arr.filter((x) => options.includes(x) && x !== OTHER_OPTION);
  const freeItem = arr.find((x) => !options.includes(x));
  return { isOther: arr.includes(OTHER_OPTION) || freeItem !== undefined, freeText: freeItem ?? "", optionSelections };
}

/** multiselect の自由入力テキストを反映（options選択は保持、その他部分をテキスト or 「その他」に）。 */
export function setMultiFreeText(arr: string[], options: readonly string[], text: string): string[] {
  const base = arr.filter((x) => options.includes(x) && x !== OTHER_OPTION);
  return [...base, text.trim() !== "" ? text : OTHER_OPTION];
}
