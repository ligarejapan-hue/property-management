// DM writer 共通のロック順序「Owner → (variant) → 物件親行 → 子行」(設計書§2.2)を
// 実装するための行ロックヘルパー。全呼び出し元が同一形の文(= ANY + ORDER BY)を使う
// ことで取得順を揃え、相互待ち(デッドロック)を防ぐ。
// DL側(読み+凍結)は FOR SHARE、書込側(確定・mark-sent・削除系)は FOR UPDATE。

export type RawTx = {
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

/** id 集合を重複排除+昇順に正規化する(安定したロック取得順の根拠)。 */
export function sortUniqueIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

export async function lockOwnersForShare(
  tx: RawTx,
  ownerIds: string[],
): Promise<void> {
  const ids = sortUniqueIds(ownerIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM owners WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
}

export async function lockOwnersForUpdate(
  tx: RawTx,
  ownerIds: string[],
): Promise<void> {
  const ids = sortUniqueIds(ownerIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM owners WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}

export async function lockPropertiesForShare(
  tx: RawTx,
  propertyIds: string[],
): Promise<void> {
  const ids = sortUniqueIds(propertyIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
}

export async function lockPropertiesForUpdate(
  tx: RawTx,
  propertyIds: string[],
): Promise<void> {
  const ids = sortUniqueIds(propertyIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}
