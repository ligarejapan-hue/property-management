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
 *   (`isLatestRequest`)。ここでは「発行した poll の世代」と「資源の一覧が実際に
 *   変わった」の両方が世代を進める——資源の一覧が変わった後に、差し替え前の
 *   一覧に対する応答が遅れて届いても `onRows` を呼ばない(仕様 6.3 のテーブルが
 *   古い所有者一覧のままにならないため)。
 *
 * review round1 の反映:
 * - Critical: `stop()` が `stopped=true` にした後、同じインスタンスへ `start()` が
 *   再度呼ばれても(React StrictMode が effect を mount→cleanup→mount と二重に
 *   呼ぶときに実際に起きる。`useMemo` は effect の再実行では作り直されないため、
 *   `use-edit-lock-status.ts` の cleanup(`controller.stop()`)の直後に同じ
 *   controller へ `start()` が戻ってくる)、`stopped` を戻していなかったため
 *   `poll()` が永久に `:67` で早期returnし、以後一度も問い合わせない=`rows` が
 *   空のまま固まる(帯が一生出ない)。`start()` の先頭で `stopped=false` に戻す。
 * - Minor 10(round1で対応): `start()` を冪等にする——既存の `timerHandle` があれば
 *   `stop()` と同じ手順で片付けてから新しい間隔を張る。2回連続で呼ばれても
 *   間隔が2本になって漏れない。
 * - Important 4: `setResources` は一覧の**中身**(集合)が変わっていなければ
 *   `seq` を進めない(=飛んでいる古い poll をstaleにしない)。`fetchProperty` の
 *   再取得のたびに参照だけ新しい配列が渡ってくる(page.tsx の `useMemo` が
 *   `property` オブジェクトの再生成のたびに新しい配列を作る)ため、内容が同じなら
 *   「変わっていない」として無視しないと、帯が最大30秒遅れて出る。逆に中身が
 *   本当に変わったとき(所有者の追加・削除)は、待たずにその場で1回問い合わせる
 *   (次のtickを待つと最大30秒、新しく増えた所有者の帯が出ない)。
 * - Minor 8: chunkの一部(または全部)が失敗しても、届いた分だけを反映する。
 *   従来は失敗したchunkを`[]`に畳んで結合するため実害は無かったが、**全chunkが
 *   失敗した**とき(単一chunk=51件未満の一覧全体を含む)は結合結果が`[]`になり、
 *   `onRows([])` が今持っている行を消してしまう(一時的な500で帯が消え、
 *   4つの操作が30秒間だけ再度有効になる)。1件も取得できなかった poll は
 *   `onRows` を呼ばず、直前の行をそのまま残す(fail open のまま画面は変えない)。
 *
 * review round2 の反映:
 * - N1: Minor 8 の「直前の行を保持する」は、状態窓口が**持続的に**失敗し続ける
 *   場合(不具合のあるデプロイ・プロキシの不調・500ループ)を考えていなかった。
 *   保持を無期限にすると、長時間開いたタブが「🔒 山田さんが編集中です」と
 *   4つの操作の無効化を**タブの寿命いっぱい**保持し続け、しかも管理者の
 *   「鍵を外す」(`refresh()`)でも消せない(refreshした問い合わせ自体も同じ理由で
 *   失敗するため)——これはこの機能の fail open の立場(サーバが権威・見られない
 *   ときは止めない)と正反対の方向に倒れる。**3回連続で全chunk失敗**したら、
 *   保持していた行を諦めて空にする(fail open へ倒す)。1回・2回の失敗では
 *   従来どおり直前の行を保持し、途中で1回でも成功すれば連続回数を0へ戻す。
 */
import type { EditLockStatusRow } from "@/lib/api-client";
import { EDIT_LOCK_STATUS_POLL_MS, EDIT_LOCK_STATUS_CHUNK_SIZE } from "./rules";

export type EditLockStatusResource = Pick<EditLockStatusRow, "resourceType" | "resourceId">;

// ⚠(review round1 Minor 9) 定数の在処は `rules.ts`(窓口の zod スキーマ
//   `src/app/api/edit-locks/status/route.ts` と共有)。既存の呼び出し元がここから
//   importしても壊れないよう re-export する。
export { EDIT_LOCK_STATUS_CHUNK_SIZE };

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
  /**
   * 開いたとき1回だけ呼ぶ。資源の一覧を設定し、即座に1回問い合わせ、以後の周期を
   * 始める。⚠冪等(review round1 Minor 10): 既に走っていても、既存の間隔を
   * 片付けてから新しく張り直す(呼び出し側の事故で間隔が漏れない)。
   */
  start(resources: EditLockStatusResource[]): void;
  /**
   * 資源の一覧が変わったとき(所有者が増減した等)に呼ぶ。一覧の**中身**が
   * 実際に変わったときだけ、飛んでいる古い応答を無効化しその場で1回問い合わせる
   * (review round1 Important 4)。中身が同じ(参照だけ新しい配列)なら何もしない
   * =飛んでいる poll を無駄にstaleにしない。
   */
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

/**
 * 資源の一覧の「中身」を順序に依存しない形で表す(review round1 Important 4)。
 * ⚠並び順だけが変わった(同じ集合)場合も同一とみなす——Prismaの再取得で
 *   `propertyOwners` の並びが安定している保証はなく、順序差だけで
 *   「変わった」と誤判定すると、価値の無い即時再問い合わせを繰り返す。
 */
