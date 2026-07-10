# 販売図面 下部の会社帯（御社ひな型再現）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 販売図面（マイソク）の下部フッターを、現状の「会社名+TEL の1行＋取引態様等の1行」から、御社提供ひな型どおりの**多ブロック横並び会社帯**（会社ブロック＋取引条件テーブル＋担当テーブル）へ作り直す。

**Architecture:** `computeSpecSheetLayout` が返す `footer` 矩形（下部帯の領域）に、純関数 `buildFooterBand(footer, data)` が会社定数＋図面ごとの取引/担当情報から text/table/shape 要素群を組む。会社情報は `company-info.ts` の `COMPANY_INFO` 定数に集約（将来F4で設定画面化）。二重レンダラ・保存境界・要素スキーマは無改修（既存の text/table/shape 種別のみ使用）。

**Tech Stack:** TypeScript / 既存 `src/lib/sales-sheet/`（layout-engine.ts, build-document.ts, document-schema.ts）／Vitest（env=node, `renderToStaticMarkup`＋文字列assert）。

## Global Constraints

- **既存 element 種別のみ**：`text`（単色・部分色不可）/`table`（`rows:{label,value}[]`・borderColor/labelColor）/`shape`（rect/line・fill/stroke）。ロゴ画像は当面なし。二重レンダラ（`render-html.ts`＋`SalesSheetRenderer.tsx`）は**無改修**。
- **色**：`NAVY = "#15324f"`（ラベル/社名/枠）、`RED = "#d0331a"`（価格のみ・帯では未使用）。テーマ accent は NAVY。
- **会社情報の値は `COMPANY_INFO` からのみ**（ハードコード散在禁止）。実値は Task 1 に記載のものを**逐語**で使う。
- **ひな型は横並び固定高帯**（会社ブロック左／取引条件 中／担当 右）。担当情報が全空なら担当セクションを**省略**（横方向のコンパクト版）。※旧仕様の「footerHeight 2段階（高さ可変）」はひな型が横並びのため**固定高＋担当の横トグル**へ読み替える（設計判断・要ユーザー確認）。
- TDD（RED→GREEN）。フル `npx vitest run` 緑・`tsc --noEmit`=0・`eslint 変更ファイル`=0・`npm run build` 緑を「完了」条件とする。
- 保存済み既存デザインは不変（ビルダー出力のみ変更・migration 無し）。

---

## File Structure

- **Create** `src/lib/sales-sheet/company-info.ts` — `COMPANY_INFO` 定数（会社ブロックの全項目）。
- **Create** `src/lib/sales-sheet/footer-band.ts` — 純関数 `buildFooterBand(footer: Rect, data: FooterBandData): SalesSheetElement[]` ＋ `FooterBandData` 型。
- **Modify** `src/lib/sales-sheet/layout-engine.ts` — `SpecSheetLayout` に `footer: Rect` を追加（帯領域）。`DEFAULT_FOOTER_H` を帯が収まる高さへ引き上げ。
- **Modify** `src/lib/sales-sheet/build-document.ts` — フッター2要素（`company`/`company-details`）を `buildFooterBand(L.footer, …)` の展開へ置換。`SpecSheetParts` のフッター入力を `footerDetails:string` から構造化フィールドへ。4つの `buildSale*Document` 呼び出し側を更新。
- **Modify（テスト）** `layout-engine.test.ts` ＋ `build-mansion/land/house/building.test.ts` ＋ `render-html-parity.test.ts`。

---

## Task 1: 会社情報定数 `company-info.ts`

**Files:** Create `src/lib/sales-sheet/company-info.ts`, Test `src/lib/sales-sheet/__tests__/company-info.test.ts`

**Interfaces:**
- Produces: `COMPANY_INFO`（下記 as const オブジェクト）。他タスクが会社ブロック文言に使う。

値は御社ひな型PDF（2026-07-10）より逐語：

