import { describe, it, expect } from "vitest";
import {
  REACTION_STATUSES,
  TERMINAL_REACTIONS,
  REACTION_LABELS,
  isTerminalReaction,
  applySyncReaction,
  applyManualReaction,
  type ReactionFields,
} from "../core";

// 反響の優先規則(設計§3): 同期undeliverable ≧ 手動terminal > 手動replied > 同期replied > no_response。
// 手動値を同期が上書きするときのみ shadow へ全量退避(R44)、訂正(cleared)で復元・消費。

const T1 = new Date("2026-08-01T03:00:00.000Z");
const T2 = new Date("2026-08-05T03:00:00.000Z");

const manualReplied: ReactionFields = {
  reactionStatus: "replied",
  reactedAt: T1,
  reactionNote: "電話あり",
  reactionSource: "manual",
  manualReactionShadow: null,
};

const virgin: ReactionFields = {
  reactionStatus: "no_response",
  reactedAt: null,
  reactionNote: null,
  reactionSource: null,
  manualReactionShadow: null,
};

describe("反響の定数", () => {
  it("allowlist は4種・terminal は refused/undeliverable", () => {
    expect(REACTION_STATUSES).toEqual([
      "no_response",
      "replied",
      "refused",
      "undeliverable",
    ]);
    expect([...TERMINAL_REACTIONS].sort()).toEqual([
      "refused",
      "undeliverable",
    ]);
    expect(isTerminalReaction("refused")).toBe(true);
    expect(isTerminalReaction("undeliverable")).toBe(true);
    expect(isTerminalReaction("replied")).toBe(false);
    expect(isTerminalReaction(null)).toBe(false);
    expect(isTerminalReaction(undefined)).toBe(false);
  });

  it("表示ラベル(平易な日本語)", () => {
    expect(REACTION_LABELS.no_response).toBe("反応なし");
    expect(REACTION_LABELS.replied).toBe("連絡あり");
    expect(REACTION_LABELS.refused).toBe("拒否");
    expect(REACTION_LABELS.undeliverable).toBe("宛先不明");
  });
});

