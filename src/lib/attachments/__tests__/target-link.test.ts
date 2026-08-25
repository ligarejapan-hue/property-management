import { describe, it, expect } from "vitest";
import { attachmentTargetHref } from "../target-link";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("attachmentTargetHref（添付から、それが付いている先へ飛ぶ）", () => {
  it("物件はその物件ページへ", () => {
    expect(attachmentTargetHref("property", UUID)).toBe(`/properties/${UUID}`);
  });

  it("所有者はその所有者ページへ", () => {
    expect(attachmentTargetHref("owner", UUID)).toBe(`/admin/owners/${UUID}`);
  });

  it("行き先の無いものはリンクにしない（押せない文字のまま）", () => {
    expect(attachmentTargetHref("comment", UUID)).toBeNull();
    expect(attachmentTargetHref("unknown", UUID)).toBeNull();
    expect(attachmentTargetHref("", UUID)).toBeNull();
  });

  it("宛先が無い・空のときはリンクにしない（壊れたリンクを作らない）", () => {
    expect(attachmentTargetHref("property", "")).toBeNull();
    expect(attachmentTargetHref("property", "   ")).toBeNull();
    expect(attachmentTargetHref("property", null)).toBeNull();
    expect(attachmentTargetHref("property", undefined)).toBeNull();
  });

  it("宛先はそのままURLに埋めず、必ず符号化する", () => {
    expect(attachmentTargetHref("property", "a b/../c")).toBe(
      `/properties/${encodeURIComponent("a b/../c")}`,
    );
    const href = attachmentTargetHref("owner", "x?y=1&z=2");
    expect(href).toBe(`/admin/owners/${encodeURIComponent("x?y=1&z=2")}`);
    expect(href).not.toContain("?");
    expect(href).not.toContain("&");
  });
});
