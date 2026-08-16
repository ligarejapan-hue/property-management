import { describe, it, expect } from "vitest";
import {
  REACTION_STATUSES,
  TERMINAL_REACTIONS,
  REACTION_LABELS,
  isTerminalReaction,
  applySyncReaction,
  isRefusalProtected,
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

  it("(f) 同期undeliverable≧手動terminal——ただし手動refusedだけは保持する(2026-08-17仕様変更)", () => {
    // 旧規則は「手動refusedも上書きし退避する」だった。発注者指示(拒否の変更は管理者のみ)
    // により、同期が refused を undeliverable へ差し替えると縛りの根拠が消えるため、
    // **手動の拒否だけは同期に負けない**へ変更。除外効果はどちらも terminal で同じ。
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
    expect(next).toBe(manualRefused); // 参照ごと不変=書き込み自体が起きない

    // 手動undeliverable は従来どおり同期undeliverableで更新される(規則変更は refused のみ)。
    const manualUndeliv: ReactionFields = {
      reactionStatus: "undeliverable",
      reactedAt: T1,
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const next2 = applySyncReaction(manualUndeliv, { kind: "undeliverable", at: T2 });
    expect(next2.reactionSource).toBe("sale_dm_sync");
  });

  it("同期→同期の遷移(shadowなし)は最新の導出に従う(undeliverable→replied も置き換わる)", () => {
    const undeliv = applySyncReaction(virgin, { kind: "undeliverable", at: T1 });
    const next = applySyncReaction(undeliv, { kind: "replied", at: T2 });
    expect(next.reactionStatus).toBe("replied");
    expect(next.reactionSource).toBe("sale_dm_sync");
    expect(next.manualReactionShadow).toBeNull();
  });

  it("宛先不明→連絡ありの訂正は退避した手動repliedを復元する(隠れたまま失われない=#366 R1)", () => {
    // 手動replied → 同期undeliverableが退避 → 返戻訂正(ただしLP証拠は残る=replied導出)。
    // 弱いrepliedを被せず、先に手動値を復元して優先規則を適用し直す(手動replied>同期replied)。
    const stashed = applySyncReaction(manualReplied, {
      kind: "undeliverable",
      at: T2,
    });
    const next = applySyncReaction(stashed, { kind: "replied", at: T2 });
    expect(next).toEqual(manualReplied);
  });

  it("shadow が手動terminal(refused)なら復元されて同期repliedを退ける", () => {
    const manualRefused: ReactionFields = {
      reactionStatus: "refused",
      reactedAt: T1,
      reactionNote: "送らないでと連絡",
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const stashed = applySyncReaction(manualRefused, {
      kind: "undeliverable",
      at: T2,
    });
    const next = applySyncReaction(stashed, { kind: "replied", at: T2 });
    expect(next).toEqual(manualRefused);
  });

  it("shadow が手動no_responseなら復元後も同期repliedが勝つ(no_responseはブロックしない)", () => {
    const manualCleared: ReactionFields = {
      reactionStatus: "no_response",
      reactedAt: null,
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const stashed = applySyncReaction(manualCleared, {
      kind: "undeliverable",
      at: T1,
    });
    const next = applySyncReaction(stashed, { kind: "replied", at: T2 });
    expect(next.reactionStatus).toBe("replied");
    expect(next.reactionSource).toBe("sale_dm_sync");
    // 復元した手動no_responseは再退避される
    expect(next.manualReactionShadow).toEqual({
      status: "no_response",
      reactedAt: null,
      note: null,
    });
  });

  it("手動値がある状態の cleared は何もしない(手動の記録は同期の消失で消えない)", () => {
    const next = applySyncReaction(manualReplied, { kind: "cleared", at: T2 });
    expect(next).toBe(manualReplied);
  });

  it("素の no_response への cleared は no-op(同一参照)", () => {
    expect(applySyncReaction(virgin, { kind: "cleared", at: T2 })).toBe(virgin);
  });

  it("同値の同期の再適用は no-op(同一参照)=書込・ロックを省略できる冪等性", () => {
    const synced = applySyncReaction(virgin, { kind: "undeliverable", at: T2 });
    expect(
      applySyncReaction(synced, { kind: "undeliverable", at: new Date(T2) }),
    ).toBe(synced);
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

// 手動の「拒否」は同期 undeliverable にも負けない(発注者指示 2026-08-17)。
// 同期が undeliverable へ差し替えると reactionStatus が refused でなくなり、
// 「拒否の変更は管理者のみ」の縛りが自動処理経由で外れてしまう(提出前レビュー)。
describe("applySyncReaction: 手動refusedの保持", () => {
  it("manual refused は sync undeliverable に上書きされない", () => {
    const current = {
      reactionStatus: "refused",
      reactedAt: new Date("2026-08-01T00:00:00Z"),
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    } as never;
    const out = applySyncReaction(current, { kind: "undeliverable", at: new Date() } as never);
    expect(out).toBe(current);
  });

  it("manual replied は従来どおり sync undeliverable に負ける(優先規則は拒否だけ変更)", () => {
    const current = {
      reactionStatus: "replied",
      reactedAt: new Date("2026-08-01T00:00:00Z"),
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    } as never;
    const out = applySyncReaction(current, { kind: "undeliverable", at: new Date() } as never);
    expect((out as { reactionStatus: string }).reactionStatus).toBe("undeliverable");
  });
});

// 退避(shadow)された拒否も「守られた拒否」(@codex #385 R2 P1)。
describe("isRefusalProtected", () => {
  it("見えている refused / shadow の refused の両方で true", () => {
    expect(isRefusalProtected({ reactionStatus: "refused", manualReactionShadow: null })).toBe(true);
    expect(
      isRefusalProtected({
        reactionStatus: "undeliverable",
        manualReactionShadow: { status: "refused", reactedAt: null, note: null },
      }),
    ).toBe(true);
  });

  it("それ以外は false(壊れた shadow も false=施錠しすぎない)", () => {
    expect(isRefusalProtected({ reactionStatus: "replied", manualReactionShadow: null })).toBe(false);
    expect(
      isRefusalProtected({
        reactionStatus: "undeliverable",
        manualReactionShadow: { status: "replied", reactedAt: null, note: null },
      }),
    ).toBe(false);
    expect(isRefusalProtected({ reactionStatus: "no_response", manualReactionShadow: "壊れたJSON" })).toBe(false);
  });
});

// 退避された拒否は「見た目のままの訂正」では消さない(@codex #385 R3 P1)。
// 消してしまうと ①同status訂正でshadow消去 ②次に任意種別へ変更 の2手で拒否を外せる。
describe("applyManualReaction: 退避拒否の保持", () => {
  const shadowed: ReactionFields = {
    reactionStatus: "undeliverable",
    reactedAt: T1,
    reactionNote: null,
    reactionSource: "sale_dm_sync",
    manualReactionShadow: { status: "refused", reactedAt: T1.toISOString(), note: null },
  };

  it("同じ見た目(undeliverable)のまま日付を直しても shadow の拒否は残る", () => {
    const next = applyManualReaction(shadowed, {
      status: "undeliverable",
      reactedAt: T2,
      note: null,
    });
    expect(next.reactedAt).toBe(T2);
    expect(next.manualReactionShadow).toEqual(shadowed.manualReactionShadow);
    expect(isRefusalProtected(next)).toBe(true); // 2手目の抜け道が塞がっている
  });

  it("別種別へ書き換えるときは shadow を消す(その値が正になる=admin操作)", () => {
    const next = applyManualReaction(shadowed, { status: "replied", reactedAt: T2, note: null });
    expect(next.manualReactionShadow).toBeNull();
  });

  it("refused を明示保存したときも shadow は不要(見た目が拒否になる)", () => {
    const next = applyManualReaction(shadowed, { status: "refused", reactedAt: T2, note: null });
    expect(next.manualReactionShadow).toBeNull();
    expect(isRefusalProtected(next)).toBe(true);
  });

  it("拒否でない shadow は従来どおりクリア(規則変更は refused のみ)", () => {
    const other: ReactionFields = {
      ...shadowed,
      manualReactionShadow: { status: "replied", reactedAt: T1.toISOString(), note: null },
    };
    const next = applyManualReaction(other, { status: "undeliverable", reactedAt: T2, note: null });
    expect(next.manualReactionShadow).toBeNull();
  });
});

// 保存直後の再同期でも退避拒否は守られる(@codex #385 R4 P1)。
// 見た目 undeliverable + 退避 refused の旧データで、同status訂正→即再同期の連鎖。
describe("applySyncReaction: 退避拒否は同期undeliverableでも守る", () => {
  it("見た目 undeliverable + 退避 refused は sync undeliverable で不変(source 問わず)", () => {
    for (const source of ["manual", "sale_dm_sync"] as const) {
      const legacy: ReactionFields = {
        reactionStatus: "undeliverable",
        reactedAt: T1,
        reactionNote: null,
        reactionSource: source,
        manualReactionShadow: { status: "refused", reactedAt: T1.toISOString(), note: null },
      };
      const next = applySyncReaction(legacy, { kind: "undeliverable", at: T2 });
      expect(next, `source=${source}`).toBe(legacy);
      expect(isRefusalProtected(next)).toBe(true);
    }
  });

  it("2手の連鎖(同status訂正→再同期)を通しても保護が残る", () => {
    const legacy: ReactionFields = {
      reactionStatus: "undeliverable",
      reactedAt: T1,
      reactionNote: null,
      reactionSource: "sale_dm_sync",
      manualReactionShadow: { status: "refused", reactedAt: T1.toISOString(), note: null },
    };
    // ①非adminが許された「見た目のままの日付訂正」
    const afterManual = applyManualReaction(legacy, {
      status: "undeliverable",
      reactedAt: T2,
      note: null,
    });
    expect(isRefusalProtected(afterManual)).toBe(true);
    // ②保存直後の再同期(reaction route が呼ぶ)
    const afterSync = applySyncReaction(afterManual, { kind: "undeliverable", at: T2 });
    expect(isRefusalProtected(afterSync)).toBe(true); // ここが false だと2手目で外せる
  });

  it("退避が拒否でない行は従来どおり同期undeliverableで更新される", () => {
    const plain: ReactionFields = {
      reactionStatus: "no_response",
      reactedAt: null,
      reactionNote: null,
      reactionSource: "manual",
      manualReactionShadow: null,
    };
    const next = applySyncReaction(plain, { kind: "undeliverable", at: T2 });
    expect(next.reactionStatus).toBe("undeliverable");
    expect(next.reactionSource).toBe("sale_dm_sync");
  });
});