describe("applySyncReaction(同期イベントの適用)", () => {
  it("(a) 同期undeliverableは手動repliedを上書きし、手動値を shadow へ全量退避する", () => {
    const next = applySyncReaction(manualReplied, {
      kind: "undeliverable",
      at: T2,
    });
    expect(next.reactionStatus).toBe("undeliverable");
    expect(next.reactedAt).toEqual(T2);
    expect(next.reactionNote).toBeNull();
    expect(next.reactionSource).toBe("sale_dm_sync");
    expect(next.manualReactionShadow).toEqual({
      status: "replied",
      reactedAt: T1.toISOString(),
      note: "電話あり",
    });
  });

  it("(b) 訂正(cleared)で shadow から復元(source=manual)・shadow は消費される", () => {
    const overwritten = applySyncReaction(manualReplied, {
      kind: "undeliverable",
      at: T2,
    });
    const restored = applySyncReaction(overwritten, { kind: "cleared", at: T2 });
    expect(restored.reactionStatus).toBe("replied");
    expect(restored.reactedAt).toEqual(T1);
    expect(restored.reactionNote).toBe("電話あり");
    expect(restored.reactionSource).toBe("manual");
    expect(restored.manualReactionShadow).toBeNull();
  });

  it("(c) shadow なしの cleared は素の no_response へ戻す", () => {
    const synced = applySyncReaction(virgin, { kind: "replied", at: T2 });
    const cleared = applySyncReaction(synced, { kind: "cleared", at: T2 });
    expect(cleared).toEqual(virgin);
  });

  it("(d) 手動terminalは同期repliedに勝つ(上書きされず同一参照が返る)", () => {
    const manualRefused: ReactionFields = {
      ...manualReplied,
      reactionStatus: "refused",
      reactionNote: "送らないでと連絡",
    };
    const next = applySyncReaction(manualRefused, { kind: "replied", at: T2 });
    expect(next).toBe(manualRefused);
  });

  it("手動repliedも同期repliedに勝つ(手動実反響は同期repliedで置き換えない)", () => {
    const next = applySyncReaction(manualReplied, { kind: "replied", at: T2 });
    expect(next).toBe(manualReplied);
  });

  it("手動no_responseは同期をブロックしない(draft側に証拠があれば戻る=R32/R40)", () => {
    const manualCleared: ReactionFields = {
      reactionStatus: "no_response",
      reactedAt: null,
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const next = applySyncReaction(manualCleared, { kind: "replied", at: T2 });
    expect(next.reactionStatus).toBe("replied");
    expect(next.reactionSource).toBe("sale_dm_sync");
    // 手動no_responseも上書き時は退避される(訂正の戻しで手動の消去意思を復元)
    expect(next.manualReactionShadow).toEqual({
      status: "no_response",
      reactedAt: null,
      note: null,
    });
  });

  it("(f) 同期undeliverable≧手動terminal: 手動refusedも上書きし退避する", () => {
    const manualRefused: ReactionFields = {
      reactionStatus: "refused",
      reactedAt: T1,
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const next = applySyncReaction(manualRefused, {
      kind: "undeliverable",
      at: T2,
    });
    expect(next.reactionStatus).toBe("undeliverable");
    expect(next.reactionSource).toBe("sale_dm_sync");
    expect(next.manualReactionShadow).toEqual({
      status: "refused",
      reactedAt: T1.toISOString(),
      note: null,
    });
  });

  it("同期→同期の遷移は最新の導出に従う(undeliverable→replied も置き換わる・shadowは保持)", () => {
    const stashed = applySyncReaction(manualReplied, {
      kind: "undeliverable",
      at: T2,
    });
    const next = applySyncReaction(stashed, { kind: "replied", at: T2 });
    expect(next.reactionStatus).toBe("replied");
    expect(next.reactionSource).toBe("sale_dm_sync");
    // 退避済みの手動値は温存(後の cleared で復元できる)
    expect(next.manualReactionShadow).toEqual(stashed.manualReactionShadow);
  });

  it("手動値がある状態の cleared は何もしない(手動の記録は同期の消失で消えない)", () => {
    const next = applySyncReaction(manualReplied, { kind: "cleared", at: T2 });
    expect(next).toBe(manualReplied);
  });

  it("素の no_response への cleared は no-op(同一参照)", () => {
    expect(applySyncReaction(virgin, { kind: "cleared", at: T2 })).toBe(virgin);
  });

  it("壊れた shadow(不正な形)は無視して素へ戻す(fail-closed)", () => {
    const broken: ReactionFields = {
      reactionStatus: "undeliverable",
      reactedAt: T2,
      reactionNote: null,
      reactionSource: "sale_dm_sync",
      manualReactionShadow: { status: "invalid_status", note: 42 },
    };
    const cleared = applySyncReaction(broken, { kind: "cleared", at: T2 });
    expect(cleared).toEqual(virgin);
  });
});

describe("applyManualReaction(手動保存の適用)", () => {
  it("(e) 手動保存は常に受理され、shadow はクリアされる", () => {
    const stashed = applySyncReaction(manualReplied, {
      kind: "undeliverable",
      at: T2,
    });
    const next = applyManualReaction(stashed, {
      status: "refused",
      reactedAt: T2,
      note: "文書で拒否",
    });
    expect(next).toEqual({
      reactionStatus: "refused",
      reactedAt: T2,
      reactionNote: "文書で拒否",
      reactionSource: "manual",
      manualReactionShadow: null,
    });
  });

  it("手動 no_response(消す)も受理される", () => {
    const next = applyManualReaction(manualReplied, {
      status: "no_response",
      reactedAt: null,
      note: null,
    });
    expect(next.reactionStatus).toBe("no_response");
    expect(next.reactionSource).toBe("manual");
    expect(next.manualReactionShadow).toBeNull();
  });
});
