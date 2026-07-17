# 内蔵謄本 所在検索 段階① 実装計画（無料・候補一覧まで）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `searchByLocation` を実サイトの実フロー（不動産請求遷移 → 所在/種別/都道府県/地番入力 → 地番検索ダイアログ → 非同期ロード待ち → 候補地番抽出）に作り直し、`RegistryCandidate[]` を返す。課金しない（確定を押さず `#cbnDlgBtnCancel` で閉じる）。検索失敗の診断ログを追加。

**Architecture:** DOM 操作は `src/lib/registry-fetch/auto-fetch.ts` の adapter（`createPlaywrightRegistryPage`）に閉じ込める既存構造を踏襲。候補抽出は self-contained な純関数を `$$eval` に渡す。TDD は既存 `playwright-adapter.test.ts` の fake page 注入方式（selector/state/呼び出し順アサート）で行う。

**Tech Stack:** TypeScript, Playwright（adapter 経由・テストは fake 注入で実ブラウザ非使用）, Vitest（env=node, `renderToStaticMarkup`）。

## Global Constraints

- secret/PII（loginId/password/所在/地番/謄本内容/URL）を **ログ・監査 detail・エラー応答に出さない**。失敗ログは `summarizeRegistryLoginError` と同方針で除去。
- 課金しない: 段階①は `#cbnDlgBtnOk`（確定）・`#myPageSeikyu`（請求）を押さない。ダイアログは `#cbnDlgBtnCancel` で閉じる。
- 実 Playwright / 実サイトに依存するテストを書かない（fake page 注入のみ）。
- 全ゲート: `npx tsc --noEmit`=0 / `npx vitest run`（フル）緑 / `npx eslint <変更ファイル>`=0 / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 成功。
- worktree: `property-management-worktrees/registry-location-fetch`（branch `feat/registry-location-fetch`・origin/main `46ddf79` 分岐）。既に `npm ci`+`prisma generate` 済み想定（未なら実施）。
- 確定セレクタ（2026-07-17 probe）:
  - 不動産請求リンク `a[href*="menuClick('FUDOSAN')"]`
  - 請求方法=所在 `#fuSeikyuMethodSHOZAI` / 種別 土地 `#fuShozaiTypeTOCHI`・建物 `#fuShozaiTypeTATEMONO`
  - 都道府県 `#fuTodofukenShozai`（select・option 表示ラベル）/ 直接入力 `#fuShozaiChokusetuNyuryoku`（checkbox）
  - 所在 `#fuChibanKuiki` / 地番 `#fuChibanKaoku`
  - 地番一覧ボタン `#fuChibanKaokuIchiran` / ダイアログ地番種別 `#cbnDlgChibanType0` / 範囲 `#cbnDlgSearchChibanStart` / ダイアログ検索 `#cbnDlgChibanSearch`
  - 結果テーブル `#cbnDlgChibanCheckTbl`（非同期。行 = `input[type=checkbox]#cbnDlgChibanChk_{N}` ＋ `td#cbnDlgChibanDt_{N}` に地番テキスト）/ 取消 `#cbnDlgBtnCancel`

---

### Task 1: ダイアログ用セレクタ定数を追加

**Files:**
- Modify: `src/lib/registry-fetch/auto-fetch.ts`（`REGISTRY_SELECTORS` オブジェクト）
- Test: `src/lib/registry-fetch/__tests__/playwright-adapter.test.ts`

**Interfaces:**
- Produces: `REGISTRY_SELECTORS` に `fudosanRequestLink`, `dialogChibanTypeNumeric`, `dialogChibanRangeStart`, `dialogSearch`, `dialogResultTable`, `dialogResultCheckbox`, `dialogCancel` を追加（値は Global Constraints のセレクタ）。既存 `searchMethodLocationRadio`/`locationTypeLandRadio`/`locationTypeBuildingRadio`/`locationPrefectureSelect`/`locationDirectInputCheck`/`locationSearchAddress`/`locationSearchLotBuilding` は再利用。

- [ ] **Step 1: セレクタ定数を追加**

`REGISTRY_SELECTORS`（`src/lib/registry-fetch/auto-fetch.ts`）に追記:

