import { describe, it, expect } from "vitest";
import { resolveDraftOptions } from "../sale-dm-letter/override";
import { saleDmOptionsOverrideSchema } from "../validators-sale-dm";

const variant = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: null as string | null,
};
const sender = { senderName: "△△不動産", senderContact: "000-000-0000" };

describe("resolveDraftOptions", () => {
  it("override 無しなら variant 設定 + sender をそのまま LetterOptions にする", () => {
    const o = resolveDraftOptions(variant, null, sender);
    expect(o.tone).toBe("formal");
    expect(o.strength).toBe("low");
    expect(o.senderName).toBe("△△不動産");
    expect(o.extraInstruction).toBeUndefined(); // null → undefined に正規化
  });

  it("override のキーだけ variant を上書きする(shallow merge)", () => {
    const o = resolveDraftOptions(variant, { tone: "soft", strength: "high" }, sender);
    expect(o.tone).toBe("soft");
    expect(o.strength).toBe("high");
    expect(o.appeal).toBe("price"); // 未指定は variant 維持
    expect(o.senderName).toBe("△△不動産"); // sender は override 対象外
  });

  it("override の extraInstruction を反映する", () => {
    const o = resolveDraftOptions(variant, { extraInstruction: "成約事例にも触れて" }, sender);
    expect(o.extraInstruction).toBe("成約事例にも触れて");
  });

  it("override に sender を含めても無視する(差出人は変えない)", () => {
    const o = resolveDraftOptions(variant, { senderName: "悪意" } as never, sender);
    expect(o.senderName).toBe("△△不動産");
  });
});

describe("saleDmOptionsOverrideSchema", () => {
  it("部分指定を許可する", () => {
    const r = saleDmOptionsOverrideSchema.safeParse({ tone: "soft" });
    expect(r.success).toBe(true);
  });
  it("空オブジェクトを許可する", () => {
    expect(saleDmOptionsOverrideSchema.safeParse({}).success).toBe(true);
  });
  it("不正な enum 値は拒否する", () => {
    expect(saleDmOptionsOverrideSchema.safeParse({ tone: "loud" }).success).toBe(false);
  });
  it("sender 等の余剰キーは無視される(部分 options のみ)", () => {
    const r = saleDmOptionsOverrideSchema.safeParse({ tone: "soft", senderName: "x" });
    expect(r.success).toBe(true);
    expect("senderName" in (r.success ? r.data : {})).toBe(false);
  });
});
