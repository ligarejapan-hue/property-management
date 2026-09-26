/**
 * 鍵を持つ側の司令塔(仕様 6.2)。**判断は一切ここでしない**。
 * すべて `ui-state.ts` の純関数(`uiStateFromAcquire` 等)に委ね、この
 * ファイルは「窓口を呼ぶ順序」「30秒ごとの合図」「イベントの配線」だけを持つ。
 *
 * React には依存しない(タイマー・時計・窓口を `deps` として注入する)。
 * `use-edit-lock.ts` はこれを React に結線するだけの薄い層になる。
 *
 * ⚠(review round1 C1) 合図は複数が同時に飛びうる(30秒間隔のtickと、裏から戻った
 *   ときの即時合図が重なる/releaseと入れ違う)。届いた順は保証されないので、
 *   `generation` を持ち、acquire/release/dispose の開始時と非mine状態への遷移時に
 *   必ず1つ進める。合図・取得を投げる直前に値を捕まえ、応答が返ったときに値が
 *   変わっていたら(=その間に鍵の持ち主が変わった/失われた/手放された)反映しない。
 *   `src/lib/address-lookup-ui-utils.ts` の `seq`(stale request 破棄)と同じ考え方。
 * ⚠(review round2 n1) 上の discard だけだと、release/dispose が acquire を追い越した
 *   ときに**サーバが実際に許可した鍵**が孤児になる(state には反映しない=正しいが、
 *   lockId をどこにも渡さず deps.release も beacon も呼ばれない)。acquire の stale
 *   分岐でだけ、応答が mine だったらその lockId を beacon 経由で手放す(dispose 後でも
 *   ヘッダ不要で安全に呼べる)。
 * ⚠(review round3 n7) 入力のたびに acquire() を呼ぶと、期限切れの間の連続入力
 *   (バースト)が複数の取得を同時に飛ばす。通常は先着以外の応答が持つ lockId が
 *   既に上書きされていて実害は無いが、行ロックの直列化順が逆転すると新しい応答が
 *   生きている行を beacon で消す経路になる(n1の裏返し)。`acquireInFlight` で
 *   1本しか同時に走らせない。
 * ⚠(review round3 n8) 404(資源消失)の分岐だけ世代ガードが無かった。他の書き込み
 *   経路と同じ規約にするため、取り直しを始めた直後の世代を控え、一致するときだけ
 *   deleted を反映する。
 * ⚠(task5 持ち越し#1) 取得が既に飛んでいる間の acquire() は、何も送らずに即座に解決
 *   していた。呼び出し元(画面)がこれを await しても「送った」のか「何もせず終わった」
 *   のか区別できない。既に飛んでいる Promise をそのまま返すよう改める(await すれば
 *   必ずその試行の決着を待てる)。
 * ⚠(task5 持ち越し#2) 上の変更だけでは、飛んでいる間に来た入力(noteActivity)はその
 *   1本の応答をただ待つだけになり、応答が一過性の理由(ネットワーク瞬断等)で失敗すると
 *   次の入力が来ない限りもう二度と取り直されない(「入力すると自動で取り直します」と
 *   案内したまま何も起きない)。飛んでいる間に来た入力は
 *   `reacquireRequestedWhileInFlight` に控え、その場の試行が決着した時点でまだ
 *   期限切れなら、新しい入力を待たずにもう一度だけ取り直す。
 */
import {
  shouldReacquireOnInput,
  shouldWarnIdle,
  uiStateFromAcquire,
  uiStateFromHeartbeat,
  uiStateFromSaveError,
  type AcquireResponse,
  type EditLockUiState,
  type HeartbeatResponse,
} from "./ui-state";
import { EDIT_LOCK_HEARTBEAT_INTERVAL_MS } from "./rules";