```ts
  // 所在検索フロー(2026-07-17 本番probe確定)。
  fudosanRequestLink: "a[href*=\"menuClick('FUDOSAN')\"]", // [確定] 不動産請求リンク
  dialogChibanKaokuListButton: "#fuChibanKaokuIchiran", // [確定] 地番・家屋番号一覧(ダイアログを開く)
  dialogChibanTypeNumeric: "#cbnDlgChibanType0", // [確定] 地番種別=数字/ハイフンのみ
  dialogChibanRangeStart: "#cbnDlgSearchChibanStart", // [確定] 地番範囲(開始)
  dialogSearch: "#cbnDlgChibanSearch", // [確定] ダイアログ内検索(非同期)
  dialogResultTable: "#cbnDlgChibanCheckTbl", // [確定] 候補テーブル(非同期ロード)
  dialogResultCheckbox: "#cbnDlgChibanCheckTbl input[type=checkbox]", // [確定] 候補行チェックボックス
  dialogCancel: "#cbnDlgBtnCancel", // [確定] ダイアログ取消(課金しない閉じ方)
```

- [ ] **Step 2: 定数の存在を固定するテストを書く**

`playwright-adapter.test.ts` に追加（`REGISTRY_SELECTORS` は非 export のため、後続 Task で `searchByLocation` 経由の呼び出しアサートで間接検証する。ここでは値ロック不要 = このステップはスキップし、Task 3 のフローテストで担保する）。

> 注: `REGISTRY_SELECTORS` は module-private。個別 export はしない（既存方針）。セレクタの使用は Task 3 のフロー順アサートで固定する。よって Task 1 はコミットのみ。

- [ ] **Step 3: tsc で型を確認**

Run: `npx tsc --noEmit`
Expected: エラー 0（未使用定数は object リテラルなので tsc は許容）。

- [ ] **Step 4: コミット**

```bash
git add src/lib/registry-fetch/auto-fetch.ts
git commit -m "feat(registry-fetch): 所在検索ダイアログのセレクタ定数を追加"
```

---

### Task 2: 候補行抽出の純関数 `extractChibanCandidateRows`

**Files:**
- Modify: `src/lib/registry-fetch/auto-fetch.ts`（既存 `extractLocationCandidateRows` の隣に新規追加。既存関数は Task 3 で不使用化＝残すが searchByLocation からの参照を外す）
- Test: `src/lib/registry-fetch/__tests__/playwright-adapter.test.ts`

**Interfaces:**
- Produces: `export function extractChibanCandidateRows(els: Element[]): Array<{ candidateRef: string; lotNumber: string | null }>`。`$$eval("#cbnDlgChibanCheckTbl tr", extractChibanCandidateRows)` に渡す。self-contained（モジュールスコープ非参照・serializable）。各 tr から checkbox の id（例 `cbnDlgChibanChk_1`）を `candidateRef`、地番セル（`td[id^="cbnDlgChibanDt_"]` の textContent、例「１－１」）を `lotNumber`。checkbox 無し行（ヘッダ等）は除外。

- [ ] **Step 1: 失敗テストを書く**

`playwright-adapter.test.ts` に追加:

```ts
import { extractChibanCandidateRows } from "../auto-fetch";

describe("extractChibanCandidateRows（地番検索ダイアログ候補行）", () => {
  function trWith(chkId: string | null, lotId: string, lot: string) {
    const tr = { querySelector: (sel: string) => {
      if (sel.includes("checkbox")) return chkId ? { getAttribute: (a: string) => (a === "id" ? chkId : null) } : null;
      if (sel.includes("cbnDlgChibanDt")) return { textContent: lot, id: lotId };
      return null;
    } } as unknown as Element;
    return tr;
  }

  it("checkbox 行を candidateRef+lotNumber に変換し、非候補行(checkbox無)は除外", () => {
    const rows = [
      trWith("cbnDlgChibanChk_1", "cbnDlgChibanDt_1", "１－１"),
      trWith("cbnDlgChibanChk_2", "cbnDlgChibanDt_2", "１－２"),
      trWith(null, "x", "ヘッダ"),
    ];
    const out = extractChibanCandidateRows(rows);
    expect(out).toEqual([
      { candidateRef: "cbnDlgChibanChk_1", lotNumber: "１－１" },
      { candidateRef: "cbnDlgChibanChk_2", lotNumber: "１－２" },
    ]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "extractChibanCandidateRows"`
