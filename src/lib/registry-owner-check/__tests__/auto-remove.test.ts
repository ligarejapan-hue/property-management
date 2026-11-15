import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_REMOVE_DONE_TOKEN,
  isSystemExtraOnly,
  ownerDiffLabelFromStored,
} from "../diff";
import { planOwnerReplacement } from "../compare";

describe("isSystemExtraOnly(システムにだけ余分な人がいるだけの違い・2026-11-15 発注者「外してよい」)", () => {
  it("人数が違う(システムが多い)だけなら当たる(処理済みの印は見ない)", () => {
    expect(isSystemExtraOnly("count:1:2")).toBe(true);
    expect(isSystemExtraOnly("count:2:4,autoadd")).toBe(true);
    expect(isSystemExtraOnly("count:1:2,autoadd,entries")).toBe(true);
  });
  it("謄本のほうが多い・同じ人数は当たらない", () => {
    expect(isSystemExtraOnly("count:2:1")).toBe(false);
    expect(isSystemExtraOnly("count:2:2")).toBe(false);
  });
  it("ほかの種類(漢字・法人・外字・名前の一部・別の人)が混ざれば当たらない", () => {
    for (const k of ["kanji", "corp", "gaiji", "partial", "someone", "different", "other"]) {
      expect(isSystemExtraOnly(`${k},count:1:2`)).toBe(false);
    }
  });
  it("自動で外すのを試し終えた印があれば当たらない(1つの謄本につき1回)", () => {
    expect(isSystemExtraOnly(`count:1:2,autoadd,${AUTO_REMOVE_DONE_TOKEN}`)).toBe(false);
  });
  it("空・壊れた値は当たらない", () => {
    expect(isSystemExtraOnly(null)).toBe(false);
    expect(isSystemExtraOnly("")).toBe(false);
    expect(isSystemExtraOnly("count:x:y")).toBe(false);
  });
  it("印は一覧の文言に出さない", () => {
    expect(ownerDiffLabelFromStored(`count:1:2,${AUTO_REMOVE_DONE_TOKEN}`)).toBe(ownerDiffLabelFromStored("count:1:2"));
  });
});

describe("外す人の選び方は「謄本の名義に直す」と同じ(planOwnerReplacement)", () => {
  it("謄本の人が全員いて余分な人がいれば、余分な人だけを外し、足す人はいない", () => {
    const plan = planOwnerReplacement(
      [{ name: "山田太郎", address: null, share: null }],
      [
        { ownerId: "o1", name: "山田 太郎" },
        { ownerId: "o2", name: "鈴木花子" },
      ],
    );
    expect(plan.add).toEqual([]);
    expect(plan.removeOwnerIds).toEqual(["o2"]);
  });
});

describe("配線", () => {
  const svc = readFileSync(join(process.cwd(), "src/lib/registry-owner-check/service.ts"), "utf8").replace(/\r\n/g, "\n");
  it("比べて「違う」なら、自動の登録のあとに自動で外すも試す", () => {
    expect(svc).toMatch(/autoAddRegistryOnlyOwners\(id\)[\s\S]{0,400}autoRemoveSystemOnlyOwners\(id\)/);
  });
  it("前に比べ終えて判断待ちの物件も、比べる回のついでに少しずつ試す", () => {
    expect(svc).toMatch(/autoRemovePendingCandidates\(/);
  });
  it("外す処理は「謄本の名義に直す」と同じ関数で、記録は「自動」・固定の名前で残す", () => {
    expect(svc).toMatch(/replaceRegistryOwnersOnProperty\(\{[\s\S]{0,600}auditLabel: REGISTRY_OWNER_AUTO_REMOVE_AUDIT_LABEL[\s\S]{0,80}changeSource: "auto"/);
  });
});
