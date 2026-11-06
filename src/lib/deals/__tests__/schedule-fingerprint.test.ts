import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn() }, property: { findUnique: vi.fn() } } }));

import prismaMock from "@/lib/prisma";
import { registryFingerprint } from "../schedule-sync";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { attachment: { findMany: Fn }; property: { findUnique: Fn } };
const row = (id: string, number: string) => ({ id, kind: "land", location: null, number, realEstateNumber: null, area: null });

beforeEach(() => {
  vi.clearAllMocks();
  pm.attachment.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
  pm.property.findUnique.mockResolvedValue({ lotNumber: "1番", buildingNumber: null, extraParcels: [row("x", "2番")] });
});

describe("段取りの担保の判定に使う謄本の印(この取引の土地・建物・2026-11-06)", () => {
  it("★選んでいない取引は今までと同じ印(反映のあとに全部の取引を読み直させない)・物件を読まない", async () => {
    const before = createHash("sha256").update(["p", "house", "a1", "a2"].join("|")).digest("hex");
    expect(await registryFingerprint("p", "house", null)).toBe(before);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
  });
  it("選びを変えた・選んだ行を直した=印が変わる(読み直す)", async () => {
    const all = await registryFingerprint("p", "house", null);
    const x = await registryFingerprint("p", "house", ["x"]);
    expect(x).not.toBe(all);
    expect(await registryFingerprint("p", "house", ["main:land"])).not.toBe(x);
    pm.property.findUnique.mockResolvedValue({ lotNumber: "1番", buildingNumber: null, extraParcels: [row("x", "3番")] });
    expect(await registryFingerprint("p", "house", ["x"])).not.toBe(x);
  });
  it("★選ばなかった行・住所を直しても印が変わる(謄本の行き先が変わるため・@codex P2)", async () => {
    pm.property.findUnique.mockResolvedValue({ address: "架空市1", lotNumber: "1番", buildingNumber: null, extraParcels: [row("x", "2番")] });
    const before = await registryFingerprint("p", "house", ["main:land"]);
    pm.property.findUnique.mockResolvedValue({ address: "架空市1", lotNumber: "1番", buildingNumber: null, extraParcels: [row("x", "3番")] });
    expect(await registryFingerprint("p", "house", ["main:land"])).not.toBe(before);
    pm.property.findUnique.mockResolvedValue({ address: "架空市2", lotNumber: "1番", buildingNumber: null, extraParcels: [row("x", "2番")] });
    expect(await registryFingerprint("p", "house", ["main:land"])).not.toBe(before);
  });
});
