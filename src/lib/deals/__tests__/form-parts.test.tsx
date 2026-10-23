import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverrideField, SelectBox } from "@/components/deals/form-parts";

describe("入力の部品", () => {
  it("選択肢に無い値は「(使えない値)」として見せる(M2)", () => {
    const html = renderToStaticMarkup(<SelectBox label="担当" value="gone" onChange={() => {}} options={[{ value: "a", label: "試験 太郎" }]} allowEmpty />);
    expect(html).toContain('value="gone"');
    expect(html).toContain("(使えない値)");
  });
  it("上書きしていなければ計算の値、上書きしていれば印と「計算に戻す」", () => {
    const plain = renderToStaticMarkup(<OverrideField label="仲介手数料" computed={960000} override={undefined} onChange={() => {}} />);
    expect(plain).toContain("960,000");
    expect(plain).not.toContain("計算に戻す");
    const over = renderToStaticMarkup(<OverrideField label="仲介手数料" computed={960000} override={900000} onChange={() => {}} />);
    expect(over).toContain("手で直した値");
    expect(over).toContain("計算に戻す");
    expect(over).toContain("960,000");
  });
});
