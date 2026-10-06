import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { applyBuildingLink } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

/**
 * キーごとの順番待ち(2人で1つを共有する)。lock を取った人は、自分の apply が終わったとき
 * (=トランザクションの終わり)に release する。
 */
function makeSharedLocks() {
  const tails = new Map<string, Promise<void>>();
  return () => {
    let release: () => void = () => {};
    const lock = async (key: string) => {
      const prev = tails.get(key) ?? Promise.resolve();
      const mine = new Promise<void>((r) => (release = r));
      tails.set(key, prev.then(() => mine));
      await prev;
    };
    return { lock, release: () => release() };
  };
}

const NAMES = [
  ["パークハウス第一", "パークハウス第１"],
  ["パークハウス第１", "パークハウス第一"],
  ["パークハウス第1", "パークハウス第1"],
];

describe("同時に同じ新しい建物を登録しても棟は1つ", () => {
  for (const [a, b] of NAMES) {
    for (const startOrder of [[0, 1], [1, 0]] as const) {
      it(`${a} / ${b}・開始順 ${startOrder.join("→")}`, async () => {
        const db: FakeDb = {
          buildings: [],
          properties: [
            { id: "p0", buildingId: null, buildingName: a },
            { id: "p1", buildingId: null, buildingName: b },
          ],
          executed: [],
        };
        const names = [a, b];
        const newHolder = makeSharedLocks();
        const runs = startOrder.map((idx) => {
          const holder = newHolder();
          const tx = createFakeBuildingTx(db, holder.lock);
          return applyBuildingLink(tx, {
            propertyId: `p${idx}`,
            propertyType: "apartment_unit",
            buildingName: names[idx],
            address: "東京都大田区南雪谷1丁目164-2-45",
            buildingNumber: "164-2-45",
            choice: AUTO_CHOICE,
            currentBuildingId: null,
            userId: "u",
          }).finally(holder.release);
        });
        await Promise.all(runs);
        expect(db.buildings).toHaveLength(1);
        expect(db.properties.every((p) => p.buildingId === db.buildings[0].id)).toBe(true);
        expect(new Set(db.properties.map((p) => p.buildingName)).size).toBe(1);
      });
    }
  }
});