- [ ] **Step 1: 失敗テストを書く** — `__tests__/company-info.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { COMPANY_INFO } from "../company-info";

describe("COMPANY_INFO", () => {
  it("御社ひな型の会社情報を保持する", () => {
    expect(COMPANY_INFO.nameJa).toBe("株式会社リガーレジャパン");
    expect(COMPANY_INFO.nameEn).toBe("Ligare Japan");
    expect(COMPANY_INFO.license).toBe("宅建免許 東京都知事免許(1)第108344号");
    expect(COMPANY_INFO.guaranteeAssoc).toBe("保証協会 （公社）全国宅地建物取引業保証協会");
    expect(COMPANY_INFO.memberAssoc).toBe("所属協会 （公社）東京都宅地建物取引業協会");
    expect(COMPANY_INFO.tel).toBe("03-6823-2760");
    expect(COMPANY_INFO.fax).toBe("03-6823-2761");
    expect(COMPANY_INFO.email).toBe("info@ligarejapan.com");
    expect(COMPANY_INFO.hp).toBe("https://ligarejapan.com/");
    expect(COMPANY_INFO.address).toBe("154-0011 東京都世田谷区上馬4-36-15");
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/sales-sheet/__tests__/company-info.test.ts`（Cannot find module）。
- [ ] **Step 3: 最小実装**

```ts
/** 会社帯（下部フッター）の会社情報。将来 F4 で設定画面化する差し替え口。値は御社ひな型PDF（2026-07-10）より。 */
export const COMPANY_INFO = {
  nameJa: "株式会社リガーレジャパン",
  nameEn: "Ligare Japan",
  license: "宅建免許 東京都知事免許(1)第108344号",
  guaranteeAssoc: "保証協会 （公社）全国宅地建物取引業保証協会",
  memberAssoc: "所属協会 （公社）東京都宅地建物取引業協会",
  tel: "03-6823-2760",
  fax: "03-6823-2761",
  email: "info@ligarejapan.com",
  hp: "https://ligarejapan.com/",
  address: "154-0011 東京都世田谷区上馬4-36-15",
} as const;
```

- [ ] **Step 4: GREEN 確認** — 同コマンドで PASS。
- [ ] **Step 5: commit** — `feat(sales-sheet): 会社帯の会社情報定数 COMPANY_INFO`

---

## Task 2: 帯ビルダー `footer-band.ts`（純関数）

**Files:** Create `src/lib/sales-sheet/footer-band.ts`, Test `src/lib/sales-sheet/__tests__/footer-band.test.ts`

**Interfaces:**
- Consumes: `COMPANY_INFO`（Task1）、`Rect`（layout-engine.ts）、`SalesSheetElement`（document-schema.ts）。
- Produces: `FooterBandData`（下記）、`buildFooterBand(footer: Rect, data: FooterBandData): SalesSheetElement[]`。

```ts
export interface FooterBandData {
  transactionType?: string; // 取引態様（例: 仲介）
  adType?: string;          // 広告（例: 不可）
  compensation?: string;    // 報酬（例: 相談）
  staff?: string;           // 担当者
  agent?: string;           // 取引士
  specialNotes?: string;    // 特記事項
}
```

**帯レイアウト（ひな型準拠・比率ベースで `footer` 矩形から算出、定数は調整可）：**
- 帯全体＝`footer`（既定 x=10, w=277, y=mainBottom, h=DEFAULT_FOOTER_H）。
- 横3分割：会社ブロック `companyW≈round(footer.w*0.55)`、取引条件 `termsW≈round(footer.w*0.16)`、担当 残り。区切りは縦 `shape:"line"`。
- **会社ブロック**（左・x=footer.x+PAD）：
  - 社名JP `COMPANY_INFO.nameJa`（NAVY・bold・~13pt）＋ 社名EN `nameEn`（NAVY・bold・~11pt・JP名の右に固定オフセット＝JP名は定数長ゆえ決定的）。
  - TEL/FAX（社名の右・~8pt NAVY・2行）：`TEL ${tel}` / `FAX ${fax}`。
  - 情報グリッド（社名下・2列×3行・~6.5pt NAVY）：左列＝`license`/`guaranteeAssoc`/`memberAssoc`、右列＝`Email ${email}`/`H　P ${hp}`/`所在地 ${address}`。
- **取引条件テーブル**（中・`type:"table"`）：`rows`＝`取引態様/広告/報酬` のうち値のある行（`companyFooterDetails` と同じ falsy 落とし）。空なら空文字1行でも可（枠は出す）。style＝`{ fontSizePt, labelColor: NAVY, borderColor: "#999999" }`。
- **担当テーブル**（右・`type:"table"`）：`担当/取引士/特記事項` のうち値のある行。**3項目すべて空なら担当テーブルと右区切り線を出さない**（コンパクト版）。
- **枠**：帯外周 `shape:"rect"`（stroke NAVY, fill 無し or `#f7f9fb` 淡色＝「色付き帯」）＋区切り縦線。z 順は枠(1)→テキスト/表(2)。
- element id：`footer-band` / `footer-divider-terms` / `footer-divider-staff` / `footer-name-ja` / `footer-name-en` / `footer-tel` / `footer-fax` / `footer-license` / `footer-guarantee` / `footer-member` / `footer-email` / `footer-hp` / `footer-address` / `footer-terms-table` / `footer-staff-table`。

