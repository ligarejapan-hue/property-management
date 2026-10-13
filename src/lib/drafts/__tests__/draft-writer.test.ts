import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDraftWriter, DRAFT_WRITE_DELAY_MS } from "../draft-writer";
import { DRAFT_MAX_CHARS, draftKey } from "../draft-store";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

type D = { name: string };
const isEmpty = (d: D) => d.name === "";
const K = draftKey("new-property:properties");
let s: MemoryStorage;
const stored = () => {
  const raw = s.getItem(K);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  vi.useFakeTimers();
  s = installMemoryStorage();
});
afterEach(() => {
  vi.useRealTimers();
  uninstallStorage();
});

describe("createDraftWriter", () => {
  it("update は約1秒待ってから最後の値だけを書く", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, now: () => 42 });
    w.update({ name: "a" });
    w.update({ name: "ab" });
    expect(stored()).toBeNull();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
    expect(stored()).toEqual({ v: 1, savedAt: 42, data: { name: "ab" } });
  });
  it("flush は間引き中の最新をすぐ書く(移動の瞬間)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    expect(stored()?.data).toEqual({ name: "a" });
  });
  it("空の値は書かずに控えを消す", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    w.update({ name: "" });
    w.flush();
    expect(stored()).toBeNull();
  });
  it("close 後の update・flush は書かない(保存直後の unmount で書き戻さない)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.close();
    expect(stored()).toBeNull();
    w.update({ name: "b" });
    w.flush();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS * 2);
    expect(stored()).toBeNull();
  });
  it("discard は控えを消すが、その後の update はまた書く", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    w.discard();
    expect(stored()).toBeNull();
    w.flush();
    expect(stored()).toBeNull();
    w.update({ name: "c" });
    w.flush();
    expect(stored()?.data).toEqual({ name: "c" });
  });
  it("markSubmitting は印つきで即時に書く・unmarkSubmitting で外れる", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, now: () => 7 });
    w.update({ name: "a" });
    w.markSubmitting();
    expect(stored()).toEqual({ v: 1, savedAt: 7, data: { name: "a" }, pendingSubmit: { at: 7 } });
    w.unmarkSubmitting();
    expect(stored()).toEqual({ v: 1, savedAt: 7, data: { name: "a" } });
  });
  it("初めから送信中の印を持って始められる(復元した控えの印を保つ)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, initialPendingAt: 3, now: () => 9 });
    w.update({ name: "a" });
    w.flush();
    expect(stored()?.pendingSubmit).toEqual({ at: 3 });
  });
  it("大きすぎたら too_large を知らせ、以後は書かない", () => {
    const onResult = vi.fn();
    const w = createDraftWriter<D>({ key: K, isEmpty, onResult });
    w.update({ name: "x".repeat(DRAFT_MAX_CHARS) });
    w.flush();
    expect(onResult).toHaveBeenLastCalledWith("too_large");
    w.update({ name: "small" });
    w.flush();
    expect(stored()).toBeNull();
  });
  it("大きすぎて止まった後も、送信中の印だけは小さな控えで残す(二重登録を防ぐ・@codex P2)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, now: () => 5, compactForPending: () => ({ name: "" }) });
    w.update({ name: "x".repeat(DRAFT_MAX_CHARS) });
    w.flush();
    expect(stored()).toBeNull();
    w.markSubmitting();
    expect(stored()).toEqual({ v: 1, savedAt: 5, data: { name: "" }, pendingSubmit: { at: 5 } });
    w.flush();
    expect(stored()?.pendingSubmit).toEqual({ at: 5 });
    w.unmarkSubmitting();
    expect(stored()).toBeNull();
  });
  it("大きすぎた後に送信中になっても、小さくする方法が無ければ書かない", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "x".repeat(DRAFT_MAX_CHARS) });
    w.markSubmitting();
    expect(stored()).toBeNull();
  });
  it("一度も update していなければ flush は何もしない", () => {
    s.setItem(K, JSON.stringify({ v: 1, savedAt: 1, data: { name: "restored" } }));
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.flush();
    expect(stored()?.data).toEqual({ name: "restored" });
  });
});