Expected: FAIL（`extractChibanCandidateRows is not a function`）。

- [ ] **Step 3: 純関数を実装**

`src/lib/registry-fetch/auto-fetch.ts` に追加（`extractLocationCandidateRows` の下）:

```ts
/**
 * 地番検索ダイアログ(#cbnDlgChibanCheckTbl)の各行(tr)を候補へ変換する。$$eval に渡すため
 * self-contained/serializable(モジュールスコープ非参照)。checkbox を持つ行のみ候補とし、
 * candidateRef=checkbox の id(例 cbnDlgChibanChk_1)、lotNumber=地番セル(#cbnDlgChibanDt_*)の
 * textContent(例「１－１」)。checkbox 無し行(ヘッダ等)は除外する。地番/所在は秘匿情報。
 */
export function extractChibanCandidateRows(
  els: Element[],
): Array<{ candidateRef: string; lotNumber: string | null }> {
  const out: Array<{ candidateRef: string; lotNumber: string | null }> = [];
  for (const tr of els) {
    const chk = tr.querySelector('input[type="checkbox"]');
    if (!chk) continue;
    const ref = (chk.getAttribute("id") ?? "").trim();
    if (!ref) continue;
    const lotCell = tr.querySelector('td[id^="cbnDlgChibanDt_"]');
    const lotNumber = (lotCell?.textContent ?? "").trim() || null;
    out.push({ candidateRef: ref, lotNumber });
  }
  return out;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "extractChibanCandidateRows"`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-fetch/auto-fetch.ts src/lib/registry-fetch/__tests__/playwright-adapter.test.ts
git commit -m "feat(registry-fetch): 地番検索ダイアログの候補行抽出 純関数を追加"
```

---

### Task 3: `searchByLocation` を実フローへ作り直し

**Files:**
- Modify: `src/lib/registry-fetch/auto-fetch.ts`（`createPlaywrightRegistryPage` の `searchByLocation`）
- Test: `src/lib/registry-fetch/__tests__/playwright-adapter.test.ts`（既存 C9 系 searchByLocation テストを新フローへ差し替え）

**Interfaces:**
- Consumes: Task 1 のセレクタ、Task 2 の `extractChibanCandidateRows`、既存 `splitAddressForLocationSearch`、`RegistryPageLike`（`click`/`fill`/`selectOption`/`check`/`evaluate`/`waitForSelector`/`$$eval`）。
- Produces: `searchByLocation(input: { address; lotNumber?; buildingNumber? }): Promise<RegistryCandidate[]>`。フロー: 不動産請求リンク DOM click → 所在ラジオ → 種別(家屋番号有=建物/無=土地) → 都道府県 select（`splitAddressForLocationSearch` の prefecture）→ 直接入力 check → 所在 fill（rest）→ 地番 fill（lotNumber）→ 地番一覧ボタン click → ダイアログ地番種別 click → 範囲 start fill（lotNumber）→ ダイアログ検索 click → `waitForSelector(dialogResultCheckbox, {state:"attached"})`（非同期ロード待ち）→ `$$eval(dialogResultTable+" tr", extractChibanCandidateRows)` → `#cbnDlgBtnCancel` を evaluate DOM click（課金しない）→ `RegistryCandidate[]` に整形（candidateRef, address=input.address, lotNumber=行の地番, buildingNumber=input.buildingNumber ?? null, realEstateNumber=null）。セットアップ(click/fill/select/check)失敗は provider_error、結果待ちの TimeoutError は timeout に分類し、いずれも `console.warn("[registry-search] ...", summarize...)` 診断ログ（secret/PII 除去）。

- [ ] **Step 1: 失敗テストを書く（新フロー順＋候補整形）**

`playwright-adapter.test.ts` の既存 C9（searchByLocation）テストを置き換え/追加。fake page は selector を記録し、`$$eval` は固定候補を返す:

