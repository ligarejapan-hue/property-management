import { describe, it, expect } from "vitest";
import { isDmUndeliverable, canCreateSaleDm, buildSaleDmPartialNotice } from "../sale-dm-letter/list-ui";

const perm = (resource: string) => ({ resource, action: "read", granted: true });
const genPerm = { resource: "sale_dm", action: "generate", granted: true };
const writePerm = { resource: "property", action: "write", granted: true };

describe("isDmUndeliverable", () => {
  it("日時文字列があれば true", () => {
    expect(isDmUndeliverable("2026-06-20T00:00:00.000Z")).toBe(true);
  });
  it("null/undefined/空文字は false", () => {
    expect(isDmUndeliverable(null)).toBe(false);
    expect(isDmUndeliverable(undefined)).toBe(false);
    expect(isDmUndeliverable("")).toBe(false);
  });
});

describe("canCreateSaleDm", () => {
  it("csv_export + csv_export_personal + owner の read + sale_dm:generate が揃えば true", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner"), genPerm, writePerm])).toBe(true);
  });
  it("property:write が無ければ false(押せるのに 403 になる作成ボタンを見せない・PR-D1)", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner"), genPerm])).toBe(false);
  });

  it("owner が欠けたら false", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), genPerm])).toBe(false);
  });
  it("sale_dm:generate が無ければ false(押せるのに 403 になる作成ボタンを見せない)", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner")])).toBe(false);
  });
  it("sale_dm が read だけ(generate でない)では false", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner"), perm("sale_dm")])).toBe(false);
  });
  it("granted=false は数えない", () => {
    expect(canCreateSaleDm([{ resource: "owner", action: "read", granted: false }, perm("csv_export"), perm("csv_export_personal"), genPerm])).toBe(false);
  });
  it("null(取得失敗)は false(fail-safe)", () => {
    expect(canCreateSaleDm(null)).toBe(false);
  });
});

describe("buildSaleDmPartialNotice", () => {
  it("全件生成(truncated=false / failed=0)は null(通知不要)", () => {
    expect(buildSaleDmPartialNotice({ generated: 10, failed: 0, truncated: false })).toBeNull();
  });

  it("truncated=true なら上限超で一部のみ生成した旨(生成件数つき)を返す", () => {
    const msg = buildSaleDmPartialNotice({ generated: 50, failed: 0, truncated: true });
    expect(msg).not.toBeNull();
    expect(msg).toContain("50");
    expect(msg).toMatch(/上限|未生成/);
  });

  it("failed>0 なら空本文の件数を再生成案内つきで返す", () => {
    const msg = buildSaleDmPartialNotice({ generated: 8, failed: 2, truncated: false });
    expect(msg).not.toBeNull();
    expect(msg).toContain("2");
    expect(msg).toMatch(/失敗|空|再生成/);
  });

  it("truncated と failed の両方なら両方の行を含む", () => {
    const msg = buildSaleDmPartialNotice({ generated: 50, failed: 3, truncated: true }) ?? "";
    expect(msg).toMatch(/上限|未生成/);
    expect(msg).toMatch(/失敗|空|再生成/);
  });

  it("フィールド未定義(古い/mock レスポンス)は安全側で null", () => {
    expect(buildSaleDmPartialNotice({})).toBeNull();
  });
});
