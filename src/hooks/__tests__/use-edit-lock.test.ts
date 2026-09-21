/**
 * useEditLock の配線を source assertion で固定する(node 環境のため描画テスト不可
 * =このリポジトリは jsdom も renderHook も使わない方針)。
 * 振る舞いの核(取得→30秒ごとの合図/喪失での停止/期限切れの取り直し/
 * release・pagehide・visibilitychange の配線)は controller.test.ts で実検証する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/use-edit-lock.ts"), "utf8");

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
    expect(src).toContain("controllerRef");
    expect(src).toContain("useRef");
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

  it("resourceType/resourceId/enabled を受け取り、変化時に controller を作り直す", () => {
    expect(src).toContain("resourceType");
    expect(src).toContain("resourceId");
    expect(src).toContain("enabled");
  });

  it("unmount/依存変化のたびに dispose する(タイマーの多重生成を防ぐ)", () => {
    expect(src).toContain("controller.dispose()");
  });

  it("pagehide では onHidden(beacon)、visibilitychange では onVisible(即時合図)を呼ぶ", () => {
    expect(src).toContain("pagehide");
    expect(src).toContain("visibilitychange");
    expect(src).toContain("onHidden");
    expect(src).toContain("onVisible");
  });

  it("acquire/release/noteActivity/noteSaveError を controller へそのまま委譲する", () => {
    for (const k of ["acquire", "release", "noteActivity", "noteSaveError"]) {
      expect(src).toContain(`controllerRef.current?.${k}`);
    }
  });

  it("state・canSave・warnIdle・lockId を公開する", () => {
    expect(src).toContain("canSave: state.kind === \"mine\"");
    expect(src).toContain("warnIdle");
    expect(src).toContain('lockId: state.kind === "mine" ? state.lockId : null');
  });
});
