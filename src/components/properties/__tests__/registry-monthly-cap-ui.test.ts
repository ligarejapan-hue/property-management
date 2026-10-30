import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 月の上限(2026-10-29 発注者決定=5万円/月)の画面の配線。
 *
 * ⚠判断そのもの(入るか・理由の文)は純関数 canAffordCertificate / monthlyCapBlockedReason
 *   で実測している(src/lib/registry-fetch/__tests__/monthly-cap.test.ts)。
 *   ここで固定するのは「画面がその判断に従っている」ことだけ。
 * ⚠このリポは jsdom 未導入のため source-assertion。改行は LF に正規化。
 */
const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SEARCH = read("src/components/properties/registry-location-search-button.tsx");
const BULK = read("src/components/properties/registry-bulk-fetch-button.tsx");
const PROGRESS = read("src/app/(dashboard)/properties/registry-fetch/[jobId]/page.tsx");
const USAGE = read("src/components/properties/registry-monthly-usage.tsx");

describe("共通の部品(今月の有料取得 ◯円/50,000円)", () => {
  it("利用額は専用の API から読み、表示は純関数の文言を使う", () => {
    expect(USAGE).toContain("fetchRegistryMonthlyUsage()");
    expect(USAGE).toContain("describeMonthlyUsage(");
    expect(USAGE).toContain("monthlyCapBlockedReason(");
  });
  it("⚠effect の中で同期 setState をしない(lint 規約)= then/catch の中でだけ更新", () => {
    const at = USAGE.indexOf("useEffect(");
    const body = USAGE.slice(at, USAGE.indexOf("}, [", at));
    expect(body).toContain(".then(");
    expect(body).toContain(".catch(");
  });
});

describe("1件の取得(所在検索のボタン)", () => {
  it("利用額を読み、上限で押せないかを種類の値段で決める", () => {
    expect(SEARCH).toContain("useRegistryMonthlyUsage(");
    expect(SEARCH).toContain("canAffordCertificate(monthlyUsage.usage, certificateType)");
  });

  it("⚠上限なら候補1件でも自動で取得へ進まない(検索のあとの判断に渡す)", () => {
    expect(SEARCH).toContain("purchaseEnabled: purchaseEnabled && !capBlocked,");
  });

  it("⚠「取得する（有料）」は上限なら押せない+理由を出す", () => {
    // ボタンの文字(最後の出現)。手前の説明文・コメントにも同じ語がある。
    const at = SEARCH.lastIndexOf("取得する（有料）");
    const btn = SEARCH.slice(SEARCH.lastIndexOf("<Button", at), at);
    expect(btn).toContain("capBlocked ||");
    expect(btn).toContain("capBlockedReason");
  });

  it("runObtain も上限なら走らない(ボタンの disabled だけに頼らない)", () => {
    const at = SEARCH.indexOf("const runObtain = async (");
    const body = SEARCH.slice(at, SEARCH.indexOf("setLastAction(\"obtain\")", at));
    expect(body).toContain("if (capBlocked) return;");
  });

  it("検索の確認と取得の確認の両方に「今月の有料取得」を出す", () => {
    const n = SEARCH.split("<RegistryMonthlyUsageLine").length - 1;
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("一括取得", () => {
  it("確認の画面に今月の利用額を出し、上限なら開始できない", () => {
    expect(BULK).toContain("useRegistryMonthlyUsage(");
    expect(BULK).toContain("<RegistryMonthlyUsageLine");
    const at = BULK.indexOf("で取得を開始");
    const btn = BULK.slice(BULK.lastIndexOf("<Button", at), at);
    expect(btn).toContain("capBlocked ||");
  });

  it("進捗画面: 上限で止まったときの案内と、今月の利用額", () => {
    expect(PROGRESS).toContain('case "monthly_cap_reached":');
    expect(PROGRESS).toContain("月の上限（5万円）に達したため");
    expect(PROGRESS).toContain('case "monthly_cap_unavailable":');
    expect(PROGRESS).toContain("<RegistryMonthlyUsageLine");
  });
});
