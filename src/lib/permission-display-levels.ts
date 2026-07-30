/**
 * 「表示レベル」（オーナー情報を誰にどこまで見せるか）の共通ロジック。
 *
 * ## 何が問題だったか
 * 表示レベルは `owner_phone` のような 1 つの resource に対して
 * `hidden` / `masked` / `partial` / `read` / `full` / `edit` のいずれか **1 つ**が
 * 決まる、という設計。ところが保存は resource × action の行を足し引きするだけで、
 * **同じ resource に複数のレベルを同時に granted にできてしまう**。
 * 解決側（`getOwnerDisplayConfig` の `resolveLevel`）は**最も緩いものを採用**するため、
 * 「マスク」を付けても「全表示」の行が残っていると**生値が出続ける**。
 * 設定した人にはマスクしたつもりの画面が、実際にはマスクされていない。
 *
 * ## ここで提供するもの
 * - `DISPLAY_LEVELS` … 緩い順（resolveLevel と同じ優先順）
 * - `effectiveDisplayLevel` … 複数 granted のときに実際に効くレベル
 * - `findDisplayLevelConflicts` … 保存前の検証用（どの resource が重複しているか）
 * - `withExclusiveDisplayLevel` … 画面の選択操作（1 つ選ぶと他は外れる）
 *
 * ⚠`edit` は `full` と表示上は同じ（生値）だが、備考では**書き込み可否**にも
 * 使われる（`owner_note` の full|edit でメモ作成可）。そのため重複を整理するときは
 * **今効いているレベルを残す**のが安全＝誰の見え方も権限も変えない。
 */

/** 緩い順（先頭が最も緩い）。`getOwnerDisplayConfig` の resolveLevel と同じ並び。 */
export const DISPLAY_LEVELS = [
  "edit",
  "full",
  "read",
  "partial",
  "masked",
  "hidden",
] as const;

export type DisplayLevelAction = (typeof DISPLAY_LEVELS)[number];

/** 表示レベルで制御する resource（1 つだけ選ぶ対象）。 */
export const DISPLAY_LEVEL_RESOURCES = [
  "owner_name",
  "owner_name_kana",
  "owner_phone",
  "owner_zip",
  "owner_address",
  "owner_email",
  "owner_note",
  "owner_corporate_number",
] as const;

/** 画面・エラーメッセージ共通の日本語ラベル（生の識別子を利用者に見せない）。 */
export const DISPLAY_LEVEL_LABELS: Readonly<Record<string, string>> = {
  hidden: "非表示",
  masked: "マスク",
  partial: "一部表示",
  read: "閲覧のみ",
  full: "全表示",
  edit: "編集可",
};

export const DISPLAY_LEVEL_RESOURCE_LABELS: Readonly<Record<string, string>> = {
  owner_name: "オーナー名",
  owner_name_kana: "オーナー名カナ",
  owner_phone: "オーナー電話番号",
  owner_zip: "オーナー郵便番号",
  owner_address: "オーナー住所",
  owner_email: "オーナーメールアドレス",
  owner_note: "オーナー備考",
  owner_corporate_number: "オーナー法人番号",
};

const LEVEL_SET: ReadonlySet<string> = new Set(DISPLAY_LEVELS);
const RESOURCE_SET: ReadonlySet<string> = new Set(DISPLAY_LEVEL_RESOURCES);

export function isDisplayLevelAction(action: string): boolean {
  return LEVEL_SET.has(action);
}

export function isDisplayLevelResource(resource: string): boolean {
  return RESOURCE_SET.has(resource);
}

export interface PermissionRowLike {
  resource: string;
  action: string;
  granted: boolean;
}

/**
 * 複数 granted のときに**実際に効く**レベルを返す（= 最も緩いもの）。
 * granted が 1 つも無ければ null（＝未設定。呼び出し側の既定は hidden）。
 */
export function effectiveDisplayLevel(
  actions: readonly string[],
): DisplayLevelAction | null {
  for (const level of DISPLAY_LEVELS) {
    if (actions.includes(level)) return level;
  }
  return null;
}

export interface DisplayLevelConflict {
  resource: string;
  /** granted になっているレベル（緩い順） */
  granted: DisplayLevelAction[];
  /** 実際に効いているレベル */
  effective: DisplayLevelAction;
}

/**
 * 同じ resource に表示レベルが 2 つ以上 granted になっている箇所を洗い出す。
 * 保存前の検証と、既存データの点検の両方で使う。
 */
export function findDisplayLevelConflicts(
  rows: readonly PermissionRowLike[],
): DisplayLevelConflict[] {
  const byResource = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.granted) continue;
    if (!isDisplayLevelResource(row.resource)) continue;
    if (!isDisplayLevelAction(row.action)) continue;
    const list = byResource.get(row.resource) ?? [];
    list.push(row.action);
    byResource.set(row.resource, list);
  }

  const conflicts: DisplayLevelConflict[] = [];
  for (const [resource, actions] of byResource) {
    if (actions.length < 2) continue;
    const effective = effectiveDisplayLevel(actions);
    if (!effective) continue;
    conflicts.push({
      resource,
      granted: DISPLAY_LEVELS.filter((l) => actions.includes(l)),
      effective,
    });
  }
  // resource 名で安定ソート（エラーメッセージを再現可能にする）
  return conflicts.sort((a, b) => a.resource.localeCompare(b.resource));
}

/** 重複を利用者向けの1行に整形（例: 「オーナー電話番号: 全表示・マスク」）。 */
export function describeDisplayLevelConflicts(
  conflicts: readonly DisplayLevelConflict[],
): string {
  return conflicts
    .map((c) => {
      const resource = DISPLAY_LEVEL_RESOURCE_LABELS[c.resource] ?? c.resource;
      const levels = c.granted
        .map((l) => DISPLAY_LEVEL_LABELS[l] ?? l)
        .join("・");
      return `${resource}: ${levels}`;
    })
    .join(" / ");
}

/**
 * 画面の選択操作。表示レベルは**排他**なので、選んだレベル以外の同 resource の行を
 * 取り除いてから追加する。既に選ばれているレベルをもう一度押した場合は解除
 * （＝どのレベルも granted でない＝未設定。解決側の既定は hidden）。
 *
 * 表示レベル以外（property:read など）は従来どおり単純な on/off。
 */
export function withExclusiveDisplayLevel<T extends PermissionRowLike>(
  rows: readonly T[],
  resource: string,
  action: string,
  makeRow: (resource: string, action: string) => T,
): T[] {
  const isExclusive =
    isDisplayLevelResource(resource) && isDisplayLevelAction(action);

  const alreadyOn = rows.some(
    (r) => r.resource === resource && r.action === action && r.granted,
  );

  if (!isExclusive) {
    if (rows.some((r) => r.resource === resource && r.action === action)) {
      return rows.filter(
        (r) => !(r.resource === resource && r.action === action),
      );
    }
    return [...rows, makeRow(resource, action)];
  }

  // 同 resource の表示レベル行をすべて落としてから、必要なら 1 つだけ足す。
  const withoutLevels = rows.filter(
    (r) =>
      !(
        r.resource === resource &&
        isDisplayLevelAction(r.action)
      ),
  );
  return alreadyOn ? withoutLevels : [...withoutLevels, makeRow(resource, action)];
}
