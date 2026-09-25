/**
 * 見ている側の司令塔(仕様 6.3)。**判断は一切ここでしない**——ここが持つのは
 * 「開いたとき1回・以後30秒ごとに1回(表に出ている間だけ)呼ぶ」「50件を超えたら
 * 分割する」「資源の一覧が変わったら古い応答を捨てる」という**周期と呼び出しの形**
 * だけ。表示の切り分け(帯を出す/隠す・どの操作を止めるか)は呼び出し側
 * (`use-edit-lock-status.ts`・`page.tsx`)が `EditLockStatusRow` をそのまま見て決める。
 *
 * `createEditLockController`(鍵を持つ側・controller.ts)と同じ形の DI: React に
 * 依存せず、`fetchStatus`・`onRows`・`setInterval`/`clearInterval`・`isHidden` を
 * `deps` として注入する。`use-edit-lock-status.ts` はこれを React に結線するだけの
 * 薄い層になる(`use-edit-lock.ts`/`createEditLockController` の関係と同じ)。
 *
 * ⚠stale 応答の破棄は `src/lib/address-lookup-ui-utils.ts` の `seq` と同じ考え方
 *   (`isLatestRequest`)。ここでは「発行した poll の世代」と「資源の一覧を
 *   差し替えた」の両方が世代を進める——資源の一覧が変わった後に、差し替え前の
 *   一覧に対する応答が遅れて届いても `onRows` を呼ばない(仕様 6.3 のテーブルが
 *   古い所有者一覧のままにならないため)。
 */
import type { EditLockStatusRow } from "@/lib/api-client";
import { EDIT_LOCK_STATUS_POLL_MS } from "./rules";

export type EditLockStatusResource = Pick<EditLockStatusRow, "resourceType" | "resourceId">;

/** 窓口は1回50件まで(仕様 4.5)。呼び出し側で分割する。 */
export const EDIT_LOCK_STATUS_CHUNK_SIZE = 50;

export interface EditLockStatusControllerDeps {
  fetchStatus(resources: EditLockStatusResource[]): Promise<EditLockStatusRow[]>;
  /** 最新の(staleでない)応答が届いたときだけ呼ばれる。 */
  onRows(rows: EditLockStatusRow[]): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** true の間は定期の呼び出しを休む(仕様 6.3: 画面が表に出ている間だけ)。 */
  isHidden(): boolean;
}

export interface EditLockStatusController {
  /** 開いたとき1回だけ呼ぶ。資源の一覧を設定し、即座に1回問い合わせ、以後の周期を始める。 */
  start(resources: EditLockStatusResource[]): void;
  /** 資源の一覧が変わったとき(所有者が増減した等)に呼ぶ。飛んでいる古い応答を無効化する。 */
  setResources(resources: EditLockStatusResource[]): void;
  /** 即座に1回問い合わせる(管理者が鍵を外した直後に使う・仕様 6.3)。isHiddenに関わらず呼ぶ。 */
  refresh(): void;
  /** unmount 用。以後は周期も止め、飛んでいる応答が届いても onRows を呼ばない。 */
  stop(): void;
}

/** N件ずつに分割する(50件超は複数回に分けて呼ぶ・仕様 4.5)。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function createEditLockStatusController(
  deps: EditLockStatusControllerDeps,
): EditLockStatusController {
  let resources: EditLockStatusResource[] = [];
  /** 今の資源の一覧・今の poll 呼び出しの世代。差し替えのたびに進め、遅れた応答を捨てる。 */
  let seq = 0;
  let timerHandle: unknown = null;
  let stopped = false;

  function poll(): void {
    if (stopped) return;
    seq += 1;
    const issued = seq;
    const targets = resources;
    if (targets.length === 0) {
      deps.onRows([]);
      return;
    }
    const chunks = chunk(targets, EDIT_LOCK_STATUS_CHUNK_SIZE);
    void Promise.all(
      chunks.map((c) => deps.fetchStatus(c).catch(() => [] as EditLockStatusRow[])),
    ).then((results) => {
      // ⚠(seq guard) 資源の一覧が差し替わった・stop() された後に届いた応答は、
      //   もう「今の一覧」の話ではない=反映しない。
      if (stopped || issued !== seq) return;
      deps.onRows(results.flat());
    });
  }

  /** 定期の呼び出し。表に出ている間だけ問い合わせる(仕様 6.3)。 */
  function tick(): void {
    if (deps.isHidden()) return;
    poll();
  }

  return {
    start(initial) {
      resources = initial;
      timerHandle = deps.setInterval(tick, EDIT_LOCK_STATUS_POLL_MS);
      tick();
    },
    setResources(next) {
      resources = next;
      // ⚠差し替え前の一覧に対して既に飛んでいる poll があれば、その応答は
      //   もう古い一覧の話なので捨てる(seq を進めるだけで足りる=次の tick/refresh
      //   が新しい一覧で改めて poll する)。
      seq += 1;
    },
    refresh() {
      poll();
    },
    stop() {
      stopped = true;
      seq += 1;
      if (timerHandle !== null) {
        deps.clearInterval(timerHandle);
        timerHandle = null;
      }
    },
  };
}

/** `rows` から特定の資源の行を探す(hookの`byKey`が使う純粋な検索)。 */
export function findEditLockStatusRow(
  rows: readonly EditLockStatusRow[],
  resourceType: EditLockStatusResource["resourceType"],
  resourceId: string,
): EditLockStatusRow | undefined {
  return rows.find((r) => r.resourceType === resourceType && r.resourceId === resourceId);
}
