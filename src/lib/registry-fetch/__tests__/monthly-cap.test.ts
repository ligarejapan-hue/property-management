/**
 * 謄本の有料取得「月の上限=5万円」(2026-10-29 発注者決定)の純関数。
 *
 *  - 日本時間の暦月で数える(監査ログの時刻は UTC 格納)
 *  - 数えるのは二重課金ガードと同じ台帳(registry_location_purchase)。
 *    charged / charged_but_failed の両方=課金した・した可能性がある取得
 *  - 1回の取得で「charged」→後段の失敗で「charged_but_failed」が続けて書かれる
 *    ことがある(同じ鍵)。これは1件として数える
 *  - 種別で値段が違う。分からない記録は高い方で数える(安全側)
 */
import { describe, it, expect } from "vitest";
import {
  REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
  REGISTRY_CERTIFICATE_PRICE_YEN,
  REGISTRY_PURCHASE_LEDGER_ACTION,
  registryCertificatePriceYen,
  jstMonthRange,
  sumMonthlyPurchaseYen,
  decideMonthlyCap,
  formatYen,
  describeMonthlyUsage,
  canAffordCertificate,
  monthlyCapBlockedReason,
} from "../monthly-cap";
import * as fs from "fs";
import * as path from "path";

const OWNER = REGISTRY_CERTIFICATE_PRICE_YEN.owner;
const ALL = REGISTRY_CERTIFICATE_PRICE_YEN.all;

describe("定数", () => {
  it("上限は 50,000円", () => {
    expect(REGISTRY_PURCHASE_MONTHLY_CAP_YEN).toBe(50_000);
  });
  it("所有者事項は実測の 140円・全部事項はそれ以上", () => {
    expect(OWNER).toBe(140);
    expect(ALL).toBeGreaterThan(OWNER);
  });
  it("数える台帳は二重課金ガードの台帳と同じ action(定義元は1つ)", () => {
    expect(REGISTRY_PURCHASE_LEDGER_ACTION).toBe("registry_location_purchase");
    // auto-fetch.ts(画面からは読めない重いモジュール)の台帳名は、ここの定数をそのまま使う。
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /export const REGISTRY_PURCHASE_AUDIT_ACTION\s*=\s*REGISTRY_PURCHASE_LEDGER_ACTION;/,
    );
  });
});

describe("registryCertificatePriceYen", () => {
  it("種別ごとの値段", () => {
    expect(registryCertificatePriceYen("owner")).toBe(OWNER);
    expect(registryCertificatePriceYen("all")).toBe(ALL);
  });
  it("⚠分からない種別は高い方で数える(安全側)", () => {
    expect(registryCertificatePriceYen(undefined)).toBe(ALL);
    expect(registryCertificatePriceYen(null)).toBe(ALL);
    expect(registryCertificatePriceYen("xyz")).toBe(ALL);
  });
});

describe("jstMonthRange(日本時間の暦月)", () => {
  it("UTC 10/31 15:00 = 日本時間 11/1 0:00 → 11月", () => {
    const r = jstMonthRange(new Date("2026-10-31T15:00:00.000Z"));
    expect(r.start.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-30T15:00:00.000Z");
  });
  it("UTC 10/31 14:59:59.999 = 日本時間 10/31 23:59 → 10月", () => {
    const r = jstMonthRange(new Date("2026-10-31T14:59:59.999Z"));
    expect(r.start.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-31T15:00:00.000Z");
  });
  it("年またぎ(日本時間 12月)", () => {
    const r = jstMonthRange(new Date("2026-12-15T00:00:00.000Z"));
    expect(r.start.toISOString()).toBe("2026-11-30T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-12-31T15:00:00.000Z");
  });
  it("日本時間 1/1 0:00 ちょうどは新しい年の1月", () => {
    const r = jstMonthRange(new Date("2026-12-31T15:00:00.000Z"));
    expect(r.start.toISOString()).toBe("2026-12-31T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2027-01-31T15:00:00.000Z");
  });
});

describe("sumMonthlyPurchaseYen", () => {
  const range = jstMonthRange(new Date("2026-10-15T00:00:00.000Z"));
  const at = (iso: string) => new Date(iso);
  const row = (
    iso: string,
    detail: Record<string, unknown> | null,
  ) => ({ createdAt: at(iso), detail });

  it("charged と charged_but_failed の両方を数える(種別の値段で)", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-02T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-10-03T00:00:00Z", { purchaseKeyHash: "b", outcome: "charged_but_failed", certificateType: "all" }),
        ],
        range,
      ),
    ).toBe(OWNER + ALL);
  });

  it("⚠同じ取得の charged → charged_but_failed の組は1件として数える", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-02T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-10-02T00:03:00Z", { purchaseKeyHash: "a", outcome: "charged_but_failed", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER);
  });

  it("⚠月の境をまたいだ組(前月末に charged・月初に charged_but_failed)は今月に数えない", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-09-30T14:59:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-09-30T15:01:00Z", { purchaseKeyHash: "a", outcome: "charged_but_failed", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(0);
  });

  it("鍵が違えば別の取得として数える", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-02T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-10-02T00:03:00Z", { purchaseKeyHash: "b", outcome: "charged_but_failed", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER * 2);
  });

  it("⚠charged が2つ続いても(再取得)両方数える=組にするのは charged_but_failed だけ", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-01T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-10-31T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER * 2);
  });

  it("⚠1日より離れた charged_but_failed は組にしない(別の取得とみなす=多めに数える)", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-01T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-10-03T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged_but_failed", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER * 2);
  });

  it("⚠中身が読めない記録も数える(高い方)=迷う記録は安全側", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-02T00:00:00Z", null),
          row("2026-10-02T00:00:00Z", { outcome: "charged" }),
          row("2026-10-02T00:00:00Z", { purchaseKeyHash: "z", outcome: "unknown", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(ALL + ALL + OWNER);
  });

  it("月の外(前月・翌月)は数えない・境は [月初, 翌月初)", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-09-30T14:59:59.999Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
          row("2026-09-30T15:00:00.000Z", { purchaseKeyHash: "b", outcome: "charged", certificateType: "owner" }),
          row("2026-10-31T14:59:59.999Z", { purchaseKeyHash: "c", outcome: "charged", certificateType: "owner" }),
          row("2026-10-31T15:00:00.000Z", { purchaseKeyHash: "d", outcome: "charged", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER * 2);
  });

  it("並び順に依存しない(古い順に並べ直してから組を作る)", () => {
    expect(
      sumMonthlyPurchaseYen(
        [
          row("2026-10-02T00:03:00Z", { purchaseKeyHash: "a", outcome: "charged_but_failed", certificateType: "owner" }),
          row("2026-10-02T00:00:00Z", { purchaseKeyHash: "a", outcome: "charged", certificateType: "owner" }),
        ],
        range,
      ),
    ).toBe(OWNER);
  });
});

