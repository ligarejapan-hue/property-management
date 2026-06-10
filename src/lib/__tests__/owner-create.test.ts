import { describe, it, expect } from "vitest";
import {
  findMissingOwnerFieldWritePerm,
  findDuplicateOwnerId,
} from "@/lib/owner-create";

const perm = (resource: string, action: string) => ({
  resource,
  action,
  granted: true,
});

describe("findMissingOwnerFieldWritePerm", () => {
  it("提供された全フィールドに write 権限があれば null", () => {
    const perms = [perm("owner_name", "full"), perm("owner_phone", "edit")];
    expect(
      findMissingOwnerFieldWritePerm(perms, { name: "山田太郎", phone: "090" }),
    ).toBeNull();
  });

  it("提供フィールドのうち write 権限が無い最初のものを返す", () => {
    const perms = [perm("owner_name", "full")];
    expect(
      findMissingOwnerFieldWritePerm(perms, { name: "山田太郎", phone: "090" }),
    ).toEqual({ resource: "owner_phone", label: "phone" });
  });

  it("null / undefined のフィールドは権限不要（スキップ）", () => {
    const perms = [perm("owner_name", "full")];
    expect(
      findMissingOwnerFieldWritePerm(perms, {
        name: "山田太郎",
        phone: null,
        address: undefined,
      }),
    ).toBeNull();
  });

  it("read / masked 等の非 write action は書き込み不可とみなす", () => {
    const perms = [
      perm("owner_name", "full"),
      { resource: "owner_phone", action: "masked", granted: true },
    ];
    expect(
      findMissingOwnerFieldWritePerm(perms, { name: "山田太郎", phone: "090" }),
    ).toEqual({ resource: "owner_phone", label: "phone" });
  });
});

describe("findDuplicateOwnerId", () => {
  const candidates = [
    { id: "o1", name: "山田太郎", address: "東京都千代田区1-1" },
    { id: "o2", name: "鈴木花子", address: "大阪府大阪市2-2" },
  ];

  it("address 未指定なら重複判定しない（null）", () => {
    expect(findDuplicateOwnerId({ name: "山田太郎", address: null }, candidates)).toBeNull();
    expect(findDuplicateOwnerId({ name: "山田太郎" }, candidates)).toBeNull();
  });

  it("正規化後に氏名+住所が一致すれば既存 id を返す（氏名の空白差異を吸収）", () => {
    expect(
      findDuplicateOwnerId(
        { name: "山田　太郎", address: "東京都千代田区1-1" },
        candidates,
      ),
    ).toBe("o1");
  });

  it("住所が違えば重複ではない", () => {
    expect(
      findDuplicateOwnerId(
        { name: "山田太郎", address: "神奈川県横浜市9-9" },
        candidates,
      ),
    ).toBeNull();
  });

  it("氏名が違えば（住所同一でも）重複ではない", () => {
    expect(
      findDuplicateOwnerId(
        { name: "佐藤一郎", address: "東京都千代田区1-1" },
        candidates,
      ),
    ).toBeNull();
  });
});
