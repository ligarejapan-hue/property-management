import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma";
import { isUploadKeyOwnedByProperty } from "@/lib/uploads-authorization";

function makeDb(photos: { fileUrl: string }[]) {
  return {
    propertyPhoto: { findMany: vi.fn(async () => photos) },
  } as unknown as PrismaClient;
}

describe("isUploadKeyOwnedByProperty", () => {
  it("その物件の写真に正規化後 key が一致すれば true", async () => {
    const db = makeDb([{ fileUrl: "/uploads/properties/p1/a.jpg" }]);
    expect(await isUploadKeyOwnedByProperty("properties/p1/a.jpg", "p1", db)).toBe(true);
  });

  it("候補はあっても正規化後 key が一致しなければ false", async () => {
    const db = makeDb([{ fileUrl: "/uploads/properties/p1/OTHER.jpg" }]);
    expect(await isUploadKeyOwnedByProperty("properties/p1/a.jpg", "p1", db)).toBe(false);
  });

  it("その物件に写真が無ければ false（別物件の key は弾く）", async () => {
    const db = makeDb([]); // findMany(where propertyId=p1) が空 = p1 のものではない
    expect(await isUploadKeyOwnedByProperty("properties/B/a.jpg", "p1", db)).toBe(false);
  });

  it("不正な storage key は DB を引かず false", async () => {
    const db = makeDb([{ fileUrl: "/uploads/properties/p1/a.jpg" }]);
    expect(await isUploadKeyOwnedByProperty("../etc/passwd", "p1", db)).toBe(false);
    expect((db.propertyPhoto.findMany as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