- [ ] **Step 1: 失敗テストを書く** — `__tests__/footer-band.test.ts`（純関数を mock Rect で検証）

```ts
import { describe, it, expect } from "vitest";
import { buildFooterBand } from "../footer-band";
import { COMPANY_INFO } from "../company-info";

const FOOTER = { x: 10, y: 184, w: 277, h: 24 };
const byId = (els: any[], id: string) => els.find((e) => e.id === id);

describe("buildFooterBand", () => {
  it("会社ブロックの各文言を出す", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-name-ja").content).toBe(COMPANY_INFO.nameJa);
    expect(byId(els, "footer-name-en").content).toBe(COMPANY_INFO.nameEn);
    expect(byId(els, "footer-license").content).toContain("東京都知事免許(1)第108344号");
    expect(byId(els, "footer-email").content).toContain(COMPANY_INFO.email);
    expect(byId(els, "footer-hp").content).toContain(COMPANY_INFO.hp);
    expect(byId(els, "footer-address").content).toContain(COMPANY_INFO.address);
  });
  it("取引条件テーブルに取引態様/広告/報酬を流し込む", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介", adType: "不可", compensation: "相談" });
    const t = byId(els, "footer-terms-table");
    expect(t.type).toBe("table");
    expect(JSON.stringify(t.rows)).toContain("仲介");
    expect(JSON.stringify(t.rows)).toContain("相談");
  });
  it("担当情報があれば担当テーブルを出す", () => {
    const els = buildFooterBand(FOOTER, { staff: "村山廉太郎", agent: "村山廉太郎" });
    expect(byId(els, "footer-staff-table")).toBeTruthy();
    expect(JSON.stringify(byId(els, "footer-staff-table").rows)).toContain("村山廉太郎");
  });
  it("担当情報が全空なら担当テーブルを省略（コンパクト版）", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-staff-table")).toBeUndefined();
  });
  it("全要素が帯矩形の内側に収まる（A4/幾何不変条件）", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介", staff: "村山廉太郎" });
    for (const e of els) {
      expect(e.x).toBeGreaterThanOrEqual(FOOTER.x - 0.01);
      expect(e.y).toBeGreaterThanOrEqual(FOOTER.y - 0.01);
      expect(e.x + e.w).toBeLessThanOrEqual(FOOTER.x + FOOTER.w + 0.01);
      expect(e.y + e.h).toBeLessThanOrEqual(FOOTER.y + FOOTER.h + 0.01);
    }
  });
});
```

- [ ] **Step 2: 失敗を確認** — Cannot find module。
- [ ] **Step 3: 最小実装** — 上記レイアウト規則を比率＋PAD定数で実装。会社名ENは JP名幅の固定オフセット（定数長ゆえ決定的）。取引/担当は値のある行のみ（`.filter`）。担当全空なら担当table・右区切りを push しない。全要素は `footer` 内にクランプ。
- [ ] **Step 4: GREEN 確認** — 全 it が PASS。
- [ ] **Step 5: commit** — `feat(sales-sheet): 会社帯ビルダー buildFooterBand（純関数）`

---

## Task 3: エンジン `footer` 矩形＋ビルダー結線＋テスト更新（統合・原子的）

**Files:** Modify `layout-engine.ts`, `build-document.ts`; Test `layout-engine.test.ts`, `build-{mansion,land,house,building}.test.ts`, `render-html-parity.test.ts`

> このタスクは分割不可（footerHeight 引き上げ↔build-document↔build-*テスト↔engineテストが相互依存）。TDDで**テストと実装を同時に**更新し、各ステップ後にフル `npx vitest run` 緑を保つ。

**Interfaces:**
- Consumes: `buildFooterBand`（Task2）、`FooterBandData`。
- Produces: `SpecSheetLayout.footer: Rect`。`SpecSheetParts` のフッター入力を構造化。

