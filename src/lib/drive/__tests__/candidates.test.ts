/**
 * 「ハマイハイライズ 305 › 売却」のように、物件フォルダの中の「売却/購入」フォルダにも
 * 親フォルダの名前で物件の候補を出す(紐づけるのはその子フォルダ・@codex #577 P2)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: { property: { findMany: vi.fn(async () => []) } },
}));

import { candidatesForChildFolders } from "../candidates";
import type { MatchableProperty } from "../folder-match";

const named: MatchableProperty[] = [
  { id: "p1", buildingName: "ハマイハイライズ", roomNo: "305", address: "東京都大田区大森北1-2-3" },
  { id: "p2", buildingName: "コスモ上野", roomNo: "201", address: "東京都台東区上野1-1" },
];

beforeEach(() => vi.clearAllMocks());

describe("candidatesForChildFolders", () => {
  it("★子フォルダ(売却・購入)自身に候補が無ければ、親フォルダの名前で候補を出す", async () => {
    const r = await candidatesForChildFolders(["売却", "購入"], "ハマイハイライズ 305", new Map(), named);
    expect(r.get("売却")?.map((c) => [c.propertyId, c.reason])).toEqual([["p1", "name_room"]]);
    expect(r.get("購入")?.map((c) => c.propertyId)).toEqual(["p1"]);
  });

  it("子フォルダ自身に候補があればそれを使う(親の候補で上書きしない)", async () => {
    const r = await candidatesForChildFolders(["コスモ上野 201"], "ハマイハイライズ 305", new Map(), named);
    expect(r.get("コスモ上野 201")?.map((c) => c.propertyId)).toEqual(["p2"]);
  });

  it("親が無い(マイドライブ直下・共有アイテム)ときは子の名前だけ", async () => {
    const r = await candidatesForChildFolders(["売却", "ハマイハイライズ 305"], null, new Map(), named);
    expect(r.get("売却")).toEqual([]);
    expect(r.get("ハマイハイライズ 305")?.map((c) => c.propertyId)).toEqual(["p1"]);
  });

  it("紐づけ済みの物件は linkedFolderId を付ける", async () => {
    const r = await candidatesForChildFolders(["売却"], "ハマイハイライズ 305", new Map([["p1", "fX"]]), named);
    expect(r.get("売却")?.[0].linkedFolderId).toBe("fX");
  });
});
