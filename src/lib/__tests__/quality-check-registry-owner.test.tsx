/**
 * 品質チェックの「登記取得済だが、所有者が最新の謄本の名義と違う」(2026-11-08 発注者決定)。
 * - DM 送付可=エラー・それ以外=警告
 * - 一覧の「警告ありのみ」と品質チェックは1か所の定義(qualityWarningWhere)
 * - 夜の自動の比べは日本時間 2〜5時だけ
 * - 比べ直し待ちは情報として出す・リンクは開ける人にだけ
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/api-helpers", () => ({ ApiError: class extends Error {} }));

import { QUALITY_RULES, qualityWarningWhere, REGISTRY_OWNER_MISMATCH_CODES } from "@/lib/quality-check-rules";
import { nightlyWindowStart } from "@/lib/registry-owner-check/service";
import RegistryOwnerPendingNote from "@/components/registry-owner-review/pending-note";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("謄本の名義と違う の決まり", () => {
  const send = QUALITY_RULES.find((r) => r.code === "REGISTRY_OWNER_MISMATCH_DM_SEND")!;
  const other = QUALITY_RULES.find((r) => r.code === "REGISTRY_OWNER_MISMATCH")!;

  it("DM 送付可はエラー・それ以外は警告", () => {
    expect(send.severity).toBe("error");
    expect(other.severity).toBe("warning");
    expect(send.where).toMatchObject({ dmStatus: "send" });
    expect(other.where).toMatchObject({ dmStatus: { not: "send" } });
  });

  it("取得済・違う・未判断・比べ直し待ちでない だけ", () => {
    for (const r of [send, other]) {
      expect(r.where).toMatchObject({
        registryStatus: "obtained",
        registryOwnerCheck: { is: { result: "mismatch", decision: null, stale: false } },
      });
      expect(r.message).toContain("登記取得済だが、所有者が最新の謄本の名義と違う");
    }
  });

  it("リンクを出す決まりの印は2つ", () => {
    expect([...REGISTRY_OWNER_MISMATCH_CODES].sort()).toEqual([other.code, send.code].sort());
  });
});

describe("警告ありのみ=1か所の定義", () => {
  it("エラーと警告の決まりの OR(情報は入らない)", () => {
    const or = qualityWarningWhere().OR as unknown[];
    expect(or).toHaveLength(QUALITY_RULES.filter((r) => r.severity !== "info").length);
    expect(or).toContainEqual(QUALITY_RULES.find((r) => r.code === "REGISTRY_OWNER_MISMATCH")!.where);
  });

  it("一覧と品質チェックは同じ関数を使い、条件を書き写していない", () => {
    const list = read("src/lib/property-list-query.ts");
    const route = read("src/app/api/properties/quality-check/route.ts");
    expect(list).toContain("qualityWarningWhere()");
    expect(route).toContain("qualityWarningWhere()");
    expect(list).not.toMatch(/\/\/ REGISTRY_DM_MISMATCH/);
    expect(route).not.toMatch(/const QUALITY_RULES/);
  });
});

describe("夜の自動の比べの時間帯(日本時間 2〜5時)", () => {
  const utc = (y: number, m: number, d: number, h: number, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));
  it("1:59 は外・2:00 は中・4:59 は中・5:00 は外", () => {
    expect(nightlyWindowStart(utc(2026, 11, 8, 16, 59))).toBeNull(); // JST 11-09 1:59
    expect(nightlyWindowStart(utc(2026, 11, 8, 17, 0))?.toISOString()).toBe("2026-11-08T17:00:00.000Z"); // JST 2:00
    expect(nightlyWindowStart(utc(2026, 11, 8, 19, 59))?.toISOString()).toBe("2026-11-08T17:00:00.000Z"); // JST 4:59
    expect(nightlyWindowStart(utc(2026, 11, 8, 20, 0))).toBeNull(); // JST 5:00
    expect(nightlyWindowStart(utc(2026, 11, 8, 3, 0))).toBeNull(); // JST 昼 12:00
  });
});

describe("比べ直し待ち(情報)", () => {
  it("件数を出し、開ける人にだけリンク", () => {
    const withLink = renderToStaticMarkup(<RegistryOwnerPendingNote count={1234} canOpen />);
    expect(withLink).toContain("比べ直し待ち");
    expect(withLink).toContain("1,234");
    expect(withLink).toContain('href="/properties/registry-owner-review"');
    const noLink = renderToStaticMarkup(<RegistryOwnerPendingNote count={5} canOpen={false} />);
    expect(noLink).not.toContain("href=");
  });

  it("品質チェックの画面と物件ページは、開ける人にだけリンクを出す", () => {
    const qc = read("src/app/(dashboard)/properties/quality-check/page.tsx");
    expect(qc).toContain("canOpenRegistryOwnerReview && REGISTRY_OWNER_MISMATCH_CODES.has(issue.code)");
    const detail = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(detail).toContain("typed.canOpenRegistryOwnerReview === true");
    const route = read("src/app/api/properties/quality-check/route.ts");
    expect(route).toContain('findMissingRegistryOwnerReviewPerm(perms, "view") === null');
  });
});
