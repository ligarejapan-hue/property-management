import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildExternalPrompt, scenarioLetterPrompt, variantLetterPrompt, ILLUSTRATION_PROMPT_LINE } from "../external-prompt";

const OPTS = { tone: "polite", length: "standard", appeal: "inheritance", strength: "soft" };
const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("指示文の【イラスト】の一文", () => {
  it("既定(型A/B)は今までと1文字も変わらない", () => {
    expect(buildExternalPrompt(OPTS)).toBe(buildExternalPrompt(OPTS, { illustrationMarker: false }));
    expect(buildExternalPrompt(OPTS)).not.toContain("【イラスト】");
  });
  it("illustrationMarker のときだけ【必ず守ること】に一文が入る", () => {
    const p = buildExternalPrompt(OPTS, { illustrationMarker: true });
    expect(p).toContain(ILLUSTRATION_PROMPT_LINE);
    expect(ILLUSTRATION_PROMPT_LINE).toContain("【イラスト】とだけ書いた行を1行");
    const rules = p.slice(p.indexOf("【必ず守ること】"), p.indexOf("【場所や種別に触れたいとき】"));
    expect(rules).toContain(ILLUSTRATION_PROMPT_LINE);
  });
  it("台帳は常に一文あり・発送の型は種類から写したときだけ", () => {
    expect(scenarioLetterPrompt(OPTS)).toContain(ILLUSTRATION_PROMPT_LINE);
    expect(variantLetterPrompt({ ...OPTS, scenarioId: "s1" })).toBe(scenarioLetterPrompt(OPTS));
    expect(variantLetterPrompt({ ...OPTS, scenarioId: null })).toBe(buildExternalPrompt(OPTS));
    // 未取得(select 漏れ)を「種類から写した」と読まない。
    expect(variantLetterPrompt({ ...OPTS } as never)).toBe(buildExternalPrompt(OPTS));
  });
  it("走査: 表示と保存の照合が同じ関数を通る(食い違うと必ず PROMPT_STALE)", () => {
    for (const f of [
      "src/app/api/properties/sale-dm/scenarios/[id]/prompt/route.ts",
      "src/app/api/properties/sale-dm/scenarios/[id]/template/route.ts",
    ]) {
      expect(code(f), f).toMatch(/scenarioLetterPrompt\(/);
      expect(code(f), f).not.toMatch(/buildExternalPrompt\(/);
    }
    for (const f of [
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/prompt/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts",
    ]) {
      expect(code(f), f).toMatch(/variantLetterPrompt\(/);
      expect(code(f), f).not.toMatch(/buildExternalPrompt\(/);
      expect(code(f), f).toMatch(/scenarioId: true/);
    }
  });
});
