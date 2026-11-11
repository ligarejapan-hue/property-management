import { describe, it, expect, vi, beforeEach } from "vitest";

const { afterFn, build, refresh } = vi.hoisted(() => ({ afterFn: vi.fn(), build: vi.fn(), refresh: vi.fn() }));
vi.mock("next/server", () => ({ after: afterFn }));
vi.mock("../create-draft", () => ({ buildAppraisalDraft: build }));
vi.mock("../map/refresh", () => ({ refreshDeckMap: refresh }));

import { scheduleAppraisalDraft } from "../schedule";

const IN = { attachmentId: "a1", propertyId: "p1", userId: "u1" };

beforeEach(() => vi.clearAllMocks());

describe("scheduleAppraisalDraft(添付の応答のあとで下書きを作る)", () => {
  it("下書きができたら、続けて周辺地図を作る(自動=地図がまだないときだけ)・作れなければ地図は作らない(2026-11-11)", async () => {
    build.mockResolvedValueOnce({ ok: true, deckId: "d1", created: true });
    scheduleAppraisalDraft(IN);
    await afterFn.mock.calls[0][0]();
    expect(refresh).toHaveBeenCalledWith({ deckId: "d1", propertyId: "p1", userId: "u1", mode: "auto" });
    refresh.mockClear();
    build.mockResolvedValueOnce({ ok: false, reason: "not_sre" });
    scheduleAppraisalDraft(IN);
    await afterFn.mock.calls[1][0]();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("地図を作れなくても投げない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build.mockResolvedValueOnce({ ok: true, deckId: "d1", created: true });
    refresh.mockRejectedValueOnce(new Error("x"));
    scheduleAppraisalDraft(IN);
    await expect(afterFn.mock.calls[0][0]()).resolves.toBeUndefined();
    warn.mockRestore();
  });
  it("応答のあと(after)で作る=添付の応答を待たせない", async () => {
    scheduleAppraisalDraft(IN);
    expect(build).not.toHaveBeenCalled();
    await afterFn.mock.calls[0][0]();
    expect(build).toHaveBeenCalledWith(IN);
  });
  it("作れなくても投げない(添付は成立したまま)・ログに数字や場所を出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build.mockRejectedValueOnce(new Error("東京都架空区見本町4丁目26-8"));
    scheduleAppraisalDraft(IN);
    await expect(afterFn.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("見本町");
    warn.mockRestore();
  });
  it("読み取りが混んでいたら(busy)待ってやり直す・ほかの失敗はやり直さない", async () => {
    vi.useFakeTimers();
    build
      .mockResolvedValueOnce({ ok: false, reason: "busy" })
      .mockResolvedValueOnce({ ok: true, deckId: "d1", created: true });
    scheduleAppraisalDraft(IN);
    const p = afterFn.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(build).toHaveBeenCalledTimes(2);
    build.mockReset();
    build.mockResolvedValue({ ok: false, reason: "not_sre" });
    scheduleAppraisalDraft(IN);
    await afterFn.mock.calls[1][0]();
    expect(build).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("リクエストの外で after が使えなくても投げない", () => {
    afterFn.mockImplementationOnce(() => {
      throw new Error("outside request scope");
    });
    expect(() => scheduleAppraisalDraft(IN)).not.toThrow();
  });
});