/**
 * acquire の失敗が「資源が消えた」(404 NOT_FOUND)を意味するか。
 * ⚠heartbeat は 404 を `{notFound:true}` に畳んで返す契約(api-client.ts)だが、
 *   acquire は仕様どおり 423 だけをデータとして返し、それ以外の非2xxはエラーとして
 *   投げる。ここでは api-client の実装には依存せず、deps 越しに届く Error が持つ
 *   分類コード(NOT_FOUND)だけを見て判定する(controller は fetch/HTTP を知らない)。
 */
function isResourceNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "NOT_FOUND";
}

export interface EditLockControllerDeps {
  acquire(): Promise<AcquireResponse>;
  heartbeat(active: boolean): Promise<HeartbeatResponse>;
  release(lockId: string): Promise<void>;
  releaseByBeacon(lockId: string): void;
  /** 状態が変わったら呼ばれる(hook は setState を渡す)。 */
  onState(state: EditLockUiState, warnIdle: boolean): void;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface EditLockController {
  acquire(): Promise<void>;
  release(): Promise<void>;
  noteActivity(): void;
  noteSaveError(code: string | null, holderName?: string | null): void;
  /** pagehide 相当。 */
  onHidden(): void;
  /** visibilitychange(表示に戻った)相当。 */
  onVisible(): void;
  dispose(): void;
  /**
   * `dispose()` を取り消す(横断レビュー C1)。**`dispose()` は終端ではない**。
   *
   * ⚠React StrictMode は effect を mount→cleanup→mount と二重に呼ぶが、
   *   `use-edit-lock.ts` が controller を持つ `useMemo` は effect の再実行では
   *   作り直されない。つまり cleanup の `dispose()` を受けた**同じインスタンス**へ
   *   2回目の mount が戻ってくる。戻す口が無いと、その後の `acquire()` は
   *   サーバが許可した鍵を `disposed` 判定で捨てて beacon で返し、`apply()` を
   *   通らないので `state` は `idle` のまま=帯も通知も出ないのに保存ボタンだけが
   *   永久に無効になる。
   * ⚠兄弟の `status-controller.ts` が `start()` の先頭で `stopped=false` に戻したのと
   *   同型の修理([[fix-all-call-sites-not-one]])。こちらは「取得」と「復帰」を
   *   混ぜないため、`start()` に相当する副作用は持たない専用の1手にした
   *   (窓口の呼び出しも合図も増やさない=呼び出し側の effect の先頭で無条件に
   *   呼んで安全)。
   */
  revive(): void;
}

export function createEditLockController(deps: EditLockControllerDeps): EditLockController {
  let state: EditLockUiState = { kind: "idle" };
  let lockId: string | null = null;
  let timerHandle: unknown = null;
  /** 前回の合図からの間に操作(noteActivity)があったか。合図のたびに false へ戻す。 */
  let activeSinceLastBeat = false;
  /** dispose 後は、遅れて解決した Promise の結果を一切反映しない。 */
  let disposed = false;
  /**
   * 「今の鍵の在任期」を表す世代番号。acquire/release/dispose の開始時と、非mine状態
   * (=喪失・解除・削除)への遷移のたびに進める。合図/取得はこれを投げる前に捕まえ、
   * 応答時に値がずれていたら(在任期が変わった)結果を捨てる。
   */
  let generation = 0;
  /**
   * ⚠(review round3 n7 / task5 持ち越し#1) 取得が既に飛んでいる間は、新しい取得を
   *   重ねて飛ばさない。以前は真偽値だけを持ち、飛んでいる間の呼び出しは即座に
   *   (何もせず)解決していたが、いま飛んでいる Promise 自体を持つことで、
   *   後から呼んだ acquire() もその決着を正しく待てるようにする。
   */
  let acquireInFlightPromise: Promise<void> | null = null;
  /** ⚠(task5 持ち越し#2) 飛んでいる間に来た入力を、その決着後の取り直し予約として控える。 */
  let reacquireRequestedWhileInFlight = false;

  function bumpGeneration(): void {
    generation += 1;
  }

  function stopHeartbeat(): void {
    if (timerHandle !== null) {
      deps.clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    timerHandle = deps.setInterval(() => {
      void beat();
    }, EDIT_LOCK_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 状態を確定し、hook へ伝える。⚠鍵を失った状態(mine 以外)になったら合図を止め、
   * 世代を進める(=このタイミングより前に投げた合図/取得の応答は、後で届いても捨てる)。
   */
  function apply(next: EditLockUiState): void {
    state = next;
    lockId = next.kind === "mine" ? next.lockId : null;
    if (next.kind !== "mine") {
      stopHeartbeat();
      bumpGeneration();
    }
    if (disposed) return;
    deps.onState(next, shouldWarnIdle(next, deps.now()));
  }

  async function beat(): Promise<void> {
    if (disposed || lockId === null) return;
    const gen = generation;
    const active = activeSinceLastBeat;
    activeSinceLastBeat = false;
    const currentLockId = lockId;
    let res: HeartbeatResponse;
    try {
      res = await deps.heartbeat(active);
    } catch {
      // ⚠(review round1 I1) 合図の失敗はネットワーク瞬断等の一過性として扱う。
      //   状態は変えず、間隔も止めない(サーバ側の鍵は無操作が続けば自然に期限切れになる)。
      // ⚠(review round2 n3) この合図が拾うはずだった入力(active)を消したままにしない。
      //   その後に立った true(=await中の新しい入力)を上書きしないよう OR で戻す。
      activeSinceLastBeat = activeSinceLastBeat || active;
      return;
    }
    // ⚠(review round1 C1) 応答が届くまでの間に release/dispose/別の合図の喪失判定が
    //   先に世代を進めていたら、この応答はもう「今の鍵」の話ではない=反映しない。
    if (disposed || gen !== generation) return;
    apply(uiStateFromHeartbeat(res, currentLockId));
  }

  function acquire(): Promise<void> {
    // ⚠(review round3 n7 / task5 持ち越し#1) 既に1本飛んでいるなら、新しく飛ばさず
    //   その Promise をそのまま返す(バーストの2本目以降は1本目に合流させる。
    //   1本目の応答が全体の結果を決める。かつ、呼び出し元は await すれば必ず
    //   決着まで待てる=何もせず空で解決することはない)。
    if (acquireInFlightPromise) return acquireInFlightPromise;
    const attempt = (async () => {
      bumpGeneration();
      const gen = generation;
      const res = await deps.acquire();
      const next = uiStateFromAcquire(res);
      if (disposed || gen !== generation) {
        // ⚠(review round2 n1) release/dispose がこの取得を追い越していた。state には
        //   今さら反映しない(discard は正しい)が、応答が mine ならサーバは実際に
        //   鍵を許可している=孤児にせず beacon で手放す(deps.release はヘッダ付きの
        //   fetch が要るが、dispose 後の画面ではもう安全に呼べない可能性がある。
        //   beacon はヘッダ不要でどちらの状況でも安全)。
        if (next.kind === "mine") deps.releaseByBeacon(next.lockId);
        return;
      }
      apply(next);
      if (state.kind === "mine") startHeartbeat();
    })();
    acquireInFlightPromise = attempt;
    // ⚠(task5 review round1 minor) この後始末は `attempt` の代入より**後**に登録する。
    //   `deps.acquire()` が同期的に投げた場合、async関数の本体(finallyでのクリア)は
    //   この代入より前にすべて実行されてしまい、その直後に代入が上書きして
    //   `acquireInFlightPromise` を「決着済みの Promise」に永久に固定してしまう
    //   (以後どの acquire() もその古い Promise を返すだけになり、二度と送られない)。
    //   ここでの登録はマイクロタスクとして後で走るため、この代入より確実に後に実行される。
    //   ⚠`.finally()` ではなく `.then(onFulfilled, onRejected)` を使う: `.finally()` が
    //   作る派生 Promise はここで何とも繋がず捨てるため、`attempt` が reject すると
    //   その派生 Promise 自身が「誰も拾わない reject」として unhandled rejection に
    //   なる(`attempt` 自体は呼び出し元の `.catch` が拾っていても関係ない・別物)。
    //   両方の分岐で例外を投げ直さない `.then` にすれば、この後始末専用の派生 Promise は
    //   常に解決し、二重に報告されない。今も自分が担当している attempt と一致する
    //   ときだけクリアする。
    const clearIfCurrent = () => {
      if (acquireInFlightPromise === attempt) acquireInFlightPromise = null;
    };
    attempt.then(clearIfCurrent, clearIfCurrent);
    return attempt;
  }

  async function release(): Promise<void> {
    const idToRelease = lockId;
    bumpGeneration();
    stopHeartbeat();
    apply({ kind: "idle" });
    if (idToRelease) await deps.release(idToRelease);
  }

  /**
   * 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す(管理者解除/削除はしない)。
   * ⚠(review round1 I1) 取り直しは fire-and-forget なので、失敗しても外へ投げない
   *   (次の入力でまた試みる。state は expired のまま留まる)。
   * ⚠(review round2 n2) ただし404(資源が消えた)だけは例外。一過性として無視すると
   *   「入力すれば自動で取り直す」と案内したまま、毎回404→黙殺を繰り返す無言の
   *   行き止まりになる。deleted にして取り直しを止める(shouldReacquireOnInput は
   *   deleted では true を返さない)のが正直な答え。
   * ⚠(review round3 n8) ただしこの404も、他の書き込み経路と同じ世代ガードに従う。
   *   取り直しを始める直前の世代を控え、acquire() 自身がその直後に1つ進める値
   *   (=genAtAttempt+1)と一致するとき(=この取り直しの間に他の出来事が起きて
   *   いない)だけ deleted を反映する。
   */
  function noteActivity(): void {
    activeSinceLastBeat = true;
    if (!shouldReacquireOnInput(state)) return;
    if (acquireInFlightPromise) {
      // ⚠(task5 持ち越し#2) 既に1本飛んでいる。この入力はその決着後の
      //   取り直し予約として控えるだけにする(新しい取得は飛ばさない=n7の直列化を保つ)。
      reacquireRequestedWhileInFlight = true;
      return;
    }
    attemptReacquireOnce();
  }

  /** `noteActivity` から1回だけ取得を試みる(飛んでいる間の入力は合流させ、二重に飛ばさない)。 */
  function attemptReacquireOnce(): void {
    const genAtAttempt = generation;
    acquire()
      .catch((err: unknown) => {
        if (isResourceNotFoundError(err) && generation === genAtAttempt + 1) {
          apply({ kind: "deleted" });
          return;
        }
        /* それ以外、または世代がずれていれば無視する。次の noteActivity で再試行される。 */
      })
      .finally(() => {
        // ⚠(task5 持ち越し#2) この試行が飛んでいる間に来た入力があり、決着した今も
        //   まだ期限切れなら、新しい入力を待たずにもう一度だけ取り直す。
        if (!disposed && reacquireRequestedWhileInFlight) {
          reacquireRequestedWhileInFlight = false;
          if (shouldReacquireOnInput(state)) attemptReacquireOnce();
        }
      });
  }

  function noteSaveError(code: string | null, holderName: string | null = null): void {
    const next = uiStateFromSaveError(code, holderName);
    if (next) apply(next);
  }

  function onHidden(): void {
    if (lockId) deps.releaseByBeacon(lockId);
  }

  function onVisible(): void {
    if (state.kind === "mine") void beat();
  }

  function dispose(): void {
    disposed = true;
    bumpGeneration();
    stopHeartbeat();
  }

  /**
   * ⚠`disposed` を戻すだけ(横断レビュー C1)。世代は進めない——`dispose()` が既に
   *   1つ進めており、ここで更に進めると、この復帰の**後**に呼ばれる `acquire()` が
   *   自分で進める分と合わせて何も守らない空回りになる。合図も張り直さない
   *   (鍵を持ち直すのは `acquire()` の仕事)。
   */
  function revive(): void {
    disposed = false;
  }

  return { acquire, release, noteActivity, noteSaveError, onHidden, onVisible, dispose, revive };
}
