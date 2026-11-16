/**
 * 所有者補正候補の3つのタブ(法人番号・法人番号紐づけ・住所の登記文字列)から物件へ飛ぶリンク
 * (2026-11-16 発注者の指摘=物件に飛べない)。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/prisma", () => ({ default: {} }));

import { loadOwnerPropertyLinkInfo, withOwnerPropertyLink, type OwnerPropertyLinkDb } from "../owner-property-link-data";
import { ownerPropertyOpenLabel } from "@/components/owners/owner-property-open-link";

const READ = [{ resource: "property", action: "read", granted: true }];
const NO_READ = [{ resource: "owner", action: "read", granted: true }];
const admin = { id: "u1", role: "admin" };
const staff = { id: "u2", role: "field_staff" };

function fakeDb(rows: unknown[]) {
  const findMany = vi.fn(async (_a: unknown) => rows);
  return { db: { owner: { findMany } } as unknown as OwnerPropertyLinkDb, findMany };
}

describe("loadOwnerPropertyLinkInfo", () => {
  it("物件がちょうど1件ならその物件の id・2件以上なら id は返さない・0件は「見られない」", async () => {
    const { db, findMany } = fakeDb([
      { id: "o1", _count: { propertyOwners: 1 }, propertyOwners: [{ propertyId: "p1" }] },
      { id: "o2", _count: { propertyOwners: 3 }, propertyOwners: [{ propertyId: "p1" }, { propertyId: "p2" }] },
      { id: "o3", _count: { propertyOwners: 0 }, propertyOwners: [] },
    ]);
    const m = await loadOwnerPropertyLinkInfo(db, ["o1", "o2", "o3", "o1"], admin as never, READ as never);
    expect(m.get("o1")).toEqual({ count: 1, singlePropertyId: "p1", hasReachableProperty: true, available: true });
    expect(m.get("o2")).toEqual({ count: 3, singlePropertyId: null, hasReachableProperty: true, available: true });
    expect(m.get("o3")).toEqual({ count: 0, singlePropertyId: null, hasReachableProperty: false, available: true });
    const arg = findMany.mock.calls[0][0] as { where: { id: { in: string[] } }; select: { propertyOwners: Record<string, unknown> } };
    // 同じ所有者は1回だけ・物件の行は2件だけ読む・管理者は範囲で絞らない。
    expect(arg.where.id.in).toEqual(["o1", "o2", "o3"]);
    expect(arg.select.propertyOwners).toEqual({ select: { propertyId: true }, take: 2 });
  });

  it("現地担当は、自分の担当の物件だけを読む(担当外の物件の id を渡さない)", async () => {
    const { db, findMany } = fakeDb([{ id: "o1", _count: { propertyOwners: 2 }, propertyOwners: [] }]);
    const m = await loadOwnerPropertyLinkInfo(db, ["o1"], staff as never, READ as never);
    // 件数は2件でも、見られる物件が無ければ「見られない」。
    expect(m.get("o1")).toEqual({ count: 2, singlePropertyId: null, hasReachableProperty: false, available: true });
    const arg = findMany.mock.calls[0][0] as { select: { propertyOwners: { where: unknown } } };
    expect(arg.select.propertyOwners.where).toEqual({
      property: { OR: [{ createdBy: "u2" }, { assignedTo: "u2" }] },
    });
  });

  it("物件の閲覧権限が無ければ、物件の行を読まず、id も「見られるか」も返さない", async () => {
    const { db, findMany } = fakeDb([{ id: "o1", _count: { propertyOwners: 1 } }]);
    const m = await loadOwnerPropertyLinkInfo(db, ["o1"], admin as never, NO_READ as never);
    expect(m.get("o1")).toEqual({ count: 1, singlePropertyId: null, hasReachableProperty: false, available: false });
    const arg = findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(arg.select).not.toHaveProperty("propertyOwners");
  });

  it("所有者が空なら DB を引かない", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await loadOwnerPropertyLinkInfo(db, [], admin as never, READ as never)).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("withOwnerPropertyLink", () => {
  it("行に propertyLink を足す。引けなかった所有者は「物件なし・リンクなし」", () => {
    const info = new Map([["o1", { count: 1, singlePropertyId: "p1", hasReachableProperty: true, available: true }]]);
    expect(withOwnerPropertyLink([{ ownerId: "o1", x: 1 }, { ownerId: "o9", x: 2 }], info)).toEqual([
      { ownerId: "o1", x: 1, propertyLink: { count: 1, singlePropertyId: "p1", hasReachableProperty: true, available: true } },
      { ownerId: "o9", x: 2, propertyLink: { count: 0, singlePropertyId: null, hasReachableProperty: false, available: false } },
    ]);
  });
});

describe("ownerPropertyOpenLabel: リンクの文字と行き先", () => {
  const base = { count: 1, singlePropertyId: "p1", hasReachableProperty: true, available: true };
  it("1件 → その物件の画面へ「物件を開く」", () => {
    expect(ownerPropertyOpenLabel("o1", base)).toEqual({ href: "/properties/p1", text: "物件を開く" });
  });
  it("2件以上 → その所有者で絞り込んだ物件一覧へ「物件を見る(N件)」", () => {
    expect(ownerPropertyOpenLabel("o1", { ...base, count: 3, singlePropertyId: null })).toEqual({
      href: "/properties?ownerId=o1",
      text: "物件を見る(3件)",
    });
  });
  it("物件が無い所有者 → 押せない「物件なし」", () => {
    expect(ownerPropertyOpenLabel("o1", { ...base, count: 0, singlePropertyId: null, hasReachableProperty: false })).toEqual({
      href: null,
      text: "物件なし",
    });
  });
  it("物件はあるが開けない(閲覧権限が無い・担当外)→ 何も出さない(必ず弾かれるリンクを出さない)", () => {
    expect(ownerPropertyOpenLabel("o1", { ...base, available: false })).toEqual({ href: null, text: null });
    expect(ownerPropertyOpenLabel("o1", { ...base, hasReachableProperty: false })).toEqual({ href: null, text: null });
  });
  it("古い応答(材料が無い)→ 何も出さない", () => {
    expect(ownerPropertyOpenLabel("o1", undefined)).toEqual({ href: null, text: null });
  });
});

describe("配線: 3つのタブの読み込み口と画面が、同じ部品を通る", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  it.each([
    ["src/app/api/admin/owners/correction/corporate-number-candidates/route.ts", "page.map((r) => r.ownerId)"],
    ["src/app/api/admin/owners/correction/corporate-restore-candidates/route.ts", "rows.map((r) => r.ownerId)"],
    ["src/app/api/admin/owners/correction/registry-address-candidates/route.ts", "page.map((r) => r.ownerId)"],
  ])("%s は、出す行の所有者の分だけ引いて行に足す", (path, ids) => {
    const s = src(path);
    expect(s).toContain(`await loadOwnerPropertyLinkInfo(prisma, ${ids}, session, perms)`);
    expect(s).toContain("withOwnerPropertyLink(");
  });
  it("画面は3つのタブとも「物件を開く」のリンクを出す", () => {
    const s = src("src/app/(dashboard)/admin/owners/correction/page.tsx");
    expect(s).toContain("<OwnerPropertyOpenLink ownerId={c.ownerId} link={c.propertyLink} />");
    expect((s.match(/<OwnerPropertyOpenLink/g) ?? []).length).toBe(3);
    expect(s).toContain("link={row.propertyLink}");
  });
});
