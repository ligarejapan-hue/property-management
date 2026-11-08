/**
 * 謄本の名義とシステムの所有者を比べる(ピュア・2026-11-08 発注者依頼)。
 *
 * ⚠比べ方は**取引の照合(crosscheck)と同じそろえ方**(全角半角・空白・大文字小文字・
 *   (株)と株式会社・異体字の表)。そろえて初めて同じなら「表記の違い」(same_notation)=
 *   確認用の一覧には出さない(発注者指示)。
 * ⚠氏名はここで比べるだけで、どこにも保存しない。
 */
import { normalizeName as importNormalizeName } from "@/lib/normalize";
import { foldNameVariants } from "@/lib/deals/crosscheck";

export type RegistryOwnerCheckResult =
  | "same"
  | "same_notation"
  | "mismatch"
  | "unreadable"
  | "no_owner";

/** 比べるときの名前の形(照合と同じ・異体字までそろえる)。 */
export function ownerNameKey(name: string): string {
  return foldNameVariants(name);
}

function keySet(names: readonly string[], key: (s: string) => string): Set<string> {
  return new Set(names.map(key).filter((k) => k.length > 0));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * 名義の比べ合わせ。
 * - システムに所有者がいない → no_owner(「所有者が紐付けられていません」の品質チェックが別にある)
 * - 取込と同じそろえ方(全角半角・空白)で同じ → same
 * - 照合と同じそろえ方(異体字まで)で同じ → same_notation
 * - それ以外 → mismatch(謄本の人がいない/謄本にない人がいる)
 */
export function compareRegistryOwners(
  registryNames: readonly string[],
  systemNames: readonly string[],
): Exclude<RegistryOwnerCheckResult, "unreadable"> {
  const system = keySet(systemNames, (s) => importNormalizeName(s));
  if (system.size === 0) return "no_owner";
  if (sameSet(keySet(registryNames, (s) => importNormalizeName(s)), system)) return "same";
  if (sameSet(keySet(registryNames, ownerNameKey), keySet(systemNames, ownerNameKey))) {
    return "same_notation";
  }
  return "mismatch";
}

export interface RegistryOwnerEntry {
  name: string;
  address: string | null;
  share: string | null;
}

export interface LinkedOwnerEntry {
  ownerId: string;
  name: string;
}

export interface OwnerReplacementPlan {
  /** 謄本にも載っている(そろえると同じ名前)=そのまま残す所有者 */
  keepOwnerIds: string[];
  /** 謄本に載っていない=物件から外す所有者 */
  removeOwnerIds: string[];
  /** システムにいない=足す謄本の人(謄本の並びのまま) */
  add: RegistryOwnerEntry[];
}

/**
 * 「謄本の名義に直す」で何を外して何を足すか。名前は照合と同じそろえ方で比べる。
 * ⚠表記の違いだけの人は外さない・足さない(同じ人として残す=二重に登録しない)。
 */
export function planOwnerReplacement(
  registryOwners: readonly RegistryOwnerEntry[],
  linked: readonly LinkedOwnerEntry[],
): OwnerReplacementPlan {
  const registryKeys = keySet(
    registryOwners.map((o) => o.name),
    ownerNameKey,
  );
  const linkedKeys = new Set<string>();
  const keepOwnerIds: string[] = [];
  const removeOwnerIds: string[] = [];
  for (const l of linked) {
    const k = ownerNameKey(l.name);
    if (k.length > 0 && registryKeys.has(k)) {
      keepOwnerIds.push(l.ownerId);
      linkedKeys.add(k);
    } else {
      removeOwnerIds.push(l.ownerId);
    }
  }
  const add = registryOwners.filter((o) => {
    const k = ownerNameKey(o.name);
    return k.length > 0 && !linkedKeys.has(k);
  });
  return { keepOwnerIds, removeOwnerIds, add };
}