- [ ] **Step 1: エンジンに `footer` 矩形を追加（RED→GREEN）**
  - `SpecSheetLayout` に `footer: Rect` を追加。`layout-engine.ts` で `const footer: Rect = { x: COMPANY_X_MM, y: mainBottom, w: COMPANY_W_MM, h: footerHeight };` を返す（`company`/`companyDetails` は当面**残す**＝build-document がまだ使うのでコンパイル維持）。
  - `DEFAULT_FOOTER_H` を `16` → **`24`**（帯が4行＋表を収める高さ・調整可）。
  - `layout-engine.test.ts`：`footer` 矩形の assert 追加（x=10,y=mainBottom,w=277,h=footerHeight）。既存 `company`/`companyDetails`・`overview`・`photoArea` 等は **footerHeight 既定が24前提の期待値へ更新**（`mainBottom = 210 - 24 - 2 = 184`）。フル `npx vitest run src/lib/sales-sheet/__tests__/layout-engine.test.ts` 緑。

- [ ] **Step 2: `SpecSheetParts` のフッター入力を構造化（RED→GREEN）**
  - `SpecSheetParts` の `footerDetails?: string` を撤去し、`footer?: FooterBandData` を追加（または `footerData?: FooterBandData`）。
  - `build-document.ts` の footer 要素構築（`company`/`company-details` の2要素）を **`...buildFooterBand(L.footer, parts.footer ?? {})`** へ置換。旧 `COMPANY` 定数・`companyFooterDetails`/`mansionFooterDetails` は帯へ移行後に不要になれば削除（`companyFooterDetails` は各 `buildSale*` で `FooterBandData` を組む形へ）。
  - `buildSpecSheetDocument` の `computeSpecSheetLayout({ …, footerHeight: DEFAULT_FOOTER_H })` は据え置き（DEFAULT_FOOTER_H が24になった）。
  - 4つの `buildSale{Mansion,Land,House,Building}Document`：従来 `footerDetails: companyFooterDetails(o)` を渡していた箇所を、`footer: { transactionType: o.transactionType, adType: o.adType, compensation: o.compensation, staff: o.staff, agent: o.agent, specialNotes: o.specialNotes }` へ。

- [ ] **Step 3: build-*.test.ts（4ファイル）を帯要素へ更新（RED→GREEN）**
  - 旧 `company`/`company-details` の `toMatchObject`（exact geometry/style）assert を、新帯要素の assert へ更新：`findEl(doc,"footer-name-ja").content === COMPANY_INFO.nameJa`、`JSON.stringify(doc.elements)` が `"株式会社リガーレジャパン"`・種別ごとの `transactionType` 値を含む、担当空でコンパクト（`footer-staff-table` 無し）等。
  - レイアウト非回帰テストの `computeSpecSheetLayout({… footerHeight:16})` を **24** へ（コメント「build-document の DEFAULT_FOOTER_H と同値」を維持）。`footer` 矩形の期待値を追加。

- [ ] **Step 4: パリティテストに帯シグナルを追加（RED→GREEN）**
  - `render-html-parity.test.ts` の `sampleDocument` が帯要素を含むなら `KEY_SIGNALS` に `"株式会社リガーレジャパン"` を追加（両レンダラ出力に出ることを確認）。含まないなら sample に mansion doc を使うか、footer-band を含む最小docを足す。

- [ ] **Step 5: フル緑確認** — `npx vitest run`（全 8500+ 緑）・`npx tsc --noEmit`=0・`npx eslint <変更ファイル>`=0・`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 緑。
- [ ] **Step 6: commit** — `feat(sales-sheet): 下部フッターを会社帯（buildFooterBand）へ置換・エンジンに footer 矩形`

---

## 実装後（コーディネータ作業・SDDタスク外）

- **視覚プレビュー**：一時 vitest で mansion doc を HTML 化→PNG 化し、ひな型と突き合わせて帯の比率/PAD/フォントを調整（`footer-band.ts` の定数のみ）。プレビューはユーザーへ送付。
- **設計判断のフラグ**：(a)「固定高＋担当横トグル」への読み替え、(b)表ラベルセルのグレー背景は未再現（table要素にセル背景が無いため・follow-up）、(c)社名ENの色/書体、(d)`DEFAULT_FOOTER_H=24` によるメイン領域の縮み——をユーザーに提示。
- `@codex review`（codex-triage）→ 実在指摘を全解消 → **ユーザーがマージ**。マージ順は **機能A→機能B**（本ブランチは機能A上に積む stacked PR）。

## スコープ外

- F4 会社情報設定画面・ロゴ画像アップロード（帯は当面 COMPANY_INFO 固定＋テキスト）。
- QRコードの帯内配置。表セルのグレー背景（table要素拡張が要るため別途）。
