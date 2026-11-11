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
import { hasPrivateUseChar } from "@/lib/private-use-char";
import { ownerDiff } from "@/lib/registry-owner-check/diff";

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

/**
 * 比べ合わせ用の集まり。謄本の外字(私用領域)を含む名前は、どの名前とも一致しない印にする
 * (同じ外字の名前どうしも「同じ」にしない=確かめる一覧に出す・2026-11-11)。
 */
function compareKeySet(names: readonly string[], key: (s: string) => string, side: string): Set<string> {
  return new Set(
    names
      .map((n, i) => (hasPrivateUseChar(n) ? `${GAIJI_KEY}${side}:${i}` : key(n)))
      .filter((k) => k.length > 0),
  );
}
const GAIJI_KEY = "〓外字:";

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
  const system = compareKeySet(systemNames, (s) => importNormalizeName(s), "s");
  if (system.size === 0) return "no_owner";
  if (sameSet(compareKeySet(registryNames, (s) => importNormalizeName(s), "r"), system)) return "same";
  if (sameSet(compareKeySet(registryNames, ownerNameKey, "r"), compareKeySet(systemNames, ownerNameKey, "s"))) {
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
 * ⚠外字の組(名義の確認で「≠ 外字（読めない字）」と並ぶ2人)は、システムの人をそのまま残し、
 *   謄本の外字の名前は足さない(2026-11-11 昼 実機確認)。外字はどの字か分からず、直すと
 *   正しい名前の人が外れて外字の名前の人が残っていた。外字の名前どうしもそろえて同じにしない
 *   (組にならなかった外字の名前のシステムの人は、今までどおり外す)。
 */
export function planOwnerReplacement(
  registryOwners: readonly RegistryOwnerEntry[],
  linked: readonly LinkedOwnerEntry[],
): OwnerReplacementPlan {
  const gaiji = gaijiPairs(registryOwners, linked);
  const matchKey = (name: string) => (hasPrivateUseChar(name) ? "" : ownerNameKey(name));
  const registryKeys = keySet(
    registryOwners.map((o) => o.name),
    matchKey,
  );
  const linkedKeys = new Set<string>();
  const keepOwnerIds: string[] = [];
  const removeOwnerIds: string[] = [];
  linked.forEach((l, i) => {
    const k = matchKey(l.name);
    if (gaiji.systemIndexes.has(i)) {
      keepOwnerIds.push(l.ownerId);
    } else if (k.length > 0 && registryKeys.has(k)) {
      keepOwnerIds.push(l.ownerId);
      linkedKeys.add(k);
    } else {
      removeOwnerIds.push(l.ownerId);
    }
  });
  const add = registryOwners.filter((o, i) => {
    if (gaiji.registryIndexes.has(i) || gaiji.registryKeys.has(ownerNameKey(o.name))) return false;
    const k = ownerNameKey(o.name);
    return k.length > 0 && !linkedKeys.has(k);
  });
  return { keepOwnerIds, removeOwnerIds, add };
}

/** 名義の確認の並べ方(ownerDiff)で、外字の組になった2人の位置。外字の無い物件では空。 */
function gaijiPairs(
  registryOwners: readonly RegistryOwnerEntry[],
  linked: readonly LinkedOwnerEntry[],
): { systemIndexes: Set<number>; registryIndexes: Set<number>; registryKeys: Set<string> } {
  const out = { systemIndexes: new Set<number>(), registryIndexes: new Set<number>(), registryKeys: new Set<string>() };
  if (![...registryOwners, ...linked].some((o) => hasPrivateUseChar(o.name))) return out;
  const rows = ownerDiff(
    registryOwners.map((o) => o.name),
    linked.map((l) => l.name),
  ).rows;
  for (const r of rows) {
    if (r.status !== "differs" || r.systemIndex === null || r.registryIndex === null) continue;
    if (!r.pairKinds.includes("gaiji")) continue;
    out.systemIndexes.add(r.systemIndex);
    out.registryIndexes.add(r.registryIndex);
    // 謄本に同じ人が2回載っている(持分の行)ときの2回目も足さない
    out.registryKeys.add(ownerNameKey(registryOwners[r.registryIndex].name));
  }
  return out;
}