```ts
it("C9: searchByLocation は 不動産請求遷移→所在/種別/都道府県/直接入力/地番→地番ダイアログ検索→候補抽出→キャンセル", async () => {
  const f = makeFakeChromium();
  const calls: string[] = [];
  f.page.click = vi.fn(async (s: string) => { calls.push("click:" + s); });
  f.page.fill = vi.fn(async (s: string) => { calls.push("fill:" + s); });
  f.page.selectOption = vi.fn(async (s: string) => { calls.push("select:" + s); return []; });
  f.page.check = vi.fn(async (s: string) => { calls.push("check:" + s); });
  f.page.waitForSelector = vi.fn(async (s: string) => { calls.push("wait:" + s); return {}; });
  f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) => { calls.push("eval:" + arg); return undefined; });
  f.page.$$eval = vi.fn(async () => [
    { candidateRef: "cbnDlgChibanChk_1", lotNumber: "１－１" },
    { candidateRef: "cbnDlgChibanChk_2", lotNumber: "１－２" },
  ]);
  const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
  const page = await factory!();
  const candidates = await page.searchByLocation!({ address: "東京都千代田区丸の内一丁目", lotNumber: "1", buildingNumber: null });

  // 不動産請求への遷移(DOM click)が最初に走る。
  expect(calls).toContain("eval:a[href*=\"menuClick('FUDOSAN')\"]");
  // 所在ラジオ・都道府県 select・直接入力 check・地番一覧ボタン・ダイアログ検索を経由。
  expect(calls).toContain("click:#fuSeikyuMethodSHOZAI");
  expect(calls).toContain("select:#fuTodofukenShozai");
  expect(calls).toContain("check:#fuShozaiChokusetuNyuryoku");
  expect(calls).toContain("click:#fuChibanKaokuIchiran");
  expect(calls).toContain("click:#cbnDlgChibanSearch");
  // 非同期候補ロードを待つ。
  expect(calls).toContain("wait:#cbnDlgChibanCheckTbl input[type=checkbox]");
  // 課金しない: 確定は押さずキャンセルで閉じる。
  expect(calls).toContain("eval:#cbnDlgBtnCancel");
  expect(calls).not.toContain("click:#cbnDlgBtnOk");
  expect(calls).not.toContain("click:#myPageSeikyu");
  // 候補整形。
  expect(candidates).toEqual([
    { candidateRef: "cbnDlgChibanChk_1", address: "東京都千代田区丸の内一丁目", lotNumber: "１－１", buildingNumber: null, realEstateNumber: null },
    { candidateRef: "cbnDlgChibanChk_2", address: "東京都千代田区丸の内一丁目", lotNumber: "１－２", buildingNumber: null, realEstateNumber: null },
  ]);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "C9"`
Expected: FAIL（旧フローのため calls/candidates 不一致）。

- [ ] **Step 3: `searchByLocation` を実装**

`createPlaywrightRegistryPage` の `searchByLocation` を差し替え（DOM click ヘルパは login と同じ evaluate パターンを使う）:

```ts
    async searchByLocation(input) {
      // ① 不動産請求画面へ遷移 → ② 所在検索フォーム入力 → ③ 地番検索ダイアログ。
      // 課金しない: 確定(#cbnDlgBtnOk)/請求(#myPageSeikyu)は押さず、キャンセルで閉じる。
      const domClick = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el && typeof (el as { click?: unknown }).click === "function") {
            (el as unknown as { click: () => void }).click();
          }
        }, sel);
      try {
        await page.waitForSelector(REGISTRY_SELECTORS.fudosanRequestLink, { state: "attached" });
        await domClick(REGISTRY_SELECTORS.fudosanRequestLink);
        await page.waitForSelector(REGISTRY_SELECTORS.searchMethodLocationRadio);
        await page.click(REGISTRY_SELECTORS.searchMethodLocationRadio);
        await page.click(
          input.buildingNumber && input.buildingNumber.length > 0
            ? REGISTRY_SELECTORS.locationTypeBuildingRadio
            : REGISTRY_SELECTORS.locationTypeLandRadio,
        );
        const { prefecture, rest } = splitAddressForLocationSearch(input.address);
        if (prefecture) {
          await page.selectOption(REGISTRY_SELECTORS.locationPrefectureSelect, prefecture);
        }
        await page.check(REGISTRY_SELECTORS.locationDirectInputCheck);
        await page.fill(REGISTRY_SELECTORS.locationSearchAddress, rest.length > 0 ? rest : input.address);
        const lot = (input.lotNumber ?? "").trim();
        if (lot.length > 0) {
          await page.fill(REGISTRY_SELECTORS.locationSearchLotBuilding, lot);
        }
        await page.click(REGISTRY_SELECTORS.dialogChibanKaokuListButton);
        await page.click(REGISTRY_SELECTORS.dialogChibanTypeNumeric);
        if (lot.length > 0) {
          await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, lot);
        }
        await page.click(REGISTRY_SELECTORS.dialogSearch);
      } catch (err) {
        console.warn("[registry-search] location search setup failed:", summarizeRegistryLoginError(err));
        throw new RegistryFetchError("provider_error");
      }
      try {
        // 非同期ロード完了を待つ(「データ取得中」→ checkbox 行が現れる)。
        await page.waitForSelector(REGISTRY_SELECTORS.dialogResultCheckbox, { state: "attached" });
        const rows = (await page.$$eval(
          `${REGISTRY_SELECTORS.dialogResultTable} tr`,
          extractChibanCandidateRows,
        )) as Array<{ candidateRef: string; lotNumber: string | null }>;
        // 課金しない: ダイアログはキャンセルで閉じる。
        await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
        return rows.map((r) => ({
          candidateRef: r.candidateRef,
          address: input.address,
          lotNumber: r.lotNumber,
          buildingNumber: input.buildingNumber ?? null,
          realEstateNumber: null,
        }));
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        console.warn("[registry-search] location result read failed:", summarizeRegistryLoginError(err));
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        throw new RegistryFetchError("provider_error");
      }
    },
```

