import { describe, it, expect } from "vitest";
import { saleDmLpVariantCreateSchema, saleDmLpVariantUpdateSchema, saleDmLpTemplatePutSchema, saleDmAssignSchema, saleDmLpMediaPutSchema, saleDmLpImagePromptQuerySchema, saleDmLpAssetLabelSchema } from "../validators-sale-dm";
import { LP_LIMITS } from "../sale-dm-letter/lp-template";

const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };

describe("LP型の zod", () => {
  it("作成は label と文体4項目のみ(designTemplate/extraInstruction は落とす)", () => {
    const r = saleDmLpVariantCreateSchema.parse({ label: "A", options: { ...OPT, designTemplate: "formal", extraInstruction: "x" } });
    expect(r).toEqual({ label: "A", options: OPT });
  });
  it("label は 1〜40 字", () => {
    expect(() => saleDmLpVariantCreateSchema.parse({ label: "", options: OPT })).toThrow();
    expect(() => saleDmLpVariantCreateSchema.parse({ label: "あ".repeat(41), options: OPT })).toThrow();
  });
  it("更新は部分指定", () => {
    expect(saleDmLpVariantUpdateSchema.parse({ options: { tone: "soft" } })).toEqual({ options: { tone: "soft" } });
    expect(() => saleDmLpVariantUpdateSchema.parse({ options: { tone: "loud" } })).toThrow();
  });
  it("貼り戻しは本文と2つの指紋(64桁)", () => {
    expect(() => saleDmLpTemplatePutSchema.parse({ body: "x", promptDigest: "a".repeat(64) })).toThrow();
    expect(saleDmLpTemplatePutSchema.parse({ body: "x", promptDigest: "a".repeat(64), baseBodyDigest: "b".repeat(64) }).body).toBe("x");
  });
  it("割当は lpAssignments を任意で受け付ける(既存の形はそのまま通る)", () => {
    expect(saleDmAssignSchema.parse({ mode: "auto", order: "random" })).toEqual({ mode: "auto", order: "random" });
    const r = saleDmAssignSchema.parse({ mode: "manual", lpAssignments: [{ recipientId: "r1", lpVariantId: "l1" }] });
    expect(r.lpAssignments).toEqual([{ recipientId: "r1", lpVariantId: "l1" }]);
  });
  it("lpAssignments.lpVariantId は null(割当なしに戻す)を受け付ける(@codex R5)", () => {
    const r = saleDmAssignSchema.parse({ mode: "manual", lpAssignments: [{ recipientId: "r2", lpVariantId: null }] });
    expect(r.lpAssignments).toEqual([{ recipientId: "r2", lpVariantId: null }]);
  });
});

describe("LP型 写真と図の zod", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  it("枠: hero は uuid か null、節は写真か図か null", () => {
    const r = saleDmLpMediaPutSchema.parse({ hero: { assetId: U }, sections: [{ heading: "h", media: { kind: "figure", figureKind: "sale_flow" } }, { heading: "g", media: null }] });
    expect(r.sections.length).toBe(2);
    expect(() => saleDmLpMediaPutSchema.parse({ hero: { assetId: "x" }, sections: [] })).toThrow();
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: "", media: null }] })).toThrow();
  });
  it("画像プロンプトの query: style は既定 photo", () => {
    expect(saleDmLpImagePromptQuerySchema.parse({ slot: "hero" })).toEqual({ slot: "hero", style: "photo" });
    expect(() => saleDmLpImagePromptQuerySchema.parse({ slot: "nope" })).toThrow();
  });
  it("写真のラベルは80字まで(空可)", () => {
    expect(saleDmLpAssetLabelSchema.parse("  会社の外観 ")).toBe("会社の外観");
    expect(() => saleDmLpAssetLabelSchema.parse("あ".repeat(81))).toThrow();
  });
  it("枠: 小見出しは60字まで・節は30個まで(文章保存の上限と揃える)", () => {
    const heading61 = "あ".repeat(61);
    const heading60 = "あ".repeat(60);
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: heading61, media: null }] })).toThrow();
    expect(saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: heading60, media: null }] }).sections[0].heading).toBe(heading60);
    const sections31 = Array.from({ length: 31 }, (_, i) => ({ heading: `h${i}`, media: null }));
    const sections30 = sections31.slice(0, 30);
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: sections31 })).toThrow();
    expect(saleDmLpMediaPutSchema.parse({ hero: null, sections: sections30 }).sections.length).toBe(30);
  });
  it("枠の上限は LP_LIMITS(splitLpTemplate と同じ定数)から来ている", () => {
    const atHeadingLimit = "あ".repeat(LP_LIMITS.heading);
    const overHeadingLimit = "あ".repeat(LP_LIMITS.heading + 1);
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: atHeadingLimit, media: null }] })).not.toThrow();
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: overHeadingLimit, media: null }] })).toThrow();
    const atCountLimit = Array.from({ length: LP_LIMITS.headingCount }, (_, i) => ({ heading: `h${i}`, media: null }));
    const overCountLimit = [...atCountLimit, { heading: "extra", media: null }];
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: atCountLimit })).not.toThrow();
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: overCountLimit })).toThrow();
  });
});
