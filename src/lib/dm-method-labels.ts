// DM送付方法の日本語ラベル(設計書§2.6)。
// 生値の英字("sale_dm" 等)を画面に出さない。未知値(旧データの自由入力)は生値のまま返す。

export const DM_METHOD_LABELS: Readonly<Record<string, string>> = {
  mail: "郵送",
  sale_dm: "売却DM",
  hand_delivery: "手渡し",
  other: "その他",
};

export function dmMethodLabel(method: string | null | undefined): string {
  if (!method) return "";
  return DM_METHOD_LABELS[method] ?? method;
}

// DM種別(dm_type)のラベル。null は既存行・sale_dm ブリッジ行。
export const DM_TYPE_LABELS: Readonly<Record<string, string>> = {
  owner_address: "所有者宛",
  property_address: "物件宛",
};

export function dmTypeLabel(dmType: string | null | undefined): string {
  if (!dmType) return "";
  return DM_TYPE_LABELS[dmType] ?? dmType;
}
