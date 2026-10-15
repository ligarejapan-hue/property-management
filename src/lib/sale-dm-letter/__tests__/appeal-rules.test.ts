import { describe, it, expect } from "vitest";
import { buildExternalPrompt, buildLpExternalPrompt, scenarioLetterPrompt } from "../external-prompt";
import { buildLetterPrompt, APPEAL_JA } from "../prompt";
import { APPEAL_OPTIONS } from "../adjust-model";
import { saleDmOptionsSchema, saleDmLpVariantOptionsSchema, saleDmScenarioPatchSchema } from "@/lib/validators-sale-dm";

// 相続（マンション）の手紙・LPに、マンションの部屋には使えない「相続した空き家の3,000万円特別控除」を
// 書かせない(@codex PR#515 P2)。指示文は3つ(外部AIの手紙・外部AIのLP・AI直結)すべてに決まりが入る。
const BAN = /相続した空き家の3,000万円特別控除[^\n]*書かない/;
const base = { tone: "formal", length: "medium", strength: "medium" };
const recipient = { representativeName: "見本", honorific: "様", coOwnerCount: 1, propertyAddress: "見本町", propertyTypeLabel: "区分マンション" };
const direct = (appeal: string) => {
  const p = buildLetterPrompt(recipient, { ...base, appeal, designTemplate: "formal", senderName: "x", senderContact: "y" });
  return p.system + "\n" + p.user;
};

describe("訴求「相続・マンション」(inheritance_unit)", () => {
  it("3つの指示文すべてに、空き家の特例を書かない決まりが入る", () => {
    const opts = { ...base, appeal: "inheritance_unit" };
    expect(buildExternalPrompt(opts)).toMatch(BAN);
    expect(scenarioLetterPrompt(opts)).toMatch(BAN);
    expect(buildLpExternalPrompt(opts)).toMatch(BAN);
    expect(direct("inheritance_unit")).toMatch(BAN);
  });

  it("ほかの訴求の指示文は変わらない(決まりが入らない=登録済みの文面の指紋がずれない)", () => {
    for (const { value } of APPEAL_OPTIONS) {
      if (value === "inheritance_unit") continue;
      const opts = { ...base, appeal: value };
      expect(buildExternalPrompt(opts)).not.toMatch(BAN);
      expect(buildLpExternalPrompt(opts)).not.toMatch(BAN);
      expect(direct(value)).not.toMatch(BAN);
    }
  });

  it("訴求の言い回しは「相続・税」と別(税の観点を指示しない)", () => {
    expect(APPEAL_JA.inheritance_unit).toBeTruthy();
    expect(APPEAL_JA.inheritance_unit).not.toMatch(/税/);
  });

  it("選択肢にあるすべての訴求を、種類・型・LP型の入力検査が受け付ける(種類から写した型を保存し直せる)", () => {
    for (const { value } of APPEAL_OPTIONS) {
      expect(APPEAL_JA[value]).toBeTruthy();
      expect(saleDmOptionsSchema.shape.appeal.safeParse(value).success).toBe(true);
      expect(saleDmLpVariantOptionsSchema.shape.appeal.safeParse(value).success).toBe(true);
      expect(saleDmScenarioPatchSchema.safeParse({ appeal: value, lpAppeal: value }).success).toBe(true);
    }
  });
});
