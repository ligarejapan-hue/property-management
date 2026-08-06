/**
 * 一括取得(薄い版)の安全不変条件を source-static に固定する(外部接続なし)。
 *
 * 目的: 実装が「単発の課金安全を継承する薄い版」から逸脱していないかを回帰で守る。
 *  - 1件処理は既存 runRegistryAutoFetch を呼ぶ(課金経路を再実装しない)
 *  - 候補が複数なら自動選択せず skipped(勝手に1つ買わない)
 *  - certificateType はジョブ値を貫通(owner 直書きを残さない)
 *  - 有料 route は readiness(課金スイッチ+校正)を門にする
 *  - サーバー常駐の無人実行にしない(cron/常駐スケジューラを持たない)
 *  - 進捗は可視項目でフィルタ + 件数再計算(保存 counts を返さない)・PII を項目に載せない
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");
const PROCESS = () => read("src/lib/registry-fetch/bulk/process.ts");
const JOBS = () => read("src/lib/registry-fetch/bulk/jobs.ts");
const CREATE_ROUTE = () => read("src/app/api/registry-fetch/jobs/route.ts");
const PROCESS_ROUTE = () =>
  read("src/app/api/registry-fetch/jobs/[jobId]/process-next/route.ts");

describe("1件処理は単発を再利用し、勝手に選ばない", () => {
  it("process は runRegistryAutoFetch を呼ぶ(課金経路を再実装しない)", () => {
    expect(PROCESS()).toMatch(/runRegistryAutoFetch\(/);
  });

  it("候補が複数(>1)なら自動選択せず skipped(ambiguous)", () => {
    const s = PROCESS();
    expect(s).toMatch(/candidates\.length > 1/);
    expect(s).toMatch(/ambiguous_candidate/);
  });
});

describe("certificateType はジョブ値を貫通する(owner 直書きを残さない)", () => {
  it("process はジョブの certificateType を使い、owner を直書きしない", () => {
    const s = PROCESS();
    expect(s).toMatch(/job0\.certificateType/);
    expect(s).not.toMatch(/certificateType:\s*"owner"/);
  });
});

describe("有料 route は readiness(課金スイッチ+校正)を門にする", () => {
  it("作成 route は requireBulkPurchaseProvider を通す", () => {
    expect(CREATE_ROUTE()).toMatch(/requireBulkPurchaseProvider\(/);
  });
  it("process-next route は requireBulkPurchaseProvider を通す", () => {
    expect(PROCESS_ROUTE()).toMatch(/requireBulkPurchaseProvider\(/);
  });
});

describe("サーバー常駐の無人実行にしない(画面駆動)", () => {
  it("bulk サーバーモジュールに cron/常駐スケジューラを持たない", () => {
    for (const src of [PROCESS(), JOBS()]) {
      expect(src).not.toMatch(/setInterval|cron|node-cron|bull|agenda|setTimeout/i);
    }
  });
});

describe("進捗は可視項目でフィルタ + 件数再計算 + PII 非露出", () => {
  it("getBulkJobProgress は canAccessPropertyRecord でフィルタする", () => {
    expect(JOBS()).toMatch(/canAccessPropertyRecord\(/);
  });
  it("件数は保存 counts でなく可視項目から再計算する", () => {
    expect(JOBS()).toMatch(/recomputeCounts\(/);
  });
  it("進捗の項目に所在・地番・所有者名を載せない(id/propertyId/status/errorCode のみ)", () => {
    const s = JOBS();
    // 進捗 items の map に address/lotNumber/ownerName を混ぜない。
    expect(s).not.toMatch(/items:\s*visibleItems\.map[\s\S]{0,200}address/);
    expect(s).not.toMatch(/items:\s*visibleItems\.map[\s\S]{0,200}lotNumber/);
  });
});
