/**
 * 謄本の請求種別(所有者事項/全部事項)の2択の検証。
 *
 * 発注者要望 (2026-08-05):「取得前に全部事項か所有者事項か選びたい」。
 *
 * ⚠この機能の肝は**買うのは1種だけ**にすること。サイトの初期状態は全部事項ONなので、
 * 選んだ種別だけをONにし、もう一方の買える種別 + 図面類を全部OFFにしないと、
 * **2通買う**(=二重課金)ことになる。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// auto-fetch.ts は prisma/api-helpers 経由で next-auth を引くため、純関数だけ使う
// このテストでは最小モックで連鎖を切る（playwright-adapter.test.ts と同型）。
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import { certificateCheckboxPlan } from "@/lib/registry-fetch/auto-fetch";
import {
  DEFAULT_CERTIFICATE_TYPE,
  type RegistryCertificateType,
} from "@/lib/registry-fetch/types";
import { purchaseIdempotencyKey } from "@/lib/registry-fetch/purchase-safety";

describe("certificateCheckboxPlan — 買うのは1種だけ", () => {
  it("所有者事項: #fuShoyusya を ON・#fuAll を含む残りを OFF", () => {
    const plan = certificateCheckboxPlan("owner");
    expect(plan.on).toBe("#fuShoyusya");
    // ⚠もう一方の「買える種別」(#fuAll)を必ず OFF に含める(両方ONで2通買わない)。
    expect(plan.off).toContain("#fuAll");
    expect(plan.off).not.toContain("#fuShoyusya");
    // 図面類・閉鎖登記記録も全部 OFF。
    for (const sel of ["#fuChizu", "#fuShozai", "#fuChieki", "#fuZumen", "#fuHeisaTokibo"]) {
      expect(plan.off).toContain(sel);
    }
  });

  it("全部事項: #fuAll を ON・#fuShoyusya を含む残りを OFF", () => {
    const plan = certificateCheckboxPlan("all");
    expect(plan.on).toBe("#fuAll");
    // ⚠もう一方の「買える種別」(#fuShoyusya)を必ず OFF に含める。
    expect(plan.off).toContain("#fuShoyusya");
    expect(plan.off).not.toContain("#fuAll");
    for (const sel of ["#fuChizu", "#fuShozai", "#fuChieki", "#fuZumen", "#fuHeisaTokibo"]) {
      expect(plan.off).toContain(sel);
    }
  });

  it("⚠on は off に含まれない(同じ要素をONかつOFFにしない)", () => {
    for (const t of ["owner", "all"] as RegistryCertificateType[]) {
      const plan = certificateCheckboxPlan(t);
      expect(plan.off).not.toContain(plan.on);
    }
  });
});

describe("既定は所有者事項(安い方)", () => {
  it("DEFAULT_CERTIFICATE_TYPE は owner", () => {
    expect(DEFAULT_CERTIFICATE_TYPE).toBe("owner");
  });
});

describe("⚠種別で二重課金の鍵が変わる(owner と all は別購入)", () => {
  it("同じ物件×地番でも種別が違えば別の鍵になる", () => {
    const base = { propertyId: "p1", lotOrBuilding: "1-1" };
    const ownerKey = purchaseIdempotencyKey({ ...base, certificateType: "owner" });
    const allKey = purchaseIdempotencyKey({ ...base, certificateType: "all" });
    expect(ownerKey).not.toBe(allKey);
  });
});

describe("配線（種別を鍵と provider 請求の両方へ同じ値で通す）", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");
  const AUTO = () => read("src/lib/registry-fetch/auto-fetch.ts");

  it("⚠owner の直書きが購入経路に残っていない", () => {
    const s = AUTO();
    // 種別は1か所で確定させ、鍵と請求で使い回す。
    expect(s).toMatch(
      /const certificateType: RegistryCertificateType =\s*\n?\s*args\.certificateType \?\? DEFAULT_CERTIFICATE_TYPE/,
    );
    // purchaseIdempotencyKey と provider 請求の両方が同じ変数を使う。
    expect(s).not.toMatch(/certificateType: "owner"/);
  });

  it("DOM操作は input.certificateType を実際に読む", () => {
    // 型だけ通して owner 固定のままにしない(実際の請求種別が変わらない事故を防ぐ)。
    expect(AUTO()).toMatch(
      /certificateCheckboxPlan\(input\.certificateType\)/,
    );
  });

  it("台帳・監査 detail に種別を残す(非PII)", () => {
    const s = AUTO();
    expect(s).toMatch(/outcome: "charged", certificateType/);
    expect(s).toMatch(/outcome: "charged_but_failed",\s*\n?\s*certificateType/);
  });
});
