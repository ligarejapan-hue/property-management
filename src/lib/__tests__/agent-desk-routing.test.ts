import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/proxy";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("受付の窓への入口", () => {
  it("ログイン必須(公開パスではない)", () => {
    expect(isPublicPath("/inquiry-desk")).toBe(false);
  });
  it("サイドバーに「反響の受付」=名前付きの別窓で開く・全員に見える", () => {
    const item = SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/inquiry-desk");
    expect(item).toMatchObject({ label: "反響の受付", external: true, windowName: "pm-inquiry-desk", minRole: "field_staff" });
  });
  it("別窓の項目は windowName があればその名前の窓に開く", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/sidebar.tsx"), "utf8");
    expect(src).toMatch(/target=\{item\.windowName \?\? "_blank"\}/);
  });
  it("名前付きの窓には rel=noopener を付けない(付けると同じ窓を探せず毎回新しい窓になる・最終レビュー I-3)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/sidebar.tsx"), "utf8");
    expect(src).toMatch(/rel=\{item\.windowName \? undefined : "noopener noreferrer"\}/);
  });
  it("業者の名簿もログイン必須・全員に見える・メイン画面の中で開く(別窓にしない)", () => {
    expect(isPublicPath("/agents")).toBe(false);
    const item = SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/agents");
    expect(item).toMatchObject({ label: "業者の名簿", minRole: "field_staff" });
    expect(item?.external).toBeUndefined();
  });
});
