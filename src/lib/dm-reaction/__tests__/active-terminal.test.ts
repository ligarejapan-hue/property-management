import { describe, it, expect } from "vitest";
import {
  activeTerminalLogWhere,
  activeUndeliverableLogWhere,
  clearedFieldsOnReactionWrite,
  isActiveTerminalLog,
  isClearableUndeliverableLog,
  selfExcludingLogWhere,
} from "@/lib/dm-reaction/core";

/**
 * 宛先不明の解除(2026-11-13 発注者決定)。
 * 所有者の登記上の住所を替えたとき、古い住所あての「宛先不明」を、送付対象から外す理由に数えない。
 * ⚠「一度お断りをいただいた方へもう一度手紙が作られる」は業務上いちばん避けたい間違い=
 *   拒否(refused)は、解除の印が付いていても**必ず**外す対象のまま。
 */
const at = new Date("2026-11-13T00:00:00Z");

describe("isActiveTerminalLog(送付対象から外す理由になる記録か)", () => {
  it("拒否・宛先不明は外す対象", () => {
    expect(isActiveTerminalLog({ reactionStatus: "refused", undeliverableClearedAt: null })).toBe(true);
    expect(isActiveTerminalLog({ reactionStatus: "undeliverable", undeliverableClearedAt: null })).toBe(true);
  });

  it("解除した宛先不明は外す対象にしない", () => {
    expect(isActiveTerminalLog({ reactionStatus: "undeliverable", undeliverableClearedAt: at })).toBe(false);
  });

  it("⚠拒否は、解除の印が付いていても外す対象のまま(印を理由に拒否を解かない)", () => {
    expect(isActiveTerminalLog({ reactionStatus: "refused", undeliverableClearedAt: at })).toBe(true);
  });

  it("反応なし・連絡ありは外す対象ではない", () => {
    expect(isActiveTerminalLog({ reactionStatus: "no_response", undeliverableClearedAt: null })).toBe(false);
    expect(isActiveTerminalLog({ reactionStatus: "replied", undeliverableClearedAt: null })).toBe(false);
  });
});

describe("where の断片(DB で同じ判定をする)", () => {
  it("外す対象=拒否(印に関係なく) または 解除していない宛先不明", () => {
    expect(activeTerminalLogWhere()).toEqual({
      OR: [
        { reactionStatus: "refused" },
        { reactionStatus: "undeliverable", undeliverableClearedAt: null },
      ],
    });
  });

  it("その物件の記録で再送の候補から外す反響=上に「連絡あり」を足したもの", () => {
    expect(selfExcludingLogWhere()).toEqual({
      OR: [
        { reactionStatus: { in: ["refused", "replied"] } },
        { reactionStatus: "undeliverable", undeliverableClearedAt: null },
      ],
    });
  });

  it("残っている宛先不明(物件の宛先不明の印の数え直しに使う)", () => {
    expect(activeUndeliverableLogWhere()).toEqual({
      reactionStatus: "undeliverable",
      undeliverableClearedAt: null,
    });
  });

  it("毎回新しいオブジェクトを返す(呼び出し側が足しても、ほかの呼び出しに漏れない)", () => {
    expect(activeTerminalLogWhere()).not.toBe(activeTerminalLogWhere());
  });
});

describe("clearedFieldsOnReactionWrite(反響を書くときに、解除の印をどうするか)", () => {
  const reset = { undeliverableClearedAt: null, undeliverableClearedBy: null };

  it("宛先不明のまま(日付・メモの訂正)なら印に触らない", () => {
    expect(clearedFieldsOnReactionWrite("undeliverable", "undeliverable")).toEqual({});
  });

  it("宛先不明から別の反響へ変えたら印を消す", () => {
    expect(clearedFieldsOnReactionWrite("undeliverable", "replied")).toEqual(reset);
    expect(clearedFieldsOnReactionWrite("undeliverable", "refused")).toEqual(reset);
    expect(clearedFieldsOnReactionWrite("undeliverable", "no_response")).toEqual(reset);
  });

  it("⚠別の反響から宛先不明になったら印を消す(新しい住所でまた戻ってきたら、また外す)", () => {
    expect(clearedFieldsOnReactionWrite("no_response", "undeliverable")).toEqual(reset);
    expect(clearedFieldsOnReactionWrite("replied", "undeliverable")).toEqual(reset);
  });

  it("宛先不明が関わらない書き換えでも印を消す(印が残ったまま拒否になる形を作らない)", () => {
    expect(clearedFieldsOnReactionWrite("no_response", "refused")).toEqual(reset);
    expect(clearedFieldsOnReactionWrite("replied", "no_response")).toEqual(reset);
  });
});

describe("isClearableUndeliverableLog(住所を替えたときに解除してよい記録か)", () => {
  const base = {
    reactionStatus: "undeliverable",
    undeliverableClearedAt: null,
    manualReactionShadow: null,
    dmType: "owner_address" as string | null,
    ownerId: "owner-1" as string | null,
    logOwnerIds: [] as string[],
  };

  it("その所有者だけに送った、所有者の住所あての宛先不明は解除できる", () => {
    expect(isClearableUndeliverableLog(base, "owner-1")).toBe(true);
    // 種類が入っていない古い記録・売却DMの記録(null)も所有者の住所あて
    expect(isClearableUndeliverableLog({ ...base, dmType: null }, "owner-1")).toBe(true);
    // 連関に本人だけが入っている形も同じ
    expect(isClearableUndeliverableLog({ ...base, logOwnerIds: ["owner-1"] }, "owner-1")).toBe(true);
  });

  it("⚠拒否・裏に拒否が控える記録は解除しない", () => {
    expect(isClearableUndeliverableLog({ ...base, reactionStatus: "refused" }, "owner-1")).toBe(false);
    expect(
      isClearableUndeliverableLog(
        { ...base, manualReactionShadow: { status: "refused", reactedAt: null, note: null } },
        "owner-1",
      ),
    ).toBe(false);
  });

  it("物件の住所あてに送った DM の宛先不明は解除しない(所有者の住所を替えても関係がない)", () => {
    expect(isClearableUndeliverableLog({ ...base, dmType: "property_address" }, "owner-1")).toBe(false);
  });

  it("⚠共有でまとめて送った記録(ほかの所有者も入っている)は解除しない(発注者決定)", () => {
    expect(isClearableUndeliverableLog({ ...base, logOwnerIds: ["owner-1", "owner-2"] }, "owner-1")).toBe(false);
    // 代表が別の人で、本人は共有者として入っている
    expect(isClearableUndeliverableLog({ ...base, ownerId: "owner-2", logOwnerIds: ["owner-1"] }, "owner-1")).toBe(false);
  });

  it("その所有者の記録でなければ解除しない・すでに解除済みなら対象外", () => {
    expect(isClearableUndeliverableLog({ ...base, ownerId: "owner-9" }, "owner-1")).toBe(false);
    expect(isClearableUndeliverableLog({ ...base, ownerId: null }, "owner-1")).toBe(false);
    expect(
      isClearableUndeliverableLog({ ...base, undeliverableClearedAt: new Date("2026-11-01T00:00:00Z") }, "owner-1"),
    ).toBe(false);
  });
});
