import { describe, it, expect } from "vitest";
import type { PermissionEntry } from "../api-helpers";
import {
  OWNER_MEMO_BODY_MAX_LENGTH,
  canCreateOwnerMemo,
  formatMemoCreatorName,
  resolveOwnerMemoBodyVisibility,
  validateOwnerMemoBody,
} from "../owner-memo";

const p = (resource: string, action: string, granted = true): PermissionEntry => ({
  resource,
  action,
  granted,
});

// ── resolveOwnerMemoBodyVisibility ─────────────────────────────────────────

describe("resolveOwnerMemoBodyVisibility", () => {
  it("owner_note なし → hidden", () => {
    expect(resolveOwnerMemoBodyVisibility([])).toBe("hidden");
  });

  it("owner_note=hidden granted → hidden", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "hidden")])).toBe("hidden");
  });

  it("owner_note=masked → meta_only", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "masked")])).toBe("meta_only");
  });

  it("owner_note=partial → meta_only", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "partial")])).toBe("meta_only");
  });

  it("owner_note=read → visible", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "read")])).toBe("visible");
  });

  it("owner_note=full → visible", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "full")])).toBe("visible");
  });

  it("owner_note=edit → visible", () => {
    expect(resolveOwnerMemoBodyVisibility([p("owner_note", "edit")])).toBe("visible");
  });

  it("granted=false の entry は無視される", () => {
    expect(
      resolveOwnerMemoBodyVisibility([p("owner_note", "full", false)]),
    ).toBe("hidden");
  });
});

// ── canCreateOwnerMemo ─────────────────────────────────────────────────────

describe("canCreateOwnerMemo", () => {
  it("owner:write も owner_note:full もなければ false", () => {
    expect(canCreateOwnerMemo([])).toBe(false);
  });

  it("owner:write のみ → false (owner_note 不足)", () => {
    expect(canCreateOwnerMemo([p("owner", "write")])).toBe(false);
  });

  it("owner_note:full のみ → false (owner:write 不足)", () => {
    expect(canCreateOwnerMemo([p("owner_note", "full")])).toBe(false);
  });

  it("owner:write + owner_note:full → true", () => {
    expect(
      canCreateOwnerMemo([p("owner", "write"), p("owner_note", "full")]),
    ).toBe(true);
  });

  it("owner:write + owner_note:edit → true", () => {
    expect(
      canCreateOwnerMemo([p("owner", "write"), p("owner_note", "edit")]),
    ).toBe(true);
  });

  it("owner:write + owner_note:read → false (read は書込権限ではない)", () => {
    expect(
      canCreateOwnerMemo([p("owner", "write"), p("owner_note", "read")]),
    ).toBe(false);
  });

  it("owner:write + owner_note:masked → false", () => {
    expect(
      canCreateOwnerMemo([p("owner", "write"), p("owner_note", "masked")]),
    ).toBe(false);
  });

  it("granted=false は false", () => {
    expect(
      canCreateOwnerMemo([
        p("owner", "write", false),
        p("owner_note", "full"),
      ]),
    ).toBe(false);
  });
});

// ── validateOwnerMemoBody ──────────────────────────────────────────────────

describe("validateOwnerMemoBody", () => {
  it("非文字列は empty 扱い", () => {
    expect(validateOwnerMemoBody(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(validateOwnerMemoBody(null)).toEqual({ ok: false, reason: "empty" });
    expect(validateOwnerMemoBody(123)).toEqual({ ok: false, reason: "empty" });
  });

  it("空文字 → empty", () => {
    expect(validateOwnerMemoBody("")).toEqual({ ok: false, reason: "empty" });
  });

  it("半角空白のみ → empty", () => {
    expect(validateOwnerMemoBody("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("全角空白のみ → empty", () => {
    expect(validateOwnerMemoBody("　　")).toEqual({ ok: false, reason: "empty" });
  });

  it("1文字 → ok", () => {
    const r = validateOwnerMemoBody("a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toBe("a");
  });

  it("前後空白を trim する", () => {
    const r = validateOwnerMemoBody("  hello  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toBe("hello");
  });

  it("最大文字数ちょうど → ok", () => {
    const body = "a".repeat(OWNER_MEMO_BODY_MAX_LENGTH);
    const r = validateOwnerMemoBody(body);
    expect(r.ok).toBe(true);
  });

  it("最大文字数+1 → too_long", () => {
    const body = "a".repeat(OWNER_MEMO_BODY_MAX_LENGTH + 1);
    expect(validateOwnerMemoBody(body)).toEqual({ ok: false, reason: "too_long" });
  });
});

// ── formatMemoCreatorName ──────────────────────────────────────────────────

describe("formatMemoCreatorName", () => {
  it("name があれば name を返す", () => {
    expect(formatMemoCreatorName({ name: "山田太郎", email: "y@example.com" })).toBe(
      "山田太郎",
    );
  });

  it("name が空文字なら email にフォールバック", () => {
    expect(formatMemoCreatorName({ name: "", email: "y@example.com" })).toBe(
      "y@example.com",
    );
  });

  it("name が空白のみなら email にフォールバック", () => {
    expect(formatMemoCreatorName({ name: "   ", email: "y@example.com" })).toBe(
      "y@example.com",
    );
  });

  it("name null かつ email あり → email", () => {
    expect(formatMemoCreatorName({ name: null, email: "y@example.com" })).toBe(
      "y@example.com",
    );
  });

  it("両方なし → 不明な担当者", () => {
    expect(formatMemoCreatorName({ name: null, email: null })).toBe("不明な担当者");
  });

  it("creator 自体が null → 不明な担当者", () => {
    expect(formatMemoCreatorName(null)).toBe("不明な担当者");
  });

  it("creator が undefined → 不明な担当者", () => {
    expect(formatMemoCreatorName(undefined)).toBe("不明な担当者");
  });
});
