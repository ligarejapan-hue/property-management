import { describe, it, expect } from "vitest";
import { createOwnerSchema, updateOwnerSchema } from "../validators";
import { OWNER_TRACKED_FIELDS } from "../change-log";

describe("updateOwnerSchema — corporateNumber", () => {
  it("null を accept する（保存しない）", () => {
    const r = updateOwnerSchema.safeParse({ corporateNumber: null, version: 1 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBeNull();
    }
  });

  it("空文字を null に正規化する", () => {
    const r = updateOwnerSchema.safeParse({ corporateNumber: "", version: 1 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBeNull();
    }
  });

  it("13桁数字を accept する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "1234567890123",
      version: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBe("1234567890123");
    }
  });

  it("ハイフン混じり 13桁を正規化して accept する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "1234-5678-9012-3",
      version: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBe("1234567890123");
    }
  });

  it("空白混じり 13桁を正規化して accept する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: " 1234 5678 9012 3 ",
      version: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBe("1234567890123");
    }
  });

  it("全角数字 13桁を正規化して accept する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "１２３４５６７８９０１２３",
      version: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBe("1234567890123");
    }
  });

  it("12桁は reject する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "123456789012",
      version: 1,
    });
    expect(r.success).toBe(false);
  });

  it("14桁は reject する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "12345678901234",
      version: 1,
    });
    expect(r.success).toBe(false);
  });

  it("数字以外を含む値は reject する", () => {
    const r = updateOwnerSchema.safeParse({
      corporateNumber: "1234567890ABC",
      version: 1,
    });
    expect(r.success).toBe(false);
  });

  it("corporateNumber 未指定でも accept する（optional）", () => {
    const r = updateOwnerSchema.safeParse({ version: 1 });
    expect(r.success).toBe(true);
  });
});

describe("createOwnerSchema — corporateNumber", () => {
  it("name のみ + corporateNumber=13桁 を accept", () => {
    const r = createOwnerSchema.safeParse({
      name: "株式会社○○",
      corporateNumber: "1234567890123",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.corporateNumber).toBe("1234567890123");
    }
  });

  it("corporateNumber=null を accept", () => {
    const r = createOwnerSchema.safeParse({ name: "個人", corporateNumber: null });
    expect(r.success).toBe(true);
  });

  it("corporateNumber 不正値は reject", () => {
    const r = createOwnerSchema.safeParse({
      name: "株式会社○○",
      corporateNumber: "12345",
    });
    expect(r.success).toBe(false);
  });
});

describe("OWNER_TRACKED_FIELDS — corporateNumber", () => {
  it("corporateNumber が tracked field に含まれる", () => {
    expect(OWNER_TRACKED_FIELDS).toContain("corporateNumber");
  });
});
