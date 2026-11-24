/**
 * 重複候補のグループを「この1人に全部まとめる」(2026-11-24 発注者承認)。
 *
 * - runGroupMergeAll: 1人ずつ「確認(dryRun)→実行」を順に呼ぶ。毎回最新の版で実行し、
 *   途中で止まった人がいても残りは続け、1人ずつの結果を返す。
 * - OwnerGroupMergeAllButton: ボタンの文言・確認は1回だけ(SSR とソースで確認)。
 * - page.tsx: 法人番号一致・法人名一致のグループもまとめられる・説明文。
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { runGroupMergeAll } from "../owner-merge-all";
import { mergeBlockReasonLabel } from "../owner-merge-reason-labels";
import { OwnerGroupMergeAllButton } from "@/components/owners/OwnerGroupMergeAllButton";

const MASTER = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const S2 = "33333333-3333-4333-8333-333333333333";
const S3 = "44444444-4444-4444-8444-444444444444";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runGroupMergeAll", () => {
  it("1人ずつ dryRun で最新の版を取ってから実行する（master の版は毎回上がる）", async () => {
    let masterVersion = 1;
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (body.dryRun === true) {
        return jsonResponse({
          executed: false,
          eligible: true,
          blockReasons: [],
          summary: { masterVersion, sourceVersion: 2 },
        });
      }
      masterVersion += 1;
      return jsonResponse({ executed: true, masterVersion });
    });
    const results = await runGroupMergeAll({
      masterId: MASTER,
      sourceIds: [S1, S2],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results).toEqual([
      { sourceId: S1, ok: true, reasons: [], message: null },
      { sourceId: S2, ok: true, reasons: [], message: null },
    ]);
    // 確認(dryRun)には仮の版 1 を渡す（API が版を必須にしているため）。実行は確認で取った版。
    expect(calls.map((c) => [c.sourceId, c.dryRun, c.masterVersion])).toEqual([
      [S1, true, 1],
      [S1, false, 1],
      [S2, true, 1],
      [S2, false, 2],
    ]);
    for (const c of calls) {
      expect(fetchFn).toHaveBeenCalledWith(
        "/api/admin/owners/correction/merge",
        expect.objectContaining({ method: "POST" }),
      );
      expect(c.masterId).toBe(MASTER);
    }
  });

  it("止まった人がいても残りは続け、理由を返す（確認で止まった人は実行しない）", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.sourceId === S1 && body.dryRun === true) {
        return jsonResponse({
          executed: false,
          eligible: false,
          blockReasons: ["source_has_note"],
          summary: { masterVersion: 1, sourceVersion: 1 },
        });
      }
      if (body.sourceId === S2 && body.dryRun === false) {
        return jsonResponse(
          { error: { message: "統合条件を満たしていません", blockReasons: ["version_mismatch"] } },
          409,
        );
      }
      if (body.dryRun === true) {
        return jsonResponse({
          executed: false,
          eligible: true,
          blockReasons: [],
          summary: { masterVersion: 1, sourceVersion: 1 },
        });
      }
      return jsonResponse({ executed: true });
    });
    const results = await runGroupMergeAll({
      masterId: MASTER,
      sourceIds: [S1, S2, S3],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results[0]).toEqual({ sourceId: S1, ok: false, reasons: ["source_has_note"], message: null });
    expect(results[1]).toEqual({
      sourceId: S2,
      ok: false,
      reasons: ["version_mismatch"],
      message: "統合条件を満たしていません",
    });
    expect(results[2].ok).toBe(true);
    const executed = fetchFn.mock.calls
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((b) => b.dryRun === false)
      .map((b) => b.sourceId);
    expect(executed).toEqual([S2, S3]);
  });

  it("通信エラーもその人の結果として返し、次へ進む", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.sourceId === S1) throw new Error("network down");
      if (body.dryRun === true) {
        return jsonResponse({ eligible: true, blockReasons: [], summary: { masterVersion: 1, sourceVersion: 1 } });
      }
      return jsonResponse({ executed: true });
    });
    const results = await runGroupMergeAll({
      masterId: MASTER,
      sourceIds: [S1, S2],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results[0]).toEqual({ sourceId: S1, ok: false, reasons: [], message: "network down" });
    expect(results[1].ok).toBe(true);
  });

  it("master 自身は相手に入れない", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ eligible: true, blockReasons: [], summary: { masterVersion: 1, sourceVersion: 1 } }),
    );
    const results = await runGroupMergeAll({
      masterId: MASTER,
      sourceIds: [MASTER, S1],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results.map((r) => r.sourceId)).toEqual([S1]);
  });
});

describe("mergeBlockReasonLabel", () => {
  it("新しい理由・旧い理由・現住所の食い違いを日本語で返す", () => {
    expect(mergeBlockReasonLabel("owner_identity_mismatch")).toMatch(/同じ所有者/);
    expect(mergeBlockReasonLabel("corporate_number_conflict")).toMatch(/法人番号/);
    expect(mergeBlockReasonLabel("name_address_normalize_mismatch")).toMatch(/氏名・住所/);
    expect(mergeBlockReasonLabel("current_address_conflict")).toMatch(/現住所/);
    expect(mergeBlockReasonLabel("current_zip_conflict")).toMatch(/郵便番号/);
    expect(mergeBlockReasonLabel("unknown_code")).toBe("unknown_code");
  });
});

describe("OwnerGroupMergeAllButton", () => {
  it("ボタンの文言と、まとめる人数を出す", () => {
    const html = renderToStaticMarkup(
      <OwnerGroupMergeAllButton masterId={MASTER} sourceIds={[S1, S2]} />,
    );
    expect(html).toContain("この1人に全部まとめる");
    expect(html).toContain("2人");
  });

  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/owners/OwnerGroupMergeAllButton.tsx"),
    "utf8",
  );
  it("確認は1回だけ（window.confirm を1か所）で、結果を1人ずつ 成功 / 止まった理由 で出す", () => {
    expect(src.match(/window\.confirm\(/g)).toHaveLength(1);
    expect(src).toContain("runGroupMergeAll");
    expect(src).toContain("成功");
    expect(src).toContain("止まった");
    expect(src).toContain("mergeBlockReasonLabel");
  });
});

// @codex P2: 一覧の読み直し(load → loading=true)でボタンが外れ、結果が消えていた。
// 結果を閉じるまで一覧を読み直さない(閉じるボタンで読み直す)。
describe("OwnerGroupMergeAllButton: 結果を一覧の読み直しで消さない", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/owners/OwnerGroupMergeAllButton.tsx"),
    "utf8",
  );
  const fnBody = (name: string) => {
    const start = src.indexOf(`const ${name} = `);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf("\n  const ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  it("実行の直後には onExecuted を呼ばない（結果を出したまま）", () => {
    expect(fnBody("handleClick")).not.toContain("onExecuted");
  });
  it("結果を閉じるときに、1人以上まとまっていれば一覧を読み直す", () => {
    const body = fnBody("handleClose");
    expect(body).toContain("onExecuted");
    expect(body).toMatch(/\.some\(\(x\)\s*=>\s*x\.ok\)/);
    expect(src).toContain("閉じて一覧を更新");
  });
});

describe("correction page: 法人のグループもまとめられる", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/(dashboard)/admin/owners/correction/page.tsx"),
    "utf8",
  );
  it("統合できる経路は 氏名住所一致・法人番号一致・法人名一致（リンクキー一致は除く）", () => {
    const m = src.match(/const MERGEABLE_MATCHED_BY[^\n]*\n?[^;]*;/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('"name_address"');
    expect(m![0]).toContain('"corporate_number"');
    expect(m![0]).toContain('"corporate_name"');
    expect(m![0]).not.toContain('"external_link_key"');
    expect(src).toMatch(/const\s+supportsMerge\s*=\s*isMergeableMatchedBy\(matchedBy\)/);
  });
  it("サブフィルタに 法人名一致 がある", () => {
    expect(src).toMatch(/corporate_name:\s*"法人名一致"/);
  });
  it("グループに「この1人に全部まとめる」ボタン（master を選んだときだけ）", () => {
    expect(src).toMatch(/supportsMerge\s*&&\s*masterId\s*&&[\s\S]{0,200}<OwnerGroupMergeAllButton/);
  });
  it("「氏名住所一致グループのみ」の古い説明が残っていない", () => {
    expect(src).not.toMatch(/氏名住所一致」?グループ(で)?のみ/);
    expect(src).not.toContain("法人番号 / リンクキー一致グループは候補表示のみ");
  });
  it("孤立タブの削除ボタンは法人名一致の重複にも出さない", () => {
    expect(src).toMatch(/c\.duplicateMatchedBy\s*!==?\s*"corporate_name"/);
  });
});
