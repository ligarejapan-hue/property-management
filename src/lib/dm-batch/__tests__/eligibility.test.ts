import { describe, it, expect } from "vitest";
import {
  checkBatchEligibility,
  type BatchItemForCheck,
  type PropertyStateForCheck,
} from "../eligibility";

// 宛先資格の再検証(設計書§2.1 検査(1)(3)(4)(6))。
// (2)terminal反響=PR-B / (5)候補再評価=PR-C で本関数に追加する。

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
    });
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

  it("物件が Map に無い item は pruned 扱い(物件削除直後)", () => {
    const r = checkBatchEligibility([item()], new Map(), ADMIN);
    expect(r.prunedItemIds).toEqual(["i1"]);
  });
});