function resourceSetKey(resources: readonly EditLockStatusResource[]): string {
  return resources
    .map((r) => `${r.resourceType}:${r.resourceId}`)
    .sort()
    .join("|");
}

/**
 * 状態窓口が連続でこの回数だけ全chunk失敗したら、保持していた行を諦めて
 * fail open へ倒す(review round2 N1)。1〜2回は一過性として直前の行を保持する。
 */
const MAX_CONSECUTIVE_TOTAL_FAILURES = 3;

export function createEditLockStatusController(
  deps: EditLockStatusControllerDeps,
): EditLockStatusController {
  let resources: EditLockStatusResource[] = [];
  /** 今の poll 呼び出しの世代。資源の一覧が実際に変わったときだけ進め、遅れた応答を捨てる。 */
  let seq = 0;
  let timerHandle: unknown = null;
  let stopped = false;
  /** 連続で全chunk失敗した回数(review round2 N1)。1回でも成功すれば0へ戻す。 */
  let consecutiveTotalFailures = 0;

  function clearTimer(): void {
    if (timerHandle !== null) {
      deps.clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function poll(): void {
    if (stopped) return;
    seq += 1;
    const issued = seq;
    const targets = resources;
    if (targets.length === 0) {
      // ⚠(横断レビュー M9) この早期returnも「この poll の結論」を出している
      //   (保持する行は無い)ので、連続失敗の数え上げも戻す。戻さないと、
      //   一覧がいったん空になる経路を通ったあと、以前の失敗が持ち越されて
      //   次の1回の失敗だけで fail open へ倒れる(数えも消しもしない不揃い)。
      consecutiveTotalFailures = 0;
      deps.onRows([]);
      return;
    }
    const chunks = chunk(targets, EDIT_LOCK_STATUS_CHUNK_SIZE);
    void Promise.all(
      chunks.map((c) =>
        deps
          .fetchStatus(c)
          .then((rows) => ({ ok: true as const, rows }))
          .catch(() => ({ ok: false as const, rows: [] as EditLockStatusRow[] })),
      ),
    ).then((results) => {
      // ⚠(seq guard) 資源の一覧が差し替わった・stop() された後に届いた応答は、
      //   もう「今の一覧」の話ではない=反映しない。
      if (stopped || issued !== seq) return;
      // ⚠(review round1 Minor 8 / round2 N1) 1件も取得できなかった(=すべての
      //   chunkが失敗した)pollは、まず直前の行をそのまま残す(一過性の500等)。
      //   ただし**連続で**MAX_CONSECUTIVE_TOTAL_FAILURES回失敗したら、もう
      //   「一過性」とは呼べない——保持を諦めて空にし、fail open へ倒す
      //   (帯・4つの無効化をタブの寿命いっぱい固定しない。管理者のrefresh()も
      //   このpollを通るため、外した直後にまた失敗しても3回目でちゃんと戻る)。
      //   一部でも成功していれば、失敗したchunk分は([]に畳まれて)結果から
      //   抜け落ちるだけで反映し、連続失敗回数も0へ戻す。
      if (results.every((r) => !r.ok)) {
        consecutiveTotalFailures += 1;
        if (consecutiveTotalFailures < MAX_CONSECUTIVE_TOTAL_FAILURES) return;
        consecutiveTotalFailures = 0;
        deps.onRows([]);
        return;
      }
      consecutiveTotalFailures = 0;
      deps.onRows(results.flatMap((r) => r.rows));
    });
  }

  /** 定期の呼び出し。表に出ている間だけ問い合わせる(仕様 6.3)。 */
  function tick(): void {
    if (deps.isHidden()) return;
    poll();
  }

  return {
    start(initial) {
      // ⚠(review round1 Critical) stop()されたインスタンスへstart()が
      //   戻ってくることがある(React StrictMode のeffect二重呼び出し=
      //   mount→cleanup→mountで同じcontrollerインスタンスにcleanup(stop)の
      //   直後にstart()が再度呼ばれる)。stoppedを戻さないと以後poll()が
      //   永久に早期returnし、rowsが空のまま固まる。
      stopped = false;
      consecutiveTotalFailures = 0;
      resources = initial;
      // ⚠(review round1 Minor 10) 冪等にする: 既存の間隔があれば片付けてから
      //   新しく張り直す(呼び出し側が誤って2回start()しても間隔が漏れない)。
      clearTimer();
      timerHandle = deps.setInterval(tick, EDIT_LOCK_STATUS_POLL_MS);
      tick();
    },
    setResources(next) {
      // ⚠(review round1 Important 4) 一覧の中身が実際に変わっていなければ
      //   何もしない(seqも進めない)。fetchProperty等の再取得のたびに
      //   参照だけ新しい配列が渡ってくるが、その都度staleにすると飛んでいる
      //   pollの結果を無駄に捨て、帯が最大30秒遅れる。
      const unchanged = resourceSetKey(next) === resourceSetKey(resources);
      resources = next;
      if (unchanged) return;
      // 中身が本当に変わった: 古い一覧に対して飛んでいる応答を無効化し、
      // 次のtickを待たずにその場で新しい一覧を問い合わせる(新しく増えた
      // 所有者の帯を最大30秒待たせない)。poll()自体がseqを進める。
      poll();
    },
    refresh() {
      poll();
    },
    stop() {
      stopped = true;
      seq += 1;
      clearTimer();
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
