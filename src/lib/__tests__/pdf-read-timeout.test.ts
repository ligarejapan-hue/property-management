/**
 * 時間切れで打ち切ったが裏でまだ続いている読み取りの数え方(@codex #681)。
 */
import { describe, it, expect } from "vitest";
import { hasPendingTimedOutPdfRead, trackTimedOutPdfRead } from "../pdf-read-timeout";

describe("時間切れの読み取りの数え方", () => {
  it("終わるまでは続いている・終われば(失敗でも)数えない", async () => {
    let finish!: () => void;
    let fail!: (e: unknown) => void;
    trackTimedOutPdfRead(new Promise<void>((r) => (finish = r)));
    trackTimedOutPdfRead(new Promise<void>((_, j) => (fail = j)));
    expect(hasPendingTimedOutPdfRead()).toBe(true);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(hasPendingTimedOutPdfRead()).toBe(true);
    fail(new Error("x"));
    await Promise.resolve();
    await Promise.resolve();
    expect(hasPendingTimedOutPdfRead()).toBe(false);
  });

  it("10分より古いものは数えない(終わらない読み取りで比べが止まり続けない)", () => {
    const t0 = 1_000_000;
    trackTimedOutPdfRead(new Promise(() => {}), t0);
    expect(hasPendingTimedOutPdfRead(t0 + 9 * 60_000)).toBe(true);
    expect(hasPendingTimedOutPdfRead(t0 + 10 * 60_000)).toBe(false);
  });
});
