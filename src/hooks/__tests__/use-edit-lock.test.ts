/**
 * useEditLock の配線を source assertion で固定する(node 環境のため描画テスト不可
 * =このリポジトリは jsdom も renderHook も使わない方針)。
 * 振る舞いの核(取得→30秒ごとの合図/喪失での停止/期限切れの取り直し/
 * release・pagehide・visibilitychange の配線/世代ガード/noteSaveError)は
 * controller.test.ts で実検証する。
 *
 * ⚠(review round1 m4) 以前は整形済みソースの丸写し(`toContain('canSave: state.kind
 *   === "mine"')`)があり、reflow だけで意味なく壊れる作りだった。ここでは
 *   「そのキーを定義している行」を空白の揺れに強い正規表現で探す形に直し、
 *   cleanup の**順序**(onHidden → dispose)と removeEventListener の存在は
 *   明示的に固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/use-edit-lock.ts"), "utf8");

/** `key` を定義している行を、空白の揺れを許して1行分だけ切り出す(無ければ null)。 */
function findAssignmentLine(source: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:.*$`, "m");
  return source.match(re)?.[0] ?? null;
}

/**
 * `return { ... }` の中に、`key,` だけの行(shorthand プロパティ)があるか。
 * ⚠(review round2 n6) `state`/`warnIdle` は `key: value` ではなく `state,`
 *   のような shorthand で返している。`findAssignmentLine`(コロン必須)では
 *   拾えないので専用の判定を用意する。`\bkey\b` のような書き方は宣言・コメント
 *   にもヒットして削除しても失敗しない(vacuous)ため使わない。
 */
function returnsShorthandProperty(source: string, key: string): boolean {
  const returnStart = source.indexOf("return {");
  if (returnStart === -1) return false;
  const returnBlock = source.slice(returnStart, returnStart + 1200);
  return new RegExp(`^\\s*${key},\\s*$`, "m").test(returnBlock);
}

describe("useEditLock の配線", () => {
  it("client component 宣言がある", () => {
    expect(src).toMatch(/^["']use client["'];/m);
  });

  it("api-client の窓口5本のうち、鍵の生成に要る4本を controller の deps として渡す", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/api-client["']/);
    expect(src).toContain("acquireEditLockApi");
    expect(src).toContain("heartbeatEditLockApi");
    expect(src).toContain("releaseEditLockApi");
    expect(src).toContain("releaseEditLockByBeacon");
  });

  it("判断とタイマーは createEditLockController に集約する(自前で再実装しない)", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/edit-lock\/controller["']/);
    expect(src).toContain("createEditLockController");
  });

  it("(review round1 I5) controller は useEffect でなく useMemo で render 中に作る(子の先行effectでもnullにならない)", () => {
    expect(src).toMatch(/from\s+["']react["']/);
    const memoCallIndex = src.indexOf("useMemo(");
    expect(memoCallIndex).toBeGreaterThan(-1);
    const memoBlock = src.slice(memoCallIndex, memoCallIndex + 800);
    expect(memoBlock).toContain("createEditLockController");
    expect(memoBlock).toMatch(/\[\s*enabled\s*,\s*resourceType\s*,\s*resourceId\s*\]/);
  });

  it("(review round1 I5) enabled=false は controller を意図して null にする(事故ではなく仕様)", () => {
    expect(src).toMatch(/if\s*\(!enabled\)\s*return\s+null;/);
  });

  it("判断の純関数(ui-state)を直接は呼ばない=controller に委ねている", () => {
    // shouldReacquireOnInput/uiStateFromXxx を hook 自身が呼んでいたら判断の二重化
    expect(src).not.toContain("shouldReacquireOnInput");
    expect(src).not.toContain("uiStateFromAcquire");
    expect(src).not.toContain("uiStateFromHeartbeat");
    expect(src).not.toContain("shouldWarnIdle");
    // 合図の間隔定数も controller 側の定数を再利用するだけで、hook が値を持たない
    expect(src).not.toContain("EDIT_LOCK_HEARTBEAT_INTERVAL_MS");
  });

  it("他タブの複製検知の問い合わせに応答し続ける(answerScreenTokenProbes)", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/edit-lock\/screen-token-client["']/);
    expect(src).toContain("answerScreenTokenProbes");
  });

  it("(横断レビューM1) 問い合わせに答えるのは鍵を使う画面だけ(controllerが無い間はBroadcastChannelを開かない)", () => {
    // ⚠修理前は `enabled` を無視して無条件に張っていた。所有者カードは編集中でない
    //   間 `enabled=false`(controller=null)なので、所有者120人の物件では
    //   BroadcastChannel を120本開き、1回の who-has に120回答えていた
    //   (すべて docId で捨てられる=完全な無駄)。
    const callIdx = src.indexOf("answerScreenTokenProbes()");
    expect(callIdx).toBeGreaterThan(-1);
    const effectStart = src.lastIndexOf("useEffect(", callIdx);
    expect(effectStart).toBeGreaterThan(-1);
    const effectBlock = src.slice(effectStart, callIdx + 200);
    expect(effectBlock).toMatch(/if\s*\(!controller\)\s*return;/);
    expect(effectBlock).toMatch(/\}, \[controller\]\)/);
  });

  it("resourceType/resourceId/enabled を受け取る", () => {
    expect(src).toContain("resourceType");
    expect(src).toContain("resourceId");
    expect(src).toContain("enabled");
  });

  it("(review round1 I3) cleanupで onHidden() を dispose() より先に呼ぶ(鍵を手放してから破棄する)", () => {
    const onHiddenIndex = src.indexOf("controller.onHidden();");
    const disposeIndex = src.indexOf("controller.dispose();");
    expect(onHiddenIndex).toBeGreaterThan(-1);
    expect(disposeIndex).toBeGreaterThan(-1);
    expect(onHiddenIndex).toBeLessThan(disposeIndex);
  });

  it("(横断レビューC1) 同じeffectの本体の先頭で revive() を呼ぶ(cleanupのdispose()を取り消す=StrictModeの二重effectで死なない)", () => {
    // ⚠`useMemo` は effect の再実行では controller を作り直さないため、
    //   mount→cleanup→mount の2回目は dispose 済みの同じインスタンスを掴む。
    //   revive() を cleanup の**外**(effect本体の先頭)で呼ぶことが要件。
    //   兄弟の `status-controller.ts` が `start()` の先頭で `stopped` を戻したのと同型。
    const reviveIndex = src.indexOf("controller.revive();");
    const disposeIndex = src.indexOf("controller.dispose();");
    expect(reviveIndex).toBeGreaterThan(-1);
    expect(disposeIndex).toBeGreaterThan(-1);
    expect(reviveIndex).toBeLessThan(disposeIndex);
    // dispose を含む cleanup(`return () => {`)より前=effect本体側にあること。
    const cleanupStart = src.lastIndexOf("return () => {", disposeIndex);
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(reviveIndex).toBeLessThan(cleanupStart);
  });

  it("visibilitychange/pagehide のリスナーは、addしたのと同じ関数名でremoveする(unmount時に確実に外す)", () => {
    expect(src).toContain('addEventListener("visibilitychange", onVisible)');
    expect(src).toContain('removeEventListener("visibilitychange", onVisible)');
    expect(src).toContain('addEventListener("pagehide", onHide)');
    expect(src).toContain('removeEventListener("pagehide", onHide)');
  });

  it("visibilitychange/pagehide/破棄の配線は controller(useMemoの結果)の変化に追従する(依存配列を[enabled]だけに後退させない)", () => {
    // review round1: [enabled] だけに依存すると、resourceId が変わった後も
    // 古い controller を握ったままのイベントリスナーが残る(stale closure)。
    // 依存配列が [controller] であることを、cleanup・visibilitychange・pagehide の
    // 3本ぶん固定する。
    const occurrences = [...src.matchAll(/\},\s*\[controller\]\)/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it("acquire/release/noteActivity/noteSaveError/noteSaveErrorHolder を controller へそのまま委譲する", () => {
    // ⚠`noteSaveErrorHolder`(仕上げround2)も hook では判断せず素通しする
    //   (「takenの間だけ効かせる」判断は controller 側にある)。
    for (const k of ["acquire", "release", "noteActivity", "noteSaveError", "noteSaveErrorHolder"]) {
      expect(src).toContain(`controller?.${k}`);
    }
  });

  it("(仕上げround2) noteSaveErrorHolder を返り値として公開する(画面から呼べる)", () => {
    expect(returnsShorthandProperty(src, "noteSaveErrorHolder")).toBe(true);
  });

  it("canSave・lockId を公開する(整形の揺れに強い形で固定)", () => {
    expect(findAssignmentLine(src, "canSave")).toMatch(/state\.kind\s*===\s*"mine"/);
    expect(findAssignmentLine(src, "lockId")).toMatch(/state\.kind\s*===\s*"mine"/);
  });

  it("(review round2 n6) state・warnIdle を公開する(shorthandプロパティとして返している)", () => {
    // 以前は /\bwarnIdle\b/ / /\bstate\b/ で「削除しても失敗しない」vacuous な
    // アサーションだった(宣言・コメントにもヒットする)。return { ... } の中身を
    // 直接見て、shorthand の行が実在することを固定する。
    expect(returnsShorthandProperty(src, "state")).toBe(true);
    expect(returnsShorthandProperty(src, "warnIdle")).toBe(true);
  });
});
