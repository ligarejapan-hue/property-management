/**
 * 謄本の有料請求まわりの安全機構（段階②）。
 *
 * ここで守るのは「お金」。取得の失敗はやり直せるが**誤課金は取り返せない**ので、
 * 判断の分岐を全部この単体テストで固定する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  REGISTRY_ROW_STATUS,
  REGISTRY_PDF_EXPIRED,
  canChargeRow,
  canDownloadRow,
  describeRowStatus,
  purchaseIdempotencyKey,
  runExclusivePurchase,
  __resetPurchaseChainForTest,
  RegistryChargedButFailedError,
  isRetryableFailure,
} from "@/lib/registry-fetch/purchase-safety";

describe("課金してよい行の判定（サイト側 myPageSeikyu と同じ規則）", () => {
  it("「未請求」だけ課金できる", () => {
    expect(canChargeRow(REGISTRY_ROW_STATUS.unrequested)).toBe(true);
  });

  it("⚠「請求済」は課金しない（二重課金）", () => {
    expect(canChargeRow(REGISTRY_ROW_STATUS.requested)).toBe(false);
  });

  it.each([
    REGISTRY_ROW_STATUS.cancelled,
    REGISTRY_ROW_STATUS.sizeError,
    REGISTRY_ROW_STATUS.notFound,
    "",
    "見たことのない状態",
  ])("想定外の状態 %s では課金しない（fail-closed）", (s) => {
    expect(canChargeRow(s)).toBe(false);
  });

  it("前後の空白があっても判定は変わらない", () => {
    expect(canChargeRow(" 未請求 ")).toBe(true);
    expect(canChargeRow(" 請求済 ")).toBe(false);
  });
});

describe("PDFを取ってよい行の判定（サイト側 myPageDownload と同じ規則）", () => {
  it("請求済み かつ 期限内なら取れる", () => {
    expect(canDownloadRow(REGISTRY_ROW_STATUS.requested, "2026/08/31")).toBe(
      true,
    );
  });

  it("期限切れは取れない", () => {
    expect(
      canDownloadRow(REGISTRY_ROW_STATUS.requested, REGISTRY_PDF_EXPIRED),
    ).toBe(false);
  });

  it("未請求では取れない（課金前に取りに行かない）", () => {
    expect(canDownloadRow(REGISTRY_ROW_STATUS.unrequested, "2026/08/31")).toBe(
      false,
    );
  });
});

describe("状態の説明（黙って握りつぶさない）", () => {
  it("該当なし・取消済・容量エラー・取得済みはそれぞれ理由が出る", () => {
    expect(describeRowStatus(REGISTRY_ROW_STATUS.notFound)).toContain(
      "該当する不動産がありません",
    );
    expect(describeRowStatus(REGISTRY_ROW_STATUS.cancelled)).toContain(
      "取り消され",
    );
    expect(describeRowStatus(REGISTRY_ROW_STATUS.sizeError)).toContain(
      "大きすぎて",
    );
    expect(describeRowStatus(REGISTRY_ROW_STATUS.requested)).toContain(
      "取得済み",
    );
  });

  it("未知の状態でも状態名を添えて返す（原因不明で終わらせない）", () => {
    expect(describeRowStatus("謎の状態")).toContain("謎の状態");
  });
});

describe("二重課金の鍵（表記ゆれで別物と誤認しない）", () => {
  const base = {
    propertyId: "p1",
    address: "千代田区丸の内一丁目",
    lotOrBuilding: "1-1",
    certificateType: "owner",
  };

  it("同じ内容なら同じ鍵", () => {
    expect(purchaseIdempotencyKey(base)).toBe(purchaseIdempotencyKey({ ...base }));
  });

  it.each([
    ["全角ハイフン", "１－１"],
    ["長音記号", "1ー1"],
    ["空白入り", " 1 - 1 "],
    ["全角数字", "１-１"],
  ])("%s でも同じ鍵になる（＝二重課金しない）", (_label, lot) => {
    expect(purchaseIdempotencyKey({ ...base, lotOrBuilding: lot })).toBe(
      purchaseIdempotencyKey(base),
    );
  });

  it("物件・地番・種別のどれかが違えば別の鍵", () => {
    expect(purchaseIdempotencyKey({ ...base, propertyId: "p2" })).not.toBe(
      purchaseIdempotencyKey(base),
    );
    expect(purchaseIdempotencyKey({ ...base, lotOrBuilding: "1-2" })).not.toBe(
      purchaseIdempotencyKey(base),
    );
    expect(purchaseIdempotencyKey({ ...base, certificateType: "all" })).not.toBe(
      purchaseIdempotencyKey(base),
    );
  });
});

describe("直列化（同時に2件請求しない）", () => {
  beforeEach(() => __resetPurchaseChainForTest());

  it("重ねて呼んでも1件ずつ順番に実行される", async () => {
    const order: string[] = [];
    const make = (name: string, ms: number) => () =>
      new Promise<void>((resolve) => {
        order.push(`${name}:start`);
        setTimeout(() => {
          order.push(`${name}:end`);
          resolve();
        }, ms);
      });

    vi.useFakeTimers();
    const a = runExclusivePurchase(make("A", 50));
    const b = runExclusivePurchase(make("B", 10));
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);
    vi.useRealTimers();

    // B は A の終了後に始まる（重なりゼロ）
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("⚠1件が失敗しても後続は実行される（列が詰まらない）", async () => {
    const failed = runExclusivePurchase(() =>
      Promise.reject(new Error("boom")),
    );
    await expect(failed).rejects.toThrow("boom");
    await expect(runExclusivePurchase(() => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
  });

  it("戻り値はそのまま呼び出し元へ返る", async () => {
    await expect(runExclusivePurchase(() => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });
});

describe("課金境界（押した後は自動で再試行しない）", () => {
  it("課金後の失敗は再試行不可と分類される", () => {
    const err = new RegistryChargedButFailedError("dl failed", "download");
    expect(isRetryableFailure(err)).toBe(false);
    expect(err.charged).toBe(true);
    expect(err.step).toBe("download");
  });

  it("課金前の失敗は再試行してよい", () => {
    expect(isRetryableFailure(new Error("login failed"))).toBe(true);
  });
});