（`dialogChibanKaokuListButton` は Task 1 で追加済み。）

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "C9"`
Expected: PASS。

- [ ] **Step 5: 旧 `extractLocationCandidateRows` 参照除去の確認**

Run: `grep -n "extractLocationCandidateRows" src/lib/registry-fetch/auto-fetch.ts`
Expected: 定義は残るが `searchByLocation` からの参照が消えていること（旧関数は別 export なので削除しない＝他参照が無ければ判断）。

- [ ] **Step 6: コミット**

```bash
git add src/lib/registry-fetch/auto-fetch.ts src/lib/registry-fetch/__tests__/playwright-adapter.test.ts
git commit -m "feat(registry-fetch): searchByLocation を実サイトの地番検索ダイアログ方式へ作り直し"
```

---

### Task 4: 失敗診断ログの網羅（`[registry-search]`）と 0件時の扱い

**Files:**
- Modify: `src/lib/registry-fetch/auto-fetch.ts`
- Test: `src/lib/registry-fetch/__tests__/playwright-adapter.test.ts`

**Interfaces:**
- Consumes: Task 3 の `searchByLocation`。
- Produces: 挙動不変（Task 3 で診断ログは実装済み）。本 Task は「候補0件（checkbox 待ちが timeout）」で **provider_error でなく timeout に分類**し、診断ログが secret/PII を出さないことをテストで固定する。

- [ ] **Step 1: 失敗テストを書く（結果待ち timeout → timeout 分類・secret 非露出）**

```ts
it("C9b: 候補ロード待ちが timeout したら timeout に分類し、診断ログに secret/PII を出さない", async () => {
  const f = makeFakeChromium();
  f.page.waitForSelector = vi.fn(async (s: string) => {
    if (s.includes("input[type=checkbox]")) { const e = new Error("Timeout 30000ms exceeded for 東京都千代田区"); (e as { name?: string }).name = "TimeoutError"; throw e; }
    return {};
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await expect(page.searchByLocation!({ address: "東京都千代田区丸の内一丁目", lotNumber: "1", buildingNumber: null }))
      .rejects.toMatchObject({ code: "timeout" });
    const logged = warn.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).toContain("[registry-search]");
    expect(logged).not.toContain("丸の内"); // PII(所在)を出さない
  } finally { warn.mockRestore(); }
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "C9b"`
Expected: FAIL または PASS。FAIL なら `summarizeRegistryLoginError(err)` に生 message（所在）が載っている → summarize は message 先頭行を出すため所在が混入し得る。**対策**: 検索の診断ログは `summarizeRegistryLoginError(err, [input.address, input.lotNumber ?? ""])` と **secrets に所在/地番を渡して除去**する。

- [ ] **Step 3: 診断ログに所在/地番を secrets として渡す**

Task 3 の2箇所の `console.warn("[registry-search] ...", summarizeRegistryLoginError(err))` を、除去対象付きに変更:

```ts
          summarizeRegistryLoginError(err, [input.address, input.lotNumber ?? ""]),
```

（`summarizeRegistryLoginError(err, secrets)` は既存。secrets の各文字列を message から `***` へ置換する。）

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/lib/registry-fetch/__tests__/playwright-adapter.test.ts -t "C9b"`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-fetch/auto-fetch.ts src/lib/registry-fetch/__tests__/playwright-adapter.test.ts
git commit -m "fix(registry-fetch): 所在検索の失敗ログから所在/地番(PII)を除去し timeout を正分類"
```

---

### Task 5: 全ゲート（緑の確証）

**Files:** なし（検証のみ）

- [ ] **Step 1: tsc**

Run: `npx tsc --noEmit`
Expected: エラー 0。

- [ ] **Step 2: フル vitest**

Run: `npx vitest run`
Expected: 全 pass（既存 + 新規 C9/C9b/extract）。

- [ ] **Step 3: eslint**

Run: `npx eslint src/lib/registry-fetch/auto-fetch.ts src/lib/registry-fetch/__tests__/playwright-adapter.test.ts`
Expected: エラー 0。疑わしければ `git stash`→同コマンド→`git stash pop` でベースライン比較。

- [ ] **Step 4: build**

Run: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
Expected: 成功（route 一覧に registry search 含む）。

---

### Task 6: 実サイト無料検証（候補一覧が返るか）

**Files:** なし（本番VPS上の無料 probe・課金なし）

- [ ] **Step 1: 提出前レビュー**

`feature-dev:code-reviewer`（sonnet）に staged diff をレビュー依頼。ホットスポット指定: 課金防止（確定/請求を押さない・キャンセルで閉じる）／PII 非露出（診断ログ・候補を error/audit に出さない）／認可（route 不変）／fake テスト妥当性（呼び出し順・0件 timeout 分類）。

- [ ] **Step 2: （任意・強く推奨）本番VPSで無料検証**

worktree のコードを本番へ反映する前に、adapter ロジックと同等手順の無料 probe（ログイン→不動産請求→所在/地番→ダイアログ検索→候補読取→キャンセル→ログアウト）を1回実行し、候補一覧（地番）が返ることを確認。**確定/請求は絶対に押さない**。probe 一時ファイルは実行後に必ず削除。

- [ ] **Step 3: PR 作成 → @codex → マージ（ユーザー）→ 本番反映（vps-deploy）→ 実機で「候補一覧が出る」確認**

段階① は候補一覧まで（課金なし）。マージ・反映後、御社の実機で不動産番号なし物件 →「所在で謄本を検索」→ 候補一覧表示を確認。段階②（有料請求＋PDF取得）は別プラン。

---

## Self-Review 結果

- **Spec coverage**: 段階①の全要素（不動産請求遷移／所在フォーム／地番ダイアログ非同期ロード待ち／候補抽出／課金しない＝キャンセル／診断ログ／PII 非露出／fake TDD）を Task 1-6 で網羅。段階②（請求＋DL・安全機構）は本プラン非対象（別プラン）で spec 明記どおり。
- **Placeholder scan**: なし（全 step に実コード/実コマンド）。
- **Type consistency**: `extractChibanCandidateRows` の戻り型 `{candidateRef; lotNumber}` は Task 2 定義＝Task 3 消費で一致。セレクタ定数名 `dialogChibanKaokuListButton` は Task 3 Step4 で追加を明示（Task 1 との名前統一を注記済み）。`searchByLocation` の戻り型 `RegistryCandidate[]` は types.ts と一致。
