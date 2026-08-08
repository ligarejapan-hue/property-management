import { describe, it, expect } from "vitest";
import { dmMethodLabel, dmTypeLabel } from "@/lib/dm-method-labels";

describe("dmMethodLabel / dmTypeLabel", () => {
  it("既知の method は日本語ラベル", () => {
    expect(dmMethodLabel("sale_dm")).toBe("売却DM");
    expect(dmMethodLabel("mail")).toBe("郵送");
    expect(dmMethodLabel("hand_delivery")).toBe("手渡し");
    expect(dmMethodLabel("other")).toBe("その他");
  });
  it("未知値は生値のまま(旧データ互換)・null/undefined は空文字", () => {
    expect(dmMethodLabel("fax")).toBe("fax");
    expect(dmMethodLabel(null)).toBe("");
    expect(dmMethodLabel(undefined)).toBe("");
  });
  it("dm_type のラベル", () => {
    expect(dmTypeLabel("owner_address")).toBe("所有者宛");
    expect(dmTypeLabel("property_address")).toBe("物件宛");
    expect(dmTypeLabel(null)).toBe("");
  });
});
