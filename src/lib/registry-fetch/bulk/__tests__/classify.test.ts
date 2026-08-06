/**
 * 一括取得の1件結果分類(classifyItemError)。課金の安全に直結する対応表を固定する。
 *
 * ⚠charged_but_failed は必ず paused(お金が動いた項目を黙って次へ流さない)。
 * ⚠既取得(ALREADY_DONE)は done(単発の30日ガードが二重課金を弾いた=課金なしで取得済み)。
 * ⚠rate_limited は項目を pending のまま残す(件数に数えない=画面が間隔を空けて再試行)。
 */
import { describe, it, expect, vi } from "vitest";

// types.ts は api-helpers(→ next/server) を引くので最小モックで連鎖を切る。
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

import { classifyItemError } from "../types";
import { ApiError } from "@/lib/api-helpers";
import { RegistryFetchError } from "@/lib/registry-fetch";

describe("classifyItemError — 課金の安全に直結する対応表", () => {
  it("charged_but_failed → charged_but_failed + ジョブ一時停止", () => {
    const o = classifyItemError(new RegistryFetchError("charged_but_failed"));
    expect(o.status).toBe("charged_but_failed");
    expect(o.pauseJob).toBe(true);
    expect(o.leavePending).toBe(false);
  });

  it("既取得(REGISTRY_PURCHASE_ALREADY_DONE) → done(二重課金にならない)", () => {
    const o = classifyItemError(
      new ApiError(409, "既に取得済み", "REGISTRY_PURCHASE_ALREADY_DONE"),
    );
    expect(o.status).toBe("done");
    expect(o.pauseJob).toBe(false);
  });

  it("rate_limited → 項目は pending のまま(件数に数えない)", () => {
    const o = classifyItemError(new RegistryFetchError("rate_limited"));
    expect(o.status).toBe("pending");
    expect(o.leavePending).toBe(true);
    expect(o.pauseJob).toBe(false);
  });

  it("cancelled → pending のまま + cancelled フラグ", () => {
    const o = classifyItemError(new RegistryFetchError("cancelled"));
    expect(o.leavePending).toBe(true);
    expect(o.cancelled).toBe(true);
  });

  it("課金スイッチが実行中に落ちた(501) → ジョブ一時停止(pending 維持)", () => {
    const o = classifyItemError(
      new ApiError(501, "利用できません", "REGISTRY_PURCHASE_NOT_ENABLED"),
    );
    expect(o.pauseJob).toBe(true);
    expect(o.leavePending).toBe(true);
  });

  it.each(["not_found", "location_rejected"] as const)(
    "%s(要手動) → skipped で次の項目へ",
    (code) => {
      const o = classifyItemError(new RegistryFetchError(code));
      expect(o.status).toBe("skipped");
      expect(o.pauseJob).toBe(false);
    },
  );

  it.each(["timeout", "provider_error", "auth_failed", "service_hours", "service_unavailable"] as const)(
    "%s(一時的) → failed で次の項目へ",
    (code) => {
      const o = classifyItemError(new RegistryFetchError(code));
      expect(o.status).toBe("failed");
      expect(o.pauseJob).toBe(false);
    },
  );

  it("物件変化/施錠競合(409)・アクセス喪失(403) → skipped", () => {
    expect(classifyItemError(new ApiError(409, "x", "CONFLICT")).status).toBe("skipped");
    expect(classifyItemError(new ApiError(403, "x", "FORBIDDEN")).status).toBe("skipped");
  });

  it("想定外(Prisma 等) → failed(ジョブは止めない)", () => {
    const o = classifyItemError(new Error("db down"));
    expect(o.status).toBe("failed");
    expect(o.pauseJob).toBe(false);
  });
});