describe("decideMonthlyCap", () => {
  const cap = 50_000;
  it("今月の額+取得中+今回 ≤ 上限なら進む(ちょうど上限も可)", () => {
    expect(
      decideMonthlyCap({ spentYen: 49_860, pendingYen: 0, priceYen: 140, capYen: cap }),
    ).toMatchObject({ allowed: true, usedYen: 49_860 });
  });
  it("⚠超えるなら止める", () => {
    expect(
      decideMonthlyCap({ spentYen: 49_861, pendingYen: 0, priceYen: 140, capYen: cap }),
    ).toMatchObject({ allowed: false, usedYen: 49_861, remainingYen: 139 });
  });
  it("⚠取得中(まだ台帳に無い)ぶんも足して判定する", () => {
    expect(
      decideMonthlyCap({ spentYen: 49_720, pendingYen: 140, priceYen: 140, capYen: cap }),
    ).toMatchObject({ allowed: true });
    expect(
      decideMonthlyCap({ spentYen: 49_721, pendingYen: 140, priceYen: 140, capYen: cap }),
    ).toMatchObject({ allowed: false });
  });
  it("残りは負にならない", () => {
    expect(
      decideMonthlyCap({ spentYen: 60_000, pendingYen: 0, priceYen: 140, capYen: cap }).remainingYen,
    ).toBe(0);
  });
});

describe("表示", () => {
  it("formatYen は3桁区切り", () => {
    expect(formatYen(0)).toBe("0円");
    expect(formatYen(1400)).toBe("1,400円");
    expect(formatYen(50000)).toBe("50,000円");
  });
  it("今月の有料取得 ◯円/50,000円", () => {
    expect(describeMonthlyUsage(1400, 50_000)).toBe("今月の有料取得 1,400円/50,000円");
  });
});

describe("canAffordCertificate / monthlyCapBlockedReason(画面のボタンの可否と理由)", () => {
  const usage = (usedYen: number) => ({ usedYen, capYen: 50_000 });
  it("入るなら押せる・理由なし", () => {
    expect(canAffordCertificate(usage(49_860), "owner")).toBe(true);
    expect(monthlyCapBlockedReason(usage(49_860), "owner")).toBeNull();
  });
  it("⚠上限に達したら押せない+理由「月の上限（5万円）に達したため…」", () => {
    expect(canAffordCertificate(usage(49_861), "owner")).toBe(false);
    expect(monthlyCapBlockedReason(usage(49_861), "owner")).toBe(
      "月の上限（5万円）に達したため、今月はこれ以上取得できません（来月1日から取得できます）。",
    );
  });
  it("所有者事項は入るが全部事項は入らない残り → 全部事項だけ止め、残りの額を伝える", () => {
    expect(canAffordCertificate(usage(49_860), "all")).toBe(false);
    expect(monthlyCapBlockedReason(usage(49_860), "all")).toBe(
      "今月の残り（140円）では全部事項は取得できません（月の上限 5万円）。所有者事項なら取得できます。",
    );
  });
});
