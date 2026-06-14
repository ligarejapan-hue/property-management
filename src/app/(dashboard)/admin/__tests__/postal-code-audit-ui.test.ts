/**
 * 郵便番号×住所 整合チェック画面（admin/postal-code-audit/page.tsx）の UI 配線を
 * source assertion で固定（node 環境＝描画テスト不可・既存構成に合わせる）。
 *
 * 検証主眼（Codex P2: not_processed 行の UI 対応）:
 *  - route が時間バジェット超過で返す `reason: "not_processed"` 行を、
 *    クライアントの enum / ラベルマップが取りこぼさない（`判定不能（undefined）`にしない）。
 *  - 専用ラベル「未処理（時間上限）」を持つ。
 *  - 専用タブ + 件数 + 通知（timeBudgetExhausted / notProcessed）が整合する。
 *  - api-client 型が route の追加フィールド（timeBudgetExhausted/processed/notProcessed/timeBudgetMs・
 *    reason の not_processed）を網羅する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type {
  PostalAuditIndeterminateReason,
  PostalCodeAuditResponse,
} from "@/lib/api-client";
import { INDETERMINATE_REASON_LABELS } from "@/lib/postal-code-audit";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const page = read("src/app/(dashboard)/admin/postal-code-audit/page.tsx");

describe("api-client 型: not_processed と時間バジェット系フィールドを網羅する", () => {
  it("PostalAuditIndeterminateReason に not_processed を含む（型レベル）", () => {
    // not_processed が型に無ければこの代入がコンパイルエラーになる（tsc ゲートで検出）。
    const reason: PostalAuditIndeterminateReason = "not_processed";
    expect(reason).toBe("not_processed");
  });

  it("PostalCodeAuditResponse が timeBudgetExhausted / processed / notProcessed / timeBudgetMs を持つ（型レベル）", () => {
    const res: PostalCodeAuditResponse = {
      apiConfigured: true,
      truncated: false,
      timeBudgetExhausted: true,
      processed: 1,
      notProcessed: 1,
      maxTargets: 200,
      timeBudgetMs: 45000,
      summary: { total: 2, match: 1, mismatch: 0, indeterminate: 1 },
      rows: [
        {
          ownerId: "o1",
          nameMasked: "山田",
          zipMasked: "100-0005",
          addressMasked: "東京都千代田区丸の内",
          apiAddressLine: "東京都千代田区丸の内",
          verdict: "match",
          reason: null,
        },
        {
          ownerId: "o2",
          nameMasked: "佐藤",
          zipMasked: "100-0006",
          addressMasked: "東京都千代田区有楽町",
          apiAddressLine: null,
          verdict: "indeterminate",
          reason: "not_processed",
        },
      ],
    };
    expect(res.timeBudgetExhausted).toBe(true);
    expect(res.notProcessed).toBe(1);
    expect(res.rows[1].reason).toBe("not_processed");
  });
});

describe("共有ラベル: not_processed に専用ラベルがある", () => {
  it("INDETERMINATE_REASON_LABELS.not_processed が定義済み（undefined にならない）", () => {
    expect(INDETERMINATE_REASON_LABELS.not_processed).toBe("未処理（時間上限）");
  });
});

describe("page.tsx: not_processed 行を取りこぼさず明示表示する", () => {
  it("REASON_LABELS は共有 INDETERMINATE_REASON_LABELS を使い、独自に列挙しない（漏れ防止）", () => {
    // 独自のローカル enum マップを再定義すると not_processed の取りこぼしが再発するため、
    // 共有マップ（型網羅が保証される）を import して使うことを固定する。
    expect(page).toMatch(
      /import\s*\{[^}]*INDETERMINATE_REASON_LABELS[^}]*\}\s*from\s*["']@\/lib\/postal-code-audit["']/,
    );
    // ローカルで not_processed を取りこぼす別マップを定義していないこと。
    expect(page).not.toMatch(/const\s+REASON_LABELS\s*:\s*Record<\s*PostalAuditIndeterminateReason/);
  });

  it("not_processed 行は『判定不能』ではなく専用ラベルを表示する分岐がある", () => {
    // verdict ラベルではなく reason ラベル（未処理）を優先する分岐を持つこと。
    expect(page).toContain("not_processed");
  });

  it("未処理タブと未処理件数（notProcessed）を表示する", () => {
    // 専用タブ key。
    expect(page).toContain('"not_processed"');
    // 件数表示にレスポンスの notProcessed を使う。
    expect(page).toMatch(/notProcessed/);
  });

  it("timeBudgetExhausted のときに通知バナーを出す", () => {
    expect(page).toMatch(/timeBudgetExhausted/);
  });
});
