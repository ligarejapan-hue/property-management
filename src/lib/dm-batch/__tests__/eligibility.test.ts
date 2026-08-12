import { describe, it, expect } from "vitest";
import {
  checkBatchEligibility,
  type BatchItemForCheck,
  type PropertyStateForCheck,
} from "../eligibility";

// 宛先資格の再検証(設計書§2.1 検査(1)(2)(3)(4)(6)(7))。
// (2)terminal反響=PR-B で追加済み / (5)候補再評価=PR-C で本関数に追加する。

const ADMIN = { id: "u-admin", role: "admin" };
const FIELD = { id: "u-field", role: "field_staff" };

function prop(over: Partial<PropertyStateForCheck> = {}): PropertyStateForCheck {
  return {
    id: "p1",
    dmStatus: "send",
    isArchived: false,
    createdBy: "u-admin",
    assignedTo: null,
    propertyOwners: [
      {
        isPrimary: true,
        relationship: null,
        owner: {
          id: "o1",
          name: "甲",
          nameKana: null,
          zip: "100-0001",
          address: "東京都A",
          currentZip: null,
          currentAddress: null,
          corporateNumber: null,
        },
      },
    ],
    ...over,
  };
}

const item = (over: Partial<BatchItemForCheck> = {}): BatchItemForCheck => ({
  id: "i1",
  propertyId: "p1",
  ownerId: "o1",
  groupOwnerIds: ["o1"],
  ...over,
});

describe("checkBatchEligibility", () => {
  it("問題なしなら全カウント0", () => {
    const r = checkBatchEligibility([item()], new Map([["p1", prop()]]), ADMIN);
    expect(r).toEqual({
      prunedItemIds: [],
      scopeMissingCount: 0,
      stateIssueCount: 0,
      groupMismatchCount: 0,
      terminalReactionCount: 0,
    });
  });

  it("(2) 代表が terminal 集合(拒否・宛先不明の反響持ち)にあれば terminalReactionCount(PR-B)", () => {
    const r = checkBatchEligibility(
      [item()],
      new Map([["p1", prop()]]),
      ADMIN,
      new Set(["o1"]),
    );
    expect(r.terminalReactionCount).toBe(1);
    expect(r.stateIssueCount).toBe(0);
  });

  it("(2) 共有者(連関)の1人が terminal でも検出する(代表だけ見ない=R29)", () => {
    const shared = prop({
      propertyOwners: [
        ...prop().propertyOwners,
        {
          isPrimary: false,
          relationship: null,
          owner: {
            id: "o2",
            name: "乙",
            nameKana: null,
            zip: "100-0001",
            address: "東京都A",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
      ],
    });
    const r = checkBatchEligibility(
      [item({ groupOwnerIds: ["o1", "o2"] })],
      new Map([["p1", shared]]),
      ADMIN,
      new Set(["o2"]),
    );
    expect(r.terminalReactionCount).toBe(1);
  });

  it("(2) terminal 集合が無関係の owner なら 0", () => {
    const r = checkBatchEligibility(
      [item()],
      new Map([["p1", prop()]]),
      ADMIN,
      new Set(["o-other"]),
    );
    expect(r.terminalReactionCount).toBe(0);
  });

  it("(2) 所有者紐づけの無い terminal 記録は物件単位で検出(個別記録の拒否=#366 R6)", () => {
    const r = checkBatchEligibility(
      [item()],
      new Map([["p1", prop()]]),
      ADMIN,
      new Set(),
      new Set(["p1"]),
    );
    expect(r.terminalReactionCount).toBe(1);
  });

  it("(4) owner/property が null の item は pruned に入る(他の検査対象にしない)", () => {
    const r = checkBatchEligibility(
      [item({ id: "i-null", ownerId: null })],
      new Map([["p1", prop()]]),
      ADMIN,
    );
    expect(r.prunedItemIds).toEqual(["i-null"]);
    expect(r.stateIssueCount).toBe(0);
  });

  it("(1) field_staff のスコープ外物件は scopeMissing", () => {
    const r = checkBatchEligibility([item()], new Map([["p1", prop()]]), FIELD);
    expect(r.scopeMissingCount).toBe(1);
  });

  it("(1) field_staff でも担当なら通る", () => {
    const r = checkBatchEligibility(
      [item()],
      new Map([["p1", prop({ assignedTo: "u-field" })]]),
      FIELD,
    );
    expect(r.scopeMissingCount).toBe(0);
  });

  it("(3) dmStatus=hold / no_send / isArchived は stateIssue(R48/R52)", () => {
    for (const p of [
      prop({ dmStatus: "hold" }),
      prop({ dmStatus: "no_send" }),
      prop({ isArchived: true }),
    ]) {
      const r = checkBatchEligibility([item()], new Map([["p1", p]]), ADMIN);
      expect(r.stateIssueCount).toBe(1);
    }
  });

  it("(3) PropertyOwner リンクが外れた共有者がいると stateIssue(R48)", () => {
    const unlinked = prop({
      propertyOwners: [
        {
          isPrimary: true,
          relationship: null,
          owner: {
            id: "o9",
            name: "乙",
            nameKana: null,
            zip: "100-0001",
            address: "東京都A",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
      ],
    });
    const r = checkBatchEligibility([item()], new Map([["p1", unlinked]]), ADMIN);
    expect(r.stateIssueCount).toBe(1);
  });

  it("(6) 所有者追加でグループ構成が変わったら groupMismatch(R51)", () => {
    const grown = prop({
      propertyOwners: [
        {
          isPrimary: true,
          relationship: null,
          owner: {
            id: "o1",
            name: "甲",
            nameKana: null,
            zip: "100-0001",
            address: "東京都A",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
        {
          isPrimary: false,
          relationship: null,
          owner: {
            id: "o2",
            name: "乙",
            nameKana: null,
            zip: "100-0001",
            address: "東京都A",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
      ],
    });
    const r = checkBatchEligibility([item()], new Map([["p1", grown]]), ADMIN);
    expect(r.groupMismatchCount).toBe(1);
  });

  it("(6) 共有者の住所変更でグループが割れても groupMismatch(R51)", () => {
    // 保存時は o1,o2 が同一住所グループ→ o2 が転居して別グループに
    const split = prop({
      propertyOwners: [
        {
          isPrimary: true,
          relationship: null,
          owner: {
            id: "o1",
            name: "甲",
            nameKana: null,
            zip: "100-0001",
            address: "東京都A",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
        {
          isPrimary: false,
          relationship: null,
          owner: {
            id: "o2",
            name: "乙",
            nameKana: null,
            zip: "200-0002",
            address: "神奈川県B",
            currentZip: null,
            currentAddress: null,
            corporateNumber: null,
          },
        },
      ],
    });
    const r = checkBatchEligibility(
      [item({ groupOwnerIds: ["o1", "o2"] })],
      new Map([["p1", split]]),
      ADMIN,
    );
    expect(r.groupMismatchCount).toBe(1);
  });

  it("(7) 同一物件で同じグループを指す item が2つあれば groupMismatch(#364 R8=名寄せ後の重複)", () => {
    const r = checkBatchEligibility(
      [item({ id: "i1" }), item({ id: "i2" })],
      new Map([["p1", prop()]]),
      ADMIN,
    );
    expect(r.groupMismatchCount).toBe(1);
  });

  it("物件が Map に無い item は pruned 扱い(物件削除直後)", () => {
    const r = checkBatchEligibility([item()], new Map(), ADMIN);
    expect(r.prunedItemIds).toEqual(["i1"]);
  });
});
