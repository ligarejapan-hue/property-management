import { describe, it, expect } from "vitest";
import { parseInquiryForm, INQUIRY_LIMITS, INQUIRY_ERROR_MESSAGES } from "@/lib/sale-dm-letter/inquiry-input";

const get = (m: Record<string, string>) => (k: string) => (k in m ? m[k] : null);
const BASE = { name: "山田", phone: "09012345678", consent: "yes" };

describe("parseInquiryForm: 物件の所在地(広告用の公開ページの任意欄)", () => {
  it("欄が無い(DM用のフォーム)ときは null", () => {
    const r = parseInquiryForm(get(BASE));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.propertyAddress).toBeNull();
  });
  it("入力があれば前後の空白を除いて保存する(1行に揃える)", () => {
    const r = parseInquiryForm(get({ ...BASE, propertyAddress: "  世田谷区経堂1-2-3 \n マンション101 " }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.propertyAddress).toBe("世田谷区経堂1-2-3 マンション101");
  });
  it(`${INQUIRY_LIMITS.propertyAddress}字を超えると invalid(property_address_too_long)`, () => {
    const r = parseInquiryForm(get({ ...BASE, propertyAddress: "あ".repeat(INQUIRY_LIMITS.propertyAddress + 1) }));
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errors).toEqual(["property_address_too_long"]);
    expect(INQUIRY_ERROR_MESSAGES.property_address_too_long).toContain(String(INQUIRY_LIMITS.propertyAddress));
  });
});
