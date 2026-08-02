/**
 * import job 詳細ページの B2（rows サーバーサイドページング配線）ソース表明テスト。
 *
 * 本リポは vitest environment="node"（jsdom / RTL なし）のため、ページの hooks を
 * 実行できない。既存方針（import-rollback-page-phase2-ui.test.ts 等）に倣い、page.tsx
 * のソースを読み配線を表明する。
 *
 * 検証:
 *  - fetchImportJobDetail(jobId, {page, limit, status}) で取得（status="all" は送らない）
 *  - page / status を URL query と同期（useSearchParams / router.replace）
 *  - status 変更で page=1 に戻す（changeFilter）
 *  - job.pagination で前へ/次へ UI
 *  - 全体判定は server 値（job.isReceptionOwnerJob / job.duplicateCount）を使い、
 *    job.rows.some() / job.rows.filter() を全体判定に使い続けない
 *  - mutation 後 refetch が page/limit/status を維持（fetchJob deps）＋ page>totalPages クランプ
 *  - batch resolve は B2 では無効化（ページング表示中）＋ B3 注記
 *  - 候補5: limit 切替（50/100・page=1 リセット・URL 同期）とページジャンプ（totalPages 範囲内）
 *  - Phase 2: 理由別 filter（reason state/URL 同期/page=1/一括ボタン非表示 gating・PII なし token）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/jobs/[jobId]/page.tsx",
  ),
  "utf8",
);

describe("import job detail page — B2 pagination 配線 (source-assertion)", () => {
  it("fetchImportJobDetail を page/limit/status 付きで呼ぶ（status=all は送らない）", () => {
    expect(pageSrc).toMatch(/fetchImportJobDetail\(jobId,\s*\{/);
    expect(pageSrc).toMatch(/page,/);
    // 候補5: limit は state（shorthand）で渡る（固定 ROW_LIMIT 直渡しではない）。
    expect(pageSrc).toMatch(/fetchImportJobDetail\(jobId,\s*\{\s*page,\s*limit,/);
    expect(pageSrc).not.toMatch(/limit:\s*ROW_LIMIT/);
    expect(pageSrc).toMatch(
      /status:\s*filter === "all" \? undefined : filter/,
    );
  });

  it("ROW_LIMIT の既定は 50・切替候補は 50/100（server MAX_ROW_LIMIT=100 以内）", () => {
    expect(pageSrc).toMatch(/const ROW_LIMIT = 50;/);
    expect(pageSrc).toMatch(/const ROW_LIMIT_OPTIONS = \[50, 100\] as const;/);
  });

  it("page / status を URL query と同期する（useSearchParams + router.replace）", () => {
    expect(pageSrc).toMatch(/useSearchParams/);
    expect(pageSrc).toMatch(/router\.replace\(/);
    expect(pageSrc).toMatch(/sp\.set\("status",\s*filter\)/);
    expect(pageSrc).toMatch(/sp\.set\("page",\s*String\(page\)\)/);
    // 候補5: limit も URL query と同期（既定 ROW_LIMIT 以外のときのみ載せる）
    expect(pageSrc).toMatch(/sp\.set\("limit",\s*String\(limit\)\)/);
    expect(pageSrc).toMatch(/limit !== ROW_LIMIT/);
    // 初期値を URL から復元
    expect(pageSrc).toMatch(/searchParams\.get\("status"\)/);
    expect(pageSrc).toMatch(/searchParams\.get\("page"\)/);
    expect(pageSrc).toMatch(/searchParams\.get\("limit"\)/);
  });

  it("status タブ変更で page=1 に戻す（changeFilter）", () => {
    expect(pageSrc).toMatch(
      /const changeFilter = \(next: FilterStatus\) => \{[\s\S]*?setFilter\(next\);[\s\S]*?setPage\(1\);/,
    );
    // タブは changeFilter を使う（setFilter 直叩きではない）
    expect(pageSrc).toMatch(/onClick=\{\(\) => changeFilter\(tab\.key\)\}/);
    expect(pageSrc).not.toMatch(/onClick=\{\(\) => setFilter\(tab\.key\)\}/);
  });

  it("job.pagination を使った前へ/次へ UI", () => {
    expect(pageSrc).toMatch(/job\.pagination\.hasPrevPage/);
    expect(pageSrc).toMatch(/job\.pagination\.hasNextPage/);
    expect(pageSrc).toMatch(/job\.pagination\.totalPages/);
    expect(pageSrc).toMatch(/前へ/);
    expect(pageSrc).toMatch(/次へ/);
  });

  it("全体判定は server 値を使う（isReceptionOwnerJob / duplicateCount）", () => {
    expect(pageSrc).toMatch(
      /const isReceptionOwnerJob = job\?\.isReceptionOwnerJob \?\? false;/,
    );
    expect(pageSrc).toMatch(/duplicate:\s*job\?\.duplicateCount \?\? 0/);
  });

  it("job.rows.some() / job.rows.filter() を全体判定に使い続けない", () => {
    expect(pageSrc).not.toMatch(/job\?\.rows\.some\(/);
    expect(pageSrc).not.toMatch(/job\?\.rows\.filter\(/);
    // filteredRows は server で絞られた現在ページ rows をそのまま使う
    expect(pageSrc).toMatch(/const filteredRows = job\?\.rows \?\? \[\];/);
  });

  it("mutation 後 refetch が page/limit/status/reason を維持（fetchJob deps）", () => {
    expect(pageSrc).toMatch(/\}, \[jobId, page, filter, limit, reason\]\);/);
    expect(pageSrc).not.toMatch(/\}, \[jobId, page, filter, limit\]\);/);
    expect(pageSrc).not.toMatch(/\}, \[jobId, page, filter\]\);/);
  });

  it("再取得後 page > totalPages を安全にクランプ", () => {
    expect(pageSrc).toMatch(/if \(page > totalPages\) setPage\(totalPages\);/);
  });

  it("batch resolve は B3 で bulk endpoint を呼び pagination 非依存で全件処理する", () => {
    // server-side bulk endpoint を呼ぶ（client は ID を持たない）
    expect(pageSrc).toMatch(
      /bulkResolveImportRows\(jobId,\s*\{\s*action,\s*scope\s*\}\)/,
    );
    // scope は現在の filter（needs_review / error）
    expect(pageSrc).toMatch(/const scope = filter;/);
    // 件数は server summary 由来（現ページ件数ではない）
    expect(pageSrc).toMatch(/summary\.needsReviewCount/);
    expect(pageSrc).toMatch(/summary\.errorCount/);
    // 確認文言は「全 N 件」
    expect(pageSrc).toMatch(/全 \$\{total\} 件を/);
    // 実行後に affectedCount を表示
    expect(pageSrc).toMatch(/res\.affectedCount/);
  });

  it("B2 の batch 無効化（isPaginated / B3 対応予定）は撤去されている", () => {
    expect(pageSrc).not.toMatch(/isPaginated/);
    expect(pageSrc).not.toMatch(/B3 対応予定/);
    // ボタンは pagination 非依存（actionLoading のみで無効化）
    expect(pageSrc).toMatch(/disabled=\{actionLoading === "batch"\}/);
    expect(pageSrc).not.toMatch(
      /disabled=\{actionLoading === "batch" \|\| isPaginated\}/,
    );
  });
});

describe("import job detail page — B4 重複候補のみスキップ (source-assertion)", () => {
  it("専用ハンドラが scope:'duplicate' で bulk endpoint を呼ぶ", () => {
    expect(pageSrc).toMatch(/const handleBulkResolveDuplicates = async \(\)/);
    expect(pageSrc).toMatch(
      /bulkResolveImportRows\(jobId,\s*\{[\s\S]*?action:\s*"skip",[\s\S]*?scope:\s*"duplicate"[\s\S]*?\}\)/,
    );
  });

  it("件数 N は job.duplicateActionableCount（counts.duplicateActionable）由来・現ページ件数ではない", () => {
    // Codex P2: actionable 件数を使う（skipped 重複を含む duplicateCount ではない）。
    expect(pageSrc).toMatch(/const total = counts\.duplicateActionable;/);
    expect(pageSrc).not.toMatch(/const total = counts\.duplicate;/);
    // counts.duplicateActionable は job.duplicateActionableCount 由来（安全側 ?? 0）。
    expect(pageSrc).toMatch(
      /duplicateActionable:\s*job\?\.duplicateActionableCount \?\? 0/,
    );
    // 確認文言は「重複候補 全 N 件」
    expect(pageSrc).toMatch(/重複候補 全 \$\{total\} 件を/);
    // 実行後に affectedCount を表示（既存方針を維持）
    expect(pageSrc).toMatch(/res\.affectedCount/);
  });

  it("ボタンは needs_review かつ counts.duplicateActionable>0 のときのみ表示（skipped済み重複だけなら出さない）", () => {
    expect(pageSrc).toMatch(
      /filter === "needs_review" &&\s*counts\.duplicateActionable > 0/,
    );
    expect(pageSrc).toMatch(
      /重複候補のみスキップ（\{counts\.duplicateActionable\}件）/,
    );
    // ハンドラ側も needs_review ガード
    expect(pageSrc).toMatch(
      /handleBulkResolveDuplicates = async \(\) => \{\s*if \(filter !== "needs_review"\) return;/,
    );
  });

  it("確認件数は duplicateCount（needs_review+skipped）を使わない＝過大表示にならない（Codex P2）", () => {
    // B4 の確認/ボタンは duplicateActionable のみを参照する。
    expect(pageSrc).toMatch(/counts\.duplicateActionable/);
    // 表示ヒント（内数）は従来どおり duplicateCount を残す（互換）。
    expect(pageSrc).toMatch(/\{counts\.duplicate\} 件/);
  });

  it("「全件スキップ」と「重複候補のみスキップ」を取り違えない（別操作・別 scope）", () => {
    // 全件スキップは従来どおり handleBatchResolve("skip")（= filter 全件）
    expect(pageSrc).toMatch(/handleBatchResolve\("skip"\)/);
    expect(pageSrc).toMatch(/全件スキップ/);
    // 重複候補のみスキップは専用ハンドラ（scope 固定 "duplicate"）で filter を scope に流用しない
    expect(pageSrc).toMatch(/onClick=\{handleBulkResolveDuplicates\}/);
    // 重複ハンドラ内で `const scope = filter` を使っていない（B3 全件用とは別系統）
    expect(pageSrc).not.toMatch(
      /handleBulkResolveDuplicates[\s\S]*?const scope = filter;/,
    );
  });
});

describe("import job detail page — 候補5 ページング UX (source-assertion)", () => {
  it("limit state を持ち URL から復元する（許可値 50/100 以外は既定 ROW_LIMIT に正規化）", () => {
    expect(pageSrc).toMatch(
      /const \[limit, setLimit\] = useState<number>\(initialLimit\);/,
    );
    expect(pageSrc).toMatch(/const initialLimit: number = /);
    expect(pageSrc).toMatch(
      /\(ROW_LIMIT_OPTIONS as readonly number\[\]\)\.includes\(n\) \? n : ROW_LIMIT/,
    );
  });

  it("limit 変更で page=1 に戻す（changeLimit・セレクトは changeLimit 経由）", () => {
    expect(pageSrc).toMatch(
      /const changeLimit = \(next: number\) => \{[\s\S]*?setLimit\(next\);[\s\S]*?setPage\(1\);/,
    );
    expect(pageSrc).toMatch(
      /onChange=\{\(e\) => changeLimit\(Number\(e\.target\.value\)\)\}/,
    );
    expect(pageSrc).toMatch(/ROW_LIMIT_OPTIONS\.map/);
  });

  it("ページジャンプは pagination metadata（totalPages）の範囲内に制御する", () => {
    // 複数ページのときのみ表示（1ページでも表示崩れしない）
    expect(pageSrc).toMatch(/job\.pagination\.totalPages > 1 && \(/);
    // 入力値は 1〜totalPages に正規化（NaN・<1 は無視、超過は clamp）
    expect(pageSrc).toMatch(
      /const handleGoto = \(e: FormEvent<HTMLFormElement>\) => \{/,
    );
    expect(pageSrc).toMatch(/if \(!Number\.isFinite\(n\) \|\| n < 1\) return;/);
    expect(pageSrc).toMatch(/setPage\(Math\.min\(n, totalPages\)\);/);
    // input の min/max も metadata を使う
    expect(pageSrc).toMatch(/max=\{job\.pagination\.totalPages\}/);
  });

  it("status タブ変更は page=1（既存）・changeFilter は limit を触らない", () => {
    // changeFilter の body は setFilter + setPage(1) のみ（setLimit を含まない）
    expect(pageSrc).toMatch(
      /const changeFilter = \(next: FilterStatus\) => \{\s*setFilter\(next\);\s*setPage\(1\);\s*\};/,
    );
  });

  it("既存の前へ/次へ・bulk UI を壊さない", () => {
    expect(pageSrc).toMatch(/前へ/);
    expect(pageSrc).toMatch(/次へ/);
    expect(pageSrc).toMatch(/job\.pagination\.hasPrevPage/);
    expect(pageSrc).toMatch(/job\.pagination\.hasNextPage/);
    expect(pageSrc).toMatch(/全件スキップ/);
    expect(pageSrc).toMatch(/重複候補のみスキップ/);
  });
});

describe("import job detail page — 理由別 filter Phase 2 (source-assertion)", () => {
  it("reason state を持ち URL から復元する（allowlist 外は all に正規化）", () => {
    expect(pageSrc).toMatch(
      /const \[reason, setReason\] = useState<ReasonFilter>\(initialReason\);/,
    );
    expect(pageSrc).toMatch(/searchParams\.get\("reason"\)/);
    expect(pageSrc).toMatch(/ROW_REASON_OPTIONS\.some\(\(o\) => o\.key === r\)/);
  });

  it("token は server VALID_ROW_REASONS と一致し B4 の 'duplicate' を使わない", () => {
    for (const token of [
      "dup_candidate",
      "address_dup",
      "no_address",
      "owner_unmatched",
      "no_key",
      "building_unresolved",
    ]) {
      expect(pageSrc).toContain(`key: "${token}"`);
    }
    // bulk-resolve scope と衝突する token 名は使わない（B4.1/B4 と概念分離）。
    expect(pageSrc).not.toMatch(/key: "duplicate"/);
  });

  it("reason 変更で page=1 に戻す（セレクトは changeReason 経由）", () => {
    expect(pageSrc).toMatch(
      /const changeReason = \(next: ReasonFilter\) => \{[\s\S]*?setReason\(next\);[\s\S]*?setPage\(1\);/,
    );
    expect(pageSrc).toMatch(
      /onChange=\{\(e\) => changeReason\(e\.target\.value as ReasonFilter\)\}/,
    );
  });

  it("URL 同期: 未指定（all）は載せず、fetch にも all を送らない", () => {
    expect(pageSrc).toMatch(
      /if \(reason !== "all"\) sp\.set\("reason", reason\);/,
    );
    expect(pageSrc).toMatch(
      /reason:\s*reason === "all" \? undefined : reason,/,
    );
  });

  it("reason 適用中は bulk ボタンを非表示にしヒントを出す（誤操作防止）", () => {
    // 一括操作ブロックは reason === "all" のときだけ描画する。
    // ⚠2026-08-02 監査で先頭に canMutate 条件が付いた（他人の取込を閲覧のみで
    // 開いているときは一括操作を出さない）ので、reason 以降の並びを見る。
    expect(pageSrc).toMatch(
      /\{canMutate &&\s*reason === "all" &&\s*\(filter === "needs_review" \|\| filter === "error"\) &&\s*counts\[filter\] > 0 &&/,
    );
    // 適用中は非表示の理由をヒントで明示する。
    expect(pageSrc).toMatch(/理由フィルタ解除後に一括操作できます/);
    expect(pageSrc).toMatch(
      /\{reason !== "all" &&\s*\(filter === "needs_review" \|\| filter === "error"\) &&\s*counts\[filter\] > 0 &&/,
    );
  });

  it("既存 pagination/limit/jump/B3/B4 UI を壊さない（ドロップダウン併設）", () => {
    expect(pageSrc).toMatch(/const changeLimit = \(next: number\)/);
    expect(pageSrc).toMatch(/const handleGoto = /);
    expect(pageSrc).toMatch(/全件スキップ/);
    expect(pageSrc).toMatch(/重複候補のみスキップ/);
    expect(pageSrc).toMatch(/すべての理由/);
    expect(pageSrc).toMatch(/ROW_REASON_OPTIONS\.map/);
  });
});
