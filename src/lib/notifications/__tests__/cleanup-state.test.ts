/**
 * 共用 PC の後片付けの「切り替えの世代」(通知 段階1・設計書 §4.5)と、
 * 同じ規則を持つ public/sw.js の突き合わせ。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLEANUP_IDS_MAX,
  CLEANUP_IDS_TTL_MS,
  applyCleanup,
  emptyCleanupState,
  normalizeCleanupState,
} from "../cleanup-state";

describe("applyCleanup", () => {
  it("新しい cleanupId なら世代を上げて記録する", () => {
    const r = applyCleanup(emptyCleanupState(), "A", 1000);
    expect(r.changed).toBe(true);
    expect(r.state.gen).toBe(1);
    expect(r.state.cleanupIds).toEqual([{ id: "A", at: 1000 }]);
  });

  it("同じ cleanupId(遅れて届いた元の依頼)は何もしない", () => {
    const a = applyCleanup(emptyCleanupState(), "A", 1000).state;
    const again = applyCleanup(a, "A", 2000);
    expect(again.changed).toBe(false);
    expect(again.state.gen).toBe(1);
  });

  it("A の直接の後片付け → B → 遅れて A の順でも、A は何もしない(最後の1つだけで判定しない)", () => {
    let s = applyCleanup(emptyCleanupState(), "A", 1000).state;
    s = applyCleanup(s, "B", 2000).state;
    const late = applyCleanup(s, "A", 3000);
    expect(late.changed).toBe(false);
    expect(late.state.gen).toBe(2);
  });

  it("2つのログイン画面が同時に後片付けしても、それぞれ別の世代になる", () => {
    const s1 = applyCleanup(emptyCleanupState(), "X", 1000).state;
    const s2 = applyCleanup(s1, "Y", 1000).state;
    expect([s1.gen, s2.gen]).toEqual([1, 2]);
  });

  it(`1日を過ぎたもの・${CLEANUP_IDS_MAX}件を超えた古いものから捨てる`, () => {
    let s = emptyCleanupState();
    for (let i = 0; i < CLEANUP_IDS_MAX + 5; i++) s = applyCleanup(s, `id${i}`, 1000 + i).state;
    expect(s.cleanupIds).toHaveLength(CLEANUP_IDS_MAX);
    expect(s.cleanupIds[0].id).toBe("id5");
    const later = applyCleanup(s, "new", 1000 + CLEANUP_IDS_TTL_MS + 10_000).state;
    expect(later.cleanupIds.map((x) => x.id)).toEqual(["new"]);
  });

  it("壊れた保存値は空として扱う", () => {
    expect(normalizeCleanupState(null)).toEqual(emptyCleanupState());
    expect(normalizeCleanupState({ gen: "x", cleanupIds: [1, { id: 2 }] })).toEqual(emptyCleanupState());
  });
});

describe("public/sw.js が同じ規則を持つ", () => {
  const sw = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8");

  it("処理済みの一覧の上限・保持期間が同じ", () => {
    expect(sw).toMatch(new RegExp(`CLEANUP_IDS_MAX\\s*=\\s*${CLEANUP_IDS_MAX}\\b`));
    expect(sw).toContain("CLEANUP_IDS_TTL_MS = 24 * 60 * 60 * 1000");
    expect(CLEANUP_IDS_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("ページの読み込みを横取りしない(fetch を扱わない)", () => {
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
  });

  it("表示と後片付けを1本の順番待ちに並べ、失敗しても列を止めない", () => {
    expect(sw).toMatch(/queue\s*=\s*p\.catch\(/);
    expect(sw).toMatch(/data\.type === "show"[\s\S]*enqueue\(/);
    expect(sw).toMatch(/data\.type === "cleanup"[\s\S]*enqueue\(/);
  });

  it("世代の違う表示依頼は出さず、表示のあとで世代を読み直して古ければ閉じる", () => {
    expect(sw).toMatch(/data\.gen !== state\.gen/);
    expect(sw).toMatch(/showNotification[\s\S]*const after = await readState\(\)[\s\S]*after\.gen !== state\.gen[\s\S]*\.close\(\)/);
  });

  it("押したときは同じオリジンのパスだけ開く", () => {
    expect(sw).toMatch(/function safePath[\s\S]*startsWith\("\/"\)[\s\S]*startsWith\("\/\/"\)/);
  });
});
