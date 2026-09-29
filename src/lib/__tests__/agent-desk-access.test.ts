import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDeskAccess } from "@/components/agent-inquiry/desk-access";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("受付の窓の 401/403 はどの呼び出しでも同じ扱い(@codex #459 R20)", () => {
  const setup = () => {
    const h = { sessionLost: vi.fn(), readForbidden: vi.fn(), writeForbidden: vi.fn() };
    return { h, a: makeDeskAccess(h) };
  };
  it("読み込みの 401 はログイン切れ・403 は権限なし=どちらも画面ごと隠す(true)", () => {
    const { h, a } = setup();
    expect(a.readDenied(err("UNAUTHORIZED"))).toBe(true);
    expect(h.sessionLost).toHaveBeenCalledTimes(1);
    expect(a.readDenied(err("FORBIDDEN"))).toBe(true);
    expect(h.readForbidden).toHaveBeenCalledTimes(1);
    expect(a.readDenied(err("VALIDATION_ERROR"))).toBe(false);
    expect(a.readDenied(new Error("x"))).toBe(false);
  });
  it("書き込みの 401 はログイン切れ(true)・403 は権限を読み直す(false=文言は各自で出す)", () => {
    const { h, a } = setup();
    expect(a.writeDenied(err("UNAUTHORIZED"))).toBe(true);
    expect(h.sessionLost).toHaveBeenCalledTimes(1);
    expect(a.writeDenied(err("FORBIDDEN"))).toBe(false);
    expect(h.writeForbidden).toHaveBeenCalledTimes(1);
    expect(h.readForbidden).not.toHaveBeenCalled();
    expect(a.writeDenied(err("VERSION_CONFLICT"))).toBe(false);
  });
  it("窓のすべての呼び出しが同じ扱いを通る", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
    for (const p of ["src/components/agent-inquiry/agent-picker.tsx", "src/components/agent-inquiry/property-picker.tsx"]) {
      expect(src(p), p).toMatch(/\.catch\(\(e\) => \{\s*(?:\/\/[^\n]*\n\s*)?if \(readDenied\(e\)\) return;/);
    }
    expect(src("src/components/agent-inquiry/inquiry-form.tsx")).toMatch(/catch \(err\) \{\s*if \(writeDenied\(err\)\) return;/);
    expect(src("src/components/agent-inquiry/agent-create-modal.tsx")).toMatch(/catch \(e\) \{\s*if \(writeDenied\(e\)\) return;/);
    expect(src("src/components/agent-inquiry/inquiry-detail.tsx")).toMatch(/apiErrorCode\(e\) === "FORBIDDEN"\) writeDenied\(e\)/);
    const page = src("src/app/(desk)/inquiry-desk/page.tsx");
    expect(page).toContain("<DeskAccessContext.Provider value={deskAccess}>");
    expect(page).toMatch(/writeForbidden: \(\) => void refetchPermissions\(\)/);
  });
});
