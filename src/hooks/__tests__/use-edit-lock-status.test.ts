/**
 * useEditLockStatus の配線を source assertion で固定する(node 環境のため描画テスト不可
 * =このリポジトリは jsdom も renderHook も使わない方針)。
 * 振る舞いの核(周期・isHiddenでの休止・50件分割・stale破棄・refresh)は
 * status-controller.test.ts で実検証する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/use-edit-lock-status.ts"), "utf8");

/** `return { ... }` の中に、`key,` だけの行(shorthand プロパティ)があるか。 */
function returnsShorthandProperty(source: string, key: string): boolean {
  const returnStart = source.lastIndexOf("return {");
  if (returnStart === -1) return false;
  const returnBlock = source.slice(returnStart, returnStart + 400);
  return new RegExp(`^\\s*${key},\\s*$`, "m").test(returnBlock);
}

describe("useEditLockStatus の配線", () => {
  it("client component 宣言がある", () => {
    expect(src).toMatch(/^["']use client["'];/m);
  });

  it("api-client の fetchEditLockStatus を controller の fetchStatus として渡す", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/api-client["']/);
    expect(src).toContain("fetchEditLockStatus");
    expect(src).toMatch(/fetchStatus:\s*fetchEditLockStatus,/);
  });

  it("周期・分割・staleの破棄は createEditLockStatusController に集約する(自前で再実装しない)", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/edit-lock\/status-controller["']/);
    expect(src).toContain("createEditLockStatusController");
    // 判断の純関数(findEditLockStatusRow)を直接持ち込むだけで、自前のfindを書かない。
    expect(src).toContain("findEditLockStatusRow");
  });

  it("controller は useMemo で render 中に作る(子の先行effectでもnullにならない)", () => {
    expect(src).toMatch(/from\s+["']react["']/);
    const memoCallIndex = src.indexOf("useMemo(");
    expect(memoCallIndex).toBeGreaterThan(-1);
    const memoBlock = src.slice(memoCallIndex, memoCallIndex + 500);
    expect(memoBlock).toContain("createEditLockStatusController");
    expect(memoBlock).toMatch(/\[\s*enabled\s*\]/);
  });

  it("enabled=false は controller を意図して null にする(事故ではなく仕様)", () => {
    expect(src).toMatch(/if\s*\(!enabled\)\s*return\s+null;/);
  });

  it("isHidden は document.visibilityState を見る(deps越しにDOMへ触れる唯一の場所)", () => {
    expect(src).toMatch(/function isHidden\(\):\s*boolean\s*\{\s*return\s+document\.visibilityState\s*===\s*["']hidden["'];/);
  });

  it("setInterval/clearInterval はwindowのタイマーへ委譲する", () => {
    expect(src).toMatch(/setInterval:\s*\(fn,\s*ms\)\s*=>\s*window\.setInterval\(fn,\s*ms\)/);
    expect(src).toMatch(/clearInterval:\s*\(handle\)\s*=>\s*window\.clearInterval\(/);
  });

  it("resourcesとenabledを受け取る", () => {
    expect(src).toMatch(/export function useEditLockStatus\(\s*resources:/);
    expect(src).toContain("enabled");
  });

  it("controllerが変わる(enabled切替・unmount)たびにstop()する(cleanup)。この効果の依存配列は[controller]である(review round1 Minor 11)", () => {
    const idx = src.indexOf("controller.stop();");
    expect(idx).toBeGreaterThan(-1);
    // ⚠修理前はこの効果の依存配列そのものを検査しておらず、`[controller]`を
    //   `[]`に変えても(=enabledが変わってもcleanupが走らなくなり、間隔が
    //   漏れる)全14件のテストがgreenのままだった。effect本体の直後を固定する。
    const after = src.slice(idx, idx + 200);
    expect(after).toMatch(/\},\s*\[controller\]\)/);
  });

  it("enabled=false(controller=null)の間はrowsを空にする(effectでsetStateし直さず、render中に導出する)", () => {
    // ⚠react-hooks/set-state-in-effect: enabled=falseへ切り替わったcleanup/effectの
    //   中でsetRows([])を呼ぶと、それ自体がカスケード再描画になりESLintで弾かれる。
    //   代わりに`controller`の有無からrender中に導出する(effectでの後始末はしない)。
    expect(src).toMatch(
      /const effectiveRows = useMemo\(\(\) => \(controller \? rows : \[\]\), \[controller, rows\]\);/,
    );
    expect(src).toMatch(/rows:\s*effectiveRows,/);
  });

  it("このcontrollerに対して初めてのときだけstart()を呼び、以後はsetResources()で差し替える(開いたときの1回をstale判定で握りつぶさない)", () => {
    expect(src).toMatch(/startedControllerRef\.current\s*!==\s*controller/);
    expect(src).toMatch(/controller\.start\(resources\)/);
    expect(src).toMatch(/controller\.setResources\(resources\)/);
  });

  it("start/setResourcesの出し分けはcontroller・resourcesの変化に追従する([controller, resources]依存)", () => {
    const idx = src.indexOf("controller.start(resources)");
    expect(idx).toBeGreaterThan(-1);
    // その effect の依存配列が [controller, resources] であることを直後で固定する。
    const after = src.slice(idx, idx + 300);
    expect(after).toMatch(/\},\s*\[controller,\s*resources\]\)/);
  });

  it("refresh()はcontrollerへそのまま委譲する", () => {
    expect(src).toMatch(/controller\?\.refresh\(\)/);
  });

  it("裏から戻ったら(visibilitychange)即座にrefresh()する(review round1 Minor 15)", () => {
    expect(src).toMatch(/addEventListener\("visibilitychange", onVisible\)/);
    expect(src).toMatch(/removeEventListener\("visibilitychange", onVisible\)/);
    const idx = src.indexOf('const onVisible = () => {');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 150);
    // ⚠隠れている間(visibilityState==="hidden")は呼ばない(isHiddenの意図と揃える)。
    expect(block).toMatch(/document\.visibilityState !== "hidden"/);
    expect(block).toContain("controller.refresh()");
  });

  it("byKey・refresh・rowsを公開する", () => {
    // ⚠rowsはenabled=falseの導出(effectiveRows)を返すため`rows: effectiveRows,`
    //   という通常のプロパティになる(shorthandではない)。refresh/byKeyはshorthand。
    const returnStart = src.lastIndexOf("return {");
    expect(returnStart).toBeGreaterThan(-1);
    const returnBlock = src.slice(returnStart, returnStart + 200);
    expect(returnBlock).toMatch(/^\s*rows:\s*effectiveRows,\s*$/m);
    expect(returnsShorthandProperty(src, "refresh")).toBe(true);
    expect(returnsShorthandProperty(src, "byKey")).toBe(true);
  });
});
