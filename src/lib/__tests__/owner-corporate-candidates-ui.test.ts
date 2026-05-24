/**
 * Phase E UI source-assertion テスト。
 *
 * - /admin/owners/correction に「法人番号」タブ + サブフィルタが存在
 * - Owner 詳細リンクが描画される
 * - バルク操作（ボタン）を持たない
 * - fetchCorporateCandidates を呼ぶ
 * - API レスポンスに含まれる法人番号フィールドの参照名が *Masked のみで生 corporateNumber を直接表示していない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("admin/owners/correction page Phase E 法人番号タブ", () => {
  it("filterType に corporate_number が追加されている", () => {
    expect(pageSrc).toMatch(
      /type\s+FilterType\s*=[\s\S]{0,200}"corporate_number"/,
    );
  });

  it("タブ配列に label: 法人番号 が含まれる", () => {
    expect(pageSrc).toMatch(/key:\s*"corporate_number"[\s\S]{0,40}label:\s*"法人番号"/);
  });

  it("CorporateNumberCandidatesPanel をマウントする条件分岐がある", () => {
    expect(pageSrc).toMatch(/filterType\s*===\s*"corporate_number"/);
    expect(pageSrc).toMatch(/<CorporateNumberCandidatesPanel\s*\/>/);
  });

  it("fetchCorporateCandidates を import + 呼び出している", () => {
    expect(pageSrc).toMatch(/fetchCorporateCandidates/);
  });

  it("サブフィルタが 5 種（default / missing / conflict / multi / same）", () => {
    expect(pageSrc).toMatch(/"default"[\s\S]{0,200}"missing"[\s\S]{0,200}"conflict"[\s\S]{0,200}"multi"[\s\S]{0,200}"same"/);
  });

  it("default サブフィルタは API には all として送る（same を除外する仕様）", () => {
    expect(pageSrc).toMatch(
      /subFilter\s*===\s*"default"\s*\?\s*"all"\s*:\s*subFilter/,
    );
  });

  it("Owner 詳細リンクが <Link href={c.detailUrl}> で描画される", () => {
    expect(pageSrc).toMatch(/<Link[\s\S]{0,80}href=\{c\.detailUrl\}/);
    expect(pageSrc).toMatch(/Owner\s+詳細を開く/);
  });

  it("バルク操作の checkbox / 「一括反映」ボタンが無い", () => {
    // CorporateNumberCandidatesPanel 内に bulk 系トークンが存在しないこと
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    expect(panelMatch).not.toBeNull();
    const body = panelMatch?.[0] ?? "";
    expect(body).not.toMatch(/一括反映|bulk[A-Za-z]*Apply|<input[^>]*type="checkbox"/i);
  });

  it("表示に使う列は *Masked フィールドで、生 corporateNumber を直参照しない", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    expect(panelMatch).not.toBeNull();
    const body = panelMatch?.[0] ?? "";
    expect(body).toMatch(/c\.candidateCorporateNumberMasked/);
    expect(body).toMatch(/c\.existingCorporateNumberMasked/);
    // c.corporateNumber や record.corporateNumber を直参照していないこと
    expect(body).not.toMatch(/c\.corporateNumber\b/);
  });

  it("truncated バナーを描画する条件分岐がある", () => {
    expect(pageSrc).toMatch(/data\.truncated/);
    expect(pageSrc).toMatch(/スキャン上限到達/);
  });

  it("cursor pagination の前後ボタンを描画する", () => {
    expect(pageSrc).toMatch(/前へ/);
    expect(pageSrc).toMatch(/次へ/);
    expect(pageSrc).toMatch(/nextCursor/);
  });

  // ---- Codex P2: stale response ガード ----
  it("Codex P2: requestIdRef による stale guard が実装されている", () => {
    // requestId 単調増加で「最新リクエストのみ反映」を保証
    expect(pageSrc).toMatch(/requestIdRef\s*=\s*useRef\(0\)/);
    expect(pageSrc).toMatch(/const\s+myReqId\s*=\s*\+\+requestIdRef\.current/);
    // 各 set* 呼び出し前に「自分が最新リクエスト」を確認するガードがある
    expect(pageSrc).toMatch(
      /myReqId\s*!==\s*requestIdRef\.current[\s\S]{0,80}return/,
    );
  });

  it("Codex P2: mountedRef による unmount ガードがある", () => {
    expect(pageSrc).toMatch(/mountedRef\s*=\s*useRef\(true\)/);
    expect(pageSrc).toMatch(/mountedRef\.current\s*=\s*false/);
    // load 内で mountedRef.current チェックを行う
    expect(pageSrc).toMatch(/!mountedRef\.current\s*\|\|\s*myReqId\s*!==\s*requestIdRef\.current/);
  });

  it("Codex P2: setData/setError/setLoading は最新リクエストにだけ反映する構造", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // setData は条件分岐の後（gate 通過後）にだけ実行される
    expect(body).toMatch(/return;\s*\n\s*setData\(res\)/);
    // setLoading(false) は finally で myReqId === current のときだけ
    expect(body).toMatch(
      /myReqId\s*===\s*requestIdRef\.current\s*\)\s*\{\s*\n?\s*setLoading\(false\)/,
    );
  });

  // ---- Codex P2 追加修正: stale rows 残留防止 ----
  it("Codex P2: load 開始時に setData(null) して古い rows を即座に消す", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // load 開始ブロックで「setLoading(true) → setError(null) → setData(null)」が
    // try ブロックよりも前に出現することを担保する。
    expect(body).toMatch(
      /\+\+requestIdRef\.current;[\s\S]{0,400}setLoading\(true\);[\s\S]{0,400}setError\(null\);[\s\S]{0,400}setData\(null\);[\s\S]{0,200}try\s*\{/,
    );
  });

  it("Codex P2: fetch 失敗時 catch で setData(null) して stale rows を残さない", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // catch 内で setError 後に setData(null) を呼ぶ
    expect(body).toMatch(
      /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}setError\([^)]*\);[\s\S]{0,80}setData\(null\);/,
    );
  });

  it("Codex P2: render 条件に !error を含めて error 時に table を描画しない", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // data && !loading && !error の render 条件がある
    expect(body).toMatch(/data\s*&&\s*!loading\s*&&\s*!error\s*&&/);
  });

  it("Codex P2: catch 内の setData(null) は最新リクエストガードの後に置かれる", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // catch 内で「stale guard return → setError → setData(null)」の順
    expect(body).toMatch(
      /catch\s*\([^)]*\)\s*\{[\s\S]{0,200}myReqId\s*!==\s*requestIdRef\.current[\s\S]{0,40}return;[\s\S]{0,200}setData\(null\)/,
    );
  });

  // ---- Phase F: URL query persistence ----
  it("Phase F: tab/sub/cursor を URL query で保持する（useSearchParams / router.replace）", () => {
    expect(pageSrc).toMatch(/useRouter/);
    expect(pageSrc).toMatch(/useSearchParams/);
    expect(pageSrc).toMatch(/router\.replace\(/);
    // initial state を query から復元
    expect(pageSrc).toMatch(/parseFilterTypeFromQuery/);
    expect(pageSrc).toMatch(/parseCorporateSubFilter/);
    expect(pageSrc).toMatch(/searchParams\?\.get\("cursor"\)/);
  });

  it("Phase F: 候補法人番号や PII を URL に載せていない", () => {
    expect(pageSrc).not.toMatch(/sp\.set\("candidate"/);
    expect(pageSrc).not.toMatch(/sp\.set\("corporateNumber"/);
    expect(pageSrc).not.toMatch(/sp\.set\("name"/);
    expect(pageSrc).not.toMatch(/sp\.set\("address"/);
  });

  // ---- Codex P2 追加: 初回 mount で URL cursor を尊重 ----
  it("Codex P2 追加: 初回マウントでは URL cursor を保持して load を呼ぶ", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // hasInitializedRef による初回判定がある
    expect(body).toMatch(/hasInitializedRef\s*=\s*useRef\(false\)/);
    // 初回: load(apiType, cursor) を呼ぶ（URL cursor をそのまま使う）
    expect(body).toMatch(
      /hasInitializedRef\.current\s*=\s*true;[\s\S]{0,200}load\(apiType,\s*cursor\)/,
    );
    // 2回目以降: setCursor(null) + setCursorStack([]) + load(apiType, null)
    expect(body).toMatch(
      /setCursor\(null\);[\s\S]{0,80}setCursorStack\(\[\]\);[\s\S]{0,80}load\(apiType,\s*null\)/,
    );
  });

  it("Codex P2 追加: 初期 effect で load(apiType, null) に無条件上書きしない（旧バグ防止）", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    const body = panelMatch?.[0] ?? "";
    // useEffect 内に hasInitializedRef のガードがあり、初回は load(apiType, cursor) を呼ぶ
    expect(body).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,500}!hasInitializedRef\.current[\s\S]{0,200}load\(apiType,\s*cursor\)/,
    );
  });
});
