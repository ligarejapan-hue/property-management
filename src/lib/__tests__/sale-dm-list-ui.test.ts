import { describe, it, expect } from "vitest";
import { isDmUndeliverable, canCreateSaleDm } from "../sale-dm-letter/list-ui";

const perm = (resource: string) => ({ resource, action: "read", granted: true });
const genPerm = { resource: "sale_dm", action: "generate", granted: true };

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
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner"), genPerm])).toBe(true);
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
