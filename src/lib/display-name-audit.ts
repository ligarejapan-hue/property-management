/**
 * 表示名監査（Display Name Audit）の純関数ロジック。
 *
 * 目的:
 *  - 同一の「正規化名キー」に、保存されている **生 name が2バリアント以上**ある群を検出する。
 *  - これは取込時の表記ゆれ（全半角・空白違いなど）で、同一人物・同一建物が別名義で
 *    残っているケースを人が確認するための read-only レポートの素材。
 *
 * 設計上の約束:
 *  - DB 非依存・副作用なしの純関数（テスト容易・呼び出し側で prisma から取得して渡す）。
 *  - 正規化は呼び出し側から `normalizer` を注入する。
 *    Owner は normalizeName、Building は normalizeBuildingName を渡して再利用する。
 *  - normalize 後が空文字になるキー（空・空白のみの name 等）は群化しない。
 *  - distinct な生 name が2つ以上ある群のみ残す（1バリアントは表記ゆれではない）。
 *  - 群は「totalRecords 降順 → key 昇順」で安定ソートする。
 *  - 群の最大返却数に上限（既定 1000）を設け、超過は silent に切り捨てず `truncated: true` を返す。
 */

export interface AuditRecord {
  id: string;
  name: string;
}

export interface AuditVariant {
  /** 保存されている生の name（trim 等の正規化はしない） */
  name: string;
  /** この生 name を持つレコード数 */
  count: number;
  /** この生 name を持つレコードの id 一覧（入力順を保持） */
  ids: string[];
}

export interface AuditGroup {
  /** 正規化名キー（normalizer の出力） */
  key: string;
  /** 生 name 単位のバリアント（count 降順 → name 昇順で安定ソート） */
  variants: AuditVariant[];
  /** この群に含まれる全レコード数（全バリアントの count 合計） */
  totalRecords: number;
}

export interface AuditResult {
  groups: AuditGroup[];
  /** 群数が maxGroups を超えたため先頭 maxGroups 群に制限したか */
  truncated: boolean;
}

export interface BuildDisplayNameAuditOptions {
  /** 返却する群の最大数（既定 1000）。超過分は切り捨て truncated:true。 */
  maxGroups?: number;
}

const DEFAULT_MAX_GROUPS = 1000;

/**
 * レコード群から「同一正規化キーで生 name が2バリアント以上」の群を抽出する。
 *
 * @param records   監査対象レコード（id + 生 name）。
 * @param normalizer 比較用キーを作る正規化関数（normalizeName / normalizeBuildingName）。
 * @param options   maxGroups（既定 1000）。
 */
export function buildDisplayNameAuditGroups(
  records: AuditRecord[],
  normalizer: (name: string) => string,
  options: BuildDisplayNameAuditOptions = {},
): AuditResult {
  const maxGroups =
    options.maxGroups != null && options.maxGroups >= 0
      ? options.maxGroups
      : DEFAULT_MAX_GROUPS;

  // key → (生 name → variant)。入力順を保持するため Map を使う。
  const keyToVariants = new Map<string, Map<string, AuditVariant>>();

  for (const record of records) {
    // name は string 前提だが、防御的に null/undefined を空文字として扱う。
    const rawName = record.name ?? "";
    const key = normalizer(rawName);
    // 正規化後が空のキー（空・空白のみ等）は群化しない。
    if (key === "") continue;

    let variants = keyToVariants.get(key);
    if (!variants) {
      variants = new Map<string, AuditVariant>();
      keyToVariants.set(key, variants);
    }

    const existing = variants.get(rawName);
    if (existing) {
      existing.count += 1;
      existing.ids.push(record.id);
    } else {
      variants.set(rawName, { name: rawName, count: 1, ids: [record.id] });
    }
  }

  const groups: AuditGroup[] = [];
  for (const [key, variantMap] of keyToVariants) {
    // distinct な生 name が2つ以上ある群のみが「表記ゆれ」候補。
    if (variantMap.size < 2) continue;

    const variants = Array.from(variantMap.values()).sort((a, b) => {
      // バリアントは件数降順 → name 昇順で安定化。
      if (b.count !== a.count) return b.count - a.count;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    const totalRecords = variants.reduce((sum, v) => sum + v.count, 0);
    groups.push({ key, variants, totalRecords });
  }

  // 群は totalRecords 降順 → key 昇順で安定ソート。
  groups.sort((a, b) => {
    if (b.totalRecords !== a.totalRecords) return b.totalRecords - a.totalRecords;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const truncated = groups.length > maxGroups;
  return {
    groups: truncated ? groups.slice(0, maxGroups) : groups,
    truncated,
  };
}
