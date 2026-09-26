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
import type { EditLockUiState } from "../ui-state";

const ALL_STATE_KINDS: EditLockUiState["kind"][] = [
  "idle",
  "mine",
  "expired",
  "force_released",
  "taken",
  "deleted",
];

describe("canSubmitSave(保存ボタンを押せるかの判断)", () => {
  it("tokenReadyがfalseならcanSave/lockUnavailableに関わらず押せない", () => {
    expect(
      canSubmitSave({
        tokenReady: false,
        canSave: true,
        saving: false,
        lockUnavailable: true,
        stateKind: "idle",
      }),
    ).toBe(false);
  });

  it("saving中は押せない", () => {
    expect(
      canSubmitSave({
        tokenReady: true,
        canSave: true,
        saving: true,
        lockUnavailable: false,
        stateKind: "mine",
      }),
    ).toBe(false);
  });

  it("鍵を持っていれば押せる(通常経路)", () => {
    expect(
      canSubmitSave({
        tokenReady: true,
        canSave: true,
        saving: false,
        lockUnavailable: false,
        stateKind: "mine",
      }),
    ).toBe(true);
  });

  it("鍵を持っておらず取得も失敗していなければ押せない(他人が持っている等)", () => {
    expect(
      canSubmitSave({
        tokenReady: true,
        canSave: false,
        saving: false,
        lockUnavailable: false,
        stateKind: "taken",
      }),
    ).toBe(false);
  });

  it("取得自体が失敗し、まだ誰も鍵を持っていない(idle)間はfail openで押せる(review round1 Critical)", () => {
    expect(
      canSubmitSave({
        tokenReady: true,
        canSave: false,
        saving: false,
        lockUnavailable: true,
        stateKind: "idle",
      }),
    ).toBe(true);
  });

  it("鍵を持っていて、かつlockUnavailableがtrueでも押せる(矛盾しない組み合わせ)", () => {
    expect(
      canSubmitSave({
        tokenReady: true,
        canSave: true,
        saving: false,
        lockUnavailable: true,
        stateKind: "mine",
      }),
    ).toBe(true);
  });

  /**
   * 横断レビュー I1。`lockUnavailable` は**取得が失敗して鍵が見られない**ことを表す旗
   * でしかない。取得の失敗後に保存が423で断られて状態が動いたら、帯は
   * 「この内容は保存できません」と出ているのに、この旗だけでボタンが押せたままに
   * なっていた(=画面が「保存できる」と言っているのに実際はできない、このブランチが
   * 2度潰した自己矛盾の3例目)。fail open が効くのは `idle` の間だけ。
   */
  describe("(I1) 取得が失敗した後に状態が動いたら、fail openの旗ではもう押せない", () => {
    for (const stateKind of ["taken", "force_released", "deleted", "expired"] as const) {
      it(`${stateKind} では押せない(帯が保存できない旨を出しているのと矛盾させない)`, () => {
        expect(
          canSubmitSave({
            tokenReady: true,
            canSave: false,
            saving: false,
            lockUnavailable: true,
            stateKind,
          }),
        ).toBe(false);
      });
    }
  });

  it("(I1) fail openの旗が効く条件は、通知を出す条件(shouldShowLockUnavailableNotice)と6つのkind全部で一致する", () => {
    // ⚠同じ条件を2か所に書かない。ボタンと通知が構造的に揃っていることを、
    //   状態の種類を1つ増やしても自動で守られる形で固定する。
    for (const stateKind of ALL_STATE_KINDS) {
      expect(
        canSubmitSave({
          tokenReady: true,
          canSave: false,
          saving: false,
          lockUnavailable: true,
          stateKind,
        }),
        `stateKind=${stateKind}`,
      ).toBe(shouldShowLockUnavailableNotice(true, stateKind));
    }
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
