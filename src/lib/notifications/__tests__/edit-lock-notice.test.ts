/**
 * 編集ロックの変わり目 → N1・N2(通知 段階1・設計書 §4.2)。
 */
import { describe, expect, it } from "vitest";
import { editLockLostBody, editLockNoticeEvent } from "../edit-lock-notice";

describe("editLockNoticeEvent", () => {
  it("55分の予告が立った瞬間だけ warn(続けて立っている間は出さない)", () => {
    expect(editLockNoticeEvent({ kind: "mine", warnIdle: false }, { kind: "mine", warnIdle: true })).toEqual({ type: "warn" });
    expect(editLockNoticeEvent({ kind: "mine", warnIdle: true }, { kind: "mine", warnIdle: true })).toBeNull();
  });

  it("持っていた鍵が外れたら lost と理由", () => {
    for (const kind of ["expired", "force_released", "taken", "deleted"] as const) {
      expect(editLockNoticeEvent({ kind: "mine", warnIdle: true }, { kind, warnIdle: false })).toEqual({ type: "lost", reason: kind });
    }
  });

  it("鍵を持っていなかった(閲覧中・取得できなかった)ときは知らせない", () => {
    expect(editLockNoticeEvent({ kind: "idle", warnIdle: false }, { kind: "taken", warnIdle: false })).toBeNull();
    expect(editLockNoticeEvent({ kind: "expired", warnIdle: false }, { kind: "force_released", warnIdle: false })).toBeNull();
    expect(editLockNoticeEvent({ kind: "mine", warnIdle: false }, { kind: "idle", warnIdle: false })).toBeNull();
  });

  it("文言に保持者の氏名を入れない(OS の通知にも出るため)", () => {
    for (const r of ["expired", "force_released", "taken", "deleted"] as const) {
      expect(editLockLostBody(r)).not.toMatch(/さん/);
    }
  });
});
