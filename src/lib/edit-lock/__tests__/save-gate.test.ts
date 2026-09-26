/**
 * 保存可否の判断(決定層・`src/lib/edit-lock/save-gate.ts`)を node で検証する。
 *
 * ⚠Task 5(`property-edit-form.tsx`)が最初に切り出し、Task 6 fix round 1 #3 で
 *   ここへ移した(3つめの画面が component module 一式を巻き込まずに import
 *   できるようにするため)。テストの中身は移設のみで、内容は変えていない。
 */
import { describe, it, expect } from "vitest";
import {
  canSubmitSave,
  shouldShowLockUnavailableNotice,
  isEditLockHeldByOther,
  editLockUnavailableTitle,
} from "../save-gate";
import type { EditLockStatusRow } from "@/lib/api-client";

describe("canSubmitSave(保存ボタンを押せるかの判断)", () => {
  it("tokenReadyがfalseならcanSave/lockUnavailableに関わらず押せない", () => {
    expect(
      canSubmitSave({ tokenReady: false, canSave: true, saving: false, lockUnavailable: true }),
    ).toBe(false);
  });

  it("saving中は押せない", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: true, lockUnavailable: false }),
    ).toBe(false);
  });

  it("鍵を持っていれば押せる(通常経路)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: false, lockUnavailable: false }),
    ).toBe(true);
  });

  it("鍵を持っておらず取得も失敗していなければ押せない(他人が持っている等)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: false, saving: false, lockUnavailable: false }),
    ).toBe(false);
  });

  it("鍵は持っていないが取得自体が失敗していればfail openで押せる(review round1 Critical)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: false, saving: false, lockUnavailable: true }),
    ).toBe(true);
  });

  it("鍵を持っていて、かつlockUnavailableがtrueでも押せる(矛盾しない組み合わせ)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: false, lockUnavailable: true }),
    ).toBe(true);
  });
});

describe("shouldShowLockUnavailableNotice(fail open通知と実際の鍵の帯を矛盾させない・review round2 N3)", () => {
  it("lockUnavailableかつidleなら出す", () => {
    expect(shouldShowLockUnavailableNotice(true, "idle")).toBe(true);
  });

  it("lockUnavailableがfalseなら(状態に関わらず)出さない", () => {
    expect(shouldShowLockUnavailableNotice(false, "idle")).toBe(false);
  });

  it("lockUnavailableでも、状態がtakenへ動いたら出さない(実際の鍵の帯と矛盾させない)", () => {
    expect(shouldShowLockUnavailableNotice(true, "taken")).toBe(false);
  });

  it("lockUnavailableでも、状態がexpiredへ動いたら出さない", () => {
    expect(shouldShowLockUnavailableNotice(true, "expired")).toBe(false);
  });

  it("lockUnavailableでも、状態がmineへ動いたら出さない(取得できた=通常の帯に任せる)", () => {
    expect(shouldShowLockUnavailableNotice(true, "mine")).toBe(false);
  });

  it("lockUnavailableでも、状態がforce_releasedへ動いたら出さない(実際の鍵の帯と矛盾させない・task 7 fix)", () => {
    expect(shouldShowLockUnavailableNotice(true, "force_released")).toBe(false);
  });

  it("lockUnavailableでも、状態がdeletedへ動いたら出さない(実際の鍵の帯と矛盾させない・task 7 fix)", () => {
    expect(shouldShowLockUnavailableNotice(true, "deleted")).toBe(false);
  });
});

describe("isEditLockHeldByOther(見ている側・仕様6.3の表を1件ずつ固定)", () => {
  const row = (state: EditLockStatusRow["state"]): EditLockStatusRow => ({
    resourceType: "property",
    resourceId: "p1",
    state,
  });

  it("held_by_other は止める(物件が他の人の鍵)", () => {
    expect(isEditLockHeldByOther(row("held_by_other"))).toBe(true);
  });

  it("held_by_self_other_screen も止める(物件が自分の別の画面の鍵・D6)", () => {
    expect(isEditLockHeldByOther(row("held_by_self_other_screen"))).toBe(true);
  });

  it("mine は止めない(自分がこの画面で鍵を持っている)", () => {
    expect(isEditLockHeldByOther(row("mine"))).toBe(false);
  });

  it("free は止めない(空いた)", () => {
    expect(isEditLockHeldByOther(row("free"))).toBe(false);
  });

  it("行が届いていない(undefined)ときは止めない(fail open・未取得/権限なし)", () => {
    expect(isEditLockHeldByOther(undefined)).toBe(false);
  });
});

describe("editLockUnavailableTitle(review round1 Important 5: 帯と矛盾しない主語の出し分け)", () => {
  const row = (state: EditLockStatusRow["state"]): EditLockStatusRow => ({
    resourceType: "property",
    resourceId: "p1",
    state,
  });

  it("held_by_other は「他の利用者が編集中のため編集できません」", () => {
    expect(editLockUnavailableTitle(row("held_by_other"))).toBe(
      "他の利用者が編集中のため編集できません",
    );
  });

  it("held_by_self_other_screen は「あなたが別の画面で編集中のため編集できません」(帯の「あなたが別の画面で編集中です」と主語を揃える)", () => {
    expect(editLockUnavailableTitle(row("held_by_self_other_screen"))).toBe(
      "あなたが別の画面で編集中のため編集できません",
    );
  });
});
