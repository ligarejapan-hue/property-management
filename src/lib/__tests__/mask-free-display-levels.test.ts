/**
 * 「マスク無しで見える」表示レベルの集合は、**maskValue の実測**で決める。
 *
 * ⚠閾値を手で書かない（@codex PR#414 17巡目 ①）。書くと maskValue 側が変わった
 *   ときに静かに食い違い、「画面では伏せているのに文書では生で見える」が再発する。
 */
import { describe, it, expect } from "vitest";
import {
  maskValue,
  isMaskFreeLevel,
  MASK_FREE_DISPLAY_LEVELS,
  OWNER_DISPLAY_LEVELS,
  resolveOwnerDisplayConfig,
} from "@/lib/permissions";

describe("MASK_FREE_DISPLAY_LEVELS（実測）", () => {
  it("★maskValue が値をそのまま返すレベルだけが入っている", () => {
    const probe = "ABCDEFGHIJ";
    for (const level of OWNER_DISPLAY_LEVELS) {
      const passesThrough = maskValue(probe, level) === probe;
      expect(isMaskFreeLevel(level), `${level}: ${maskValue(probe, level)}`).toBe(
        passesThrough,
      );
    }
  });

  it("★実測の結果（この時点の maskValue では edit / full / read）", () => {
    // 集合そのものも書き残す。maskValue を変えたらここが落ちて気づける。
    expect([...MASK_FREE_DISPLAY_LEVELS].sort()).toEqual(["edit", "full", "read"]);
  });

  it("★伏せるレベルは1つも含まない", () => {
    for (const level of ["partial", "masked", "hidden"]) {
      expect(isMaskFreeLevel(level), level).toBe(false);
    }
  });

  it("知らないレベルは素通し扱いにしない（fail-closed）", () => {
    expect(isMaskFreeLevel("unknown-level")).toBe(false);
    expect(isMaskFreeLevel("")).toBe(false);
  });
});

describe("resolveOwnerDisplayConfig（純関数・api-helpers と実装を1本にした）", () => {
  it("★項目ごとに一番強いレベルを採る", () => {
    const cfg = resolveOwnerDisplayConfig([
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_phone", action: "masked", granted: true },
      { resource: "owner_address", action: "partial", granted: true },
    ]);
    expect(cfg.name).toBe("full");
    expect(cfg.phone).toBe("masked");
    expect(cfg.address).toBe("partial");
  });

  it("★指定が無い項目は hidden（fail-closed）", () => {
    const cfg = resolveOwnerDisplayConfig([]);
    expect(cfg.name).toBe("hidden");
    expect(cfg.address).toBe("hidden");
  });

  it("★owner_email は未設定なら owner_phone を継承する（既存挙動）", () => {
    const cfg = resolveOwnerDisplayConfig([
      { resource: "owner_phone", action: "masked", granted: true },
    ]);
    expect(cfg.email).toBe("masked");
  });

  it("★owner_corporate_number は未設定なら owner_name を継承する（既存挙動）", () => {
    const cfg = resolveOwnerDisplayConfig([
      { resource: "owner_name", action: "read", granted: true },
    ]);
    expect(cfg.corporateNumber).toBe("read");
  });
});
