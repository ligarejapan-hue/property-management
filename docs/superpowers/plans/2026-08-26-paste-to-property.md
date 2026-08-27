# 貼り付けて物件化（第1弾） 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 社外から届いたメール本文・PDF・ブラウザ画面を貼り付けると、読み取れた項目が埋まった確認画面が出て、確認のうえ物件（と所有者）を1回で登録できるようにする。

**Architecture:** 読み取りを4段（テキスト化 → ラベルと値に分解 → 辞書でアプリの欄へ対応づけ → 送り元ごとの後処理）に分ける。段2〜4は `src/lib/paste-import/` の**純関数**として実装し、Prisma・fetch・fs を一切 import しない。API は純関数を呼ぶだけの薄い層。画面は下書きを受け取って表示・編集し、確定時に別 API を叩く。

**Tech Stack:** Next.js App Router / TypeScript / Prisma(PostgreSQL) / vitest(env=node・jsdom なし) / 既存 `extractTextFromPdf`(pdf-parse) / 既存 UI 部品(`PageHeader` `Button` `ConfirmDialog` `ModalShell`)

**Spec:** `docs/superpowers/specs/2026-08-26-paste-to-property-design.md`

**Worktree:** `C:\Users\issin\Desktop\Claude\property-management-worktrees\paste-to-property`（branch `feat/paste-to-property`・base `7eaeab50`）

## Global Constraints

- **DB migration を作らない。** 受け皿の列はすべて既存。`prisma/schema.prisma` を変更したら計画違反。
- **新しい依存を足さない。新しい env を足さない。**
- **段2〜4の lib は Prisma / next/server / node:fs を import しない。** 純関数のみ。
- **vitest は env=node（jsdom なし）。** UI は `renderToStaticMarkup` + ソース文字列 assert で検証する。クリックや state 遷移の単体テストは書けない。
- **テストの見本に実在の個人情報を入れない。** 氏名・カナ・電話・メール・査定ナンバーは架空値。**桁数・区切り・全角半角の別は実物どおり**にする。
- **ファイル読み込みは LF 正規化してから比較する**（`replace(/\r\n/g, "\n")`）。手元は CRLF、CI は LF。
- **ログ・監査ログに貼った原文・氏名・電話・メールを出さない。** 出してよいのは既知の固定文字列と件数のみ。
- **所有者住所は `currentAddress`（現住所）へ入れる。`address`（登記上住所）は空のまま。**
- 拾えなかった欄は**推測で埋めない**。空欄 + 「元の資料に記載がありません」。
- コミットメッセージ末尾に必ず付ける:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4`

## File Structure

| ファイル | 責務 |
|---|---|
| `src/lib/paste-import/parse-labeled-lines.ts` | 段2。テキストを「見出しと中身」に割る |
| `src/lib/paste-import/normalize.ts` | 全段で使う正規化（全角半角・和暦・面積・括弧地番） |
| `src/lib/paste-import/label-dictionary.ts` | 段3。ラベル名 → 下書きの欄 |
| `src/lib/paste-import/property-type-dictionary.ts` | 物件種別の言い換え → `PropertyType` |
| `src/lib/paste-import/source-profiles.ts` | 段4。送り元の判定と、送り元固有の後処理 |
| `src/lib/paste-import/build-draft.ts` | 段2〜4を通して `PasteDraft` を組み立てる |
| `src/lib/paste-import/types.ts` | `PasteDraft` ほか共有の型 |
| `src/lib/paste-import/find-duplicates.ts` | 重複判定の**純関数**（DB 検索の結果を受け取って判定する） |
| `src/app/api/import/paste/route.ts` | 下書きを返す（PDF or テキストを受ける） |
| `src/app/api/import/paste/commit/route.ts` | 確定して物件・所有者・添付を作る |
| `src/components/import/paste-import-form.tsx` | 貼り付け欄 |
| `src/components/import/paste-import-review.tsx` | 確認画面（下書きの表示・編集） |
| `src/app/(dashboard)/import/paste/page.tsx` | 画面本体 |

---

### Task 1: 段2 — 見出しと中身に割る

**Files:**
- Create: `src/lib/paste-import/parse-labeled-lines.ts`
- Test: `src/lib/paste-import/__tests__/parse-labeled-lines.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  ```ts
  export interface LabeledLine { label: string; value: string; lineNumber: number }
  export interface ParsedLines { labeled: LabeledLine[]; unlabeled: string[] }
  export function parseLabeledLines(text: string): ParsedLines
  export function isBlankValue(value: string): boolean
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/paste-import/__tests__/parse-labeled-lines.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseLabeledLines, isBlankValue } from "../parse-labeled-lines";

describe("parseLabeledLines（見出しと中身に割る）", () => {
  it("全角コロン・半角コロン・タブを同じように扱う", () => {
    const r = parseLabeledLines("■物件種別　： 土地\n物件種別: 土地\n物件種別\t土地");
    expect(r.labeled.map((l) => l.label)).toEqual(["物件種別", "物件種別", "物件種別"]);
    expect(r.labeled.map((l) => l.value)).toEqual(["土地", "土地", "土地"]);
  });

  it("行頭の飾り文字を落とす", () => {
    expect(parseLabeledLines("■お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("●お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("・お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("【お名前】：山田").labeled[0].label).toBe("お名前");
  });

  it("ラベルと値の前後の空白（全角含む）を落とす", () => {
    const r = parseLabeledLines("■物件所在地　　　：　東京都世田谷区　");
    expect(r.labeled[0].label).toBe("物件所在地");
    expect(r.labeled[0].value).toBe("東京都世田谷区");
  });

  it("値の中のコロンは割らない（最初の区切りだけで割る）", () => {
    const r = parseLabeledLines("私道負担の有無\t私道（地番：552-11）持ち分あり");
    expect(r.labeled[0].label).toBe("私道負担の有無");
    expect(r.labeled[0].value).toBe("私道（地番：552-11）持ち分あり");
  });

  it("区切りの無い行は捨てずに unlabeled で持つ", () => {
    const r = parseLabeledLines("査定依頼のお知らせ\n■お名前：山田");
    expect(r.unlabeled).toEqual(["査定依頼のお知らせ"]);
    expect(r.labeled).toHaveLength(1);
  });

  it("行番号を1始まりで持つ（原文と突き合わせるため）", () => {
    const r = parseLabeledLines("見出し\n■お名前：山田");
    expect(r.labeled[0].lineNumber).toBe(2);
  });

  it("CRLF を LF に正規化してから割る", () => {
    const r = parseLabeledLines("■お名前：山田\r\n■年齢：71");
    expect(r.labeled).toHaveLength(2);
    expect(r.labeled[0].value).toBe("山田");
  });

  it("空行は unlabeled にも入れない", () => {
    const r = parseLabeledLines("■お名前：山田\n\n　\n■年齢：71");
    expect(r.unlabeled).toEqual([]);
    expect(r.labeled).toHaveLength(2);
  });

  it("ラベルが空の行は割らない（値だけの行を見出し扱いしない）", () => {
    const r = parseLabeledLines("：値だけ");
    expect(r.labeled).toHaveLength(0);
    expect(r.unlabeled).toEqual(["：値だけ"]);
  });
});

describe("isBlankValue（値なしの見分け）", () => {
  it("ハイフン類・空文字を値なしとする", () => {
    for (const v of ["-", "ー", "−", "―", "", "  ", "　"]) {
      expect(isBlankValue(v), `"${v}" は値なしのはず`).toBe(true);
    }
  });
  it("中身のある値は値なしとしない", () => {
    for (const v of ["0", "なし", "70 平米", "-1"]) {
      expect(isBlankValue(v), `"${v}" は値ありのはず`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/parse-labeled-lines.test.ts`
Expected: FAIL（`Cannot find module '../parse-labeled-lines'`）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/paste-import/parse-labeled-lines.ts`:

```ts
/**
 * 段2: 貼られたテキストを「見出し(label)」と「中身(value)」に割る純関数。
 *
 * 区切りは全角コロン `：` / 半角コロン `:` / タブ を等価に扱う。
 * 実サンプルの実測: HOME4U 査定依頼は全角コロン、空き家相談 PDF はタブ。
 *
 * ⚠ Prisma / next / node:fs を import しないこと（純関数を保つため）。
 */

export interface LabeledLine {
  label: string;
  value: string;
  /** 原文の何行目か（1始まり）。確認画面で原文と突き合わせるために持つ。 */
  lineNumber: number;
}

export interface ParsedLines {
  labeled: LabeledLine[];
  /** 区切りが無かった行。捨てずに持つ（原文照合と、拾い漏れの調査のため）。 */
  unlabeled: string[];
}

/** 行頭の飾り文字。実サンプルに出たものと、同種でよく使われるもの。 */
const ORNAMENT = /^[\s\u3000]*[■●◆▼▶・*※\-–—]?[\s\u3000]*/;
/** 【ラベル】形式の括弧。 */
const BRACKET = /^【(.*)】$/;

const SEPARATORS = ["：", ":", "\t"];

/** 全角・半角の空白を両端から落とす。 */
function trimWide(s: string): string {
  return s.replace(/^[\s\u3000]+/, "").replace(/[\s\u3000]+$/, "");
}

/**
 * 「値なし」を見分ける。実サンプルAでは 9 項目が "-" だった。
 * 0 や "なし" は**意味のある値**なので値なしにしない。
 */
export function isBlankValue(value: string): boolean {
  const t = trimWide(value);
  if (t === "") return true;
  return /^[-ー−―]+$/.test(t);
}

function stripOrnament(label: string): string {
  const withoutOrnament = trimWide(label.replace(ORNAMENT, ""));
  const bracket = BRACKET.exec(withoutOrnament);
  return bracket ? trimWide(bracket[1]) : withoutOrnament;
}

/** 最初に現れる区切りの位置。見つからなければ -1。 */
function firstSeparatorIndex(line: string): number {
  let found = -1;
  for (const sep of SEPARATORS) {
    const i = line.indexOf(sep);
    if (i !== -1 && (found === -1 || i < found)) found = i;
  }
  return found;
}

export function parseLabeledLines(text: string): ParsedLines {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const labeled: LabeledLine[] = [];
  const unlabeled: string[] = [];

  lines.forEach((raw, idx) => {
    const lineNumber = idx + 1;
    if (trimWide(raw) === "") return; // 空行は捨てる

    const sepAt = firstSeparatorIndex(raw);
    if (sepAt === -1) {
      unlabeled.push(trimWide(raw));
      return;
    }

    const label = stripOrnament(raw.slice(0, sepAt));
    // ⚠ 値の側は最初の区切りより後を**そのまま**取る。値の中のコロンで割らない
    //   （実サンプル「私道（地番：552-11）持ち分あり」がこれに当たる）。
    const value = trimWide(raw.slice(sepAt + 1));

    if (label === "") {
      unlabeled.push(trimWide(raw));
      return;
    }
    labeled.push({ label, value, lineNumber });
  });

  return { labeled, unlabeled };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/parse-labeled-lines.test.ts`
Expected: PASS（16 assertions 前後・失敗0）

- [ ] **Step 5: コミット**

```bash
git add src/lib/paste-import/parse-labeled-lines.ts src/lib/paste-import/__tests__/parse-labeled-lines.test.ts
git commit -m "feat(paste-import): 段2 見出しと中身に割る純関数

区切りは全角コロン/半角コロン/タブを等価に扱い、行頭の飾り文字と
全角空白を落とす。値の中のコロンでは割らない（実サンプルの
「私道（地番：552-11）持ち分あり」がこれに当たる）。
区切りの無い行は unlabeled として保持し、原文照合に使えるようにする。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 2: 共通の正規化（全角半角・和暦・面積・括弧地番）

**Files:**
- Create: `src/lib/paste-import/normalize.ts`
- Test: `src/lib/paste-import/__tests__/normalize.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export function toHalfWidth(s: string): string
  export function warekiToSeireki(s: string): number | null
  export function parseAreaSqm(s: string): number | null
  export function splitLotNumberFromAddress(a: string): { address: string; lotNumber: string | null }
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/paste-import/__tests__/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  toHalfWidth,
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
} from "../normalize";

describe("toHalfWidth（全角英数字を半角へ）", () => {
  it("英数字とハイフンを半角にする", () => {
    expect(toHalfWidth("１年以内")).toBe("1年以内");
    expect(toHalfWidth("ＳＡ２６０８－８４２")).toBe("SA2608-842");
  });
  it("日本語はそのまま（カタカナを半角にしない）", () => {
    expect(toHalfWidth("東京都世田谷区")).toBe("東京都世田谷区");
    expect(toHalfWidth("サトウ　ハナコ")).toBe("サトウ　ハナコ");
  });
});

describe("warekiToSeireki（和暦を西暦へ）", () => {
  it("実サンプルの平成8年を1996年にする", () => {
    expect(warekiToSeireki("平成8年建築")).toBe(1996);
  });
  it("元号の境界年を正しく変換する", () => {
    expect(warekiToSeireki("昭和64年")).toBe(1989);
    expect(warekiToSeireki("平成元年")).toBe(1989);
    expect(warekiToSeireki("平成31年")).toBe(2019);
    expect(warekiToSeireki("令和元年")).toBe(2019);
    expect(warekiToSeireki("令和3年")).toBe(2021);
  });
  it("全角数字の和暦も変換する", () => {
    expect(warekiToSeireki("平成８年")).toBe(1996);
  });
  it("西暦がそのまま書かれていれば数値で返す", () => {
    expect(warekiToSeireki("2013 年")).toBe(2013);
    expect(warekiToSeireki("2013年建築")).toBe(2013);
  });
  it("読み取れなければ null（推測しない）", () => {
    expect(warekiToSeireki("築浅")).toBeNull();
    expect(warekiToSeireki("")).toBeNull();
    expect(warekiToSeireki("-")).toBeNull();
  });
  it("元号が分からないものは null", () => {
    expect(warekiToSeireki("大化3年")).toBeNull();
  });
});

describe("parseAreaSqm（面積を数値へ）", () => {
  it("実サンプルの「70 平米」を70にする", () => {
    expect(parseAreaSqm("70 平米")).toBe(70);
  });
  it("㎡・m2・小数・カンマを扱う", () => {
    expect(parseAreaSqm("70.55㎡")).toBe(70.55);
    expect(parseAreaSqm("70m2")).toBe(70);
    expect(parseAreaSqm("1,234.5 ㎡")).toBe(1234.5);
    expect(parseAreaSqm("７０平米")).toBe(70);
  });
  it("数値が無ければ null", () => {
    expect(parseAreaSqm("-")).toBeNull();
    expect(parseAreaSqm("約")).toBeNull();
  });
});

describe("splitLotNumberFromAddress（括弧の中の地番を分ける）", () => {
  it("実サンプルの「（地番552-2）」を分離する", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（地番552-2）");
    expect(r.address).toBe("世田谷区池尻4丁目26-8");
    expect(r.lotNumber).toBe("552-2");
  });
  it("「（地番：552-2）」のコロン付きも分離する", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（地番：552-2）");
    expect(r.lotNumber).toBe("552-2");
  });
  it("半角括弧も扱う", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8(地番552-2)");
    expect(r.address).toBe("世田谷区池尻4丁目26-8");
    expect(r.lotNumber).toBe("552-2");
  });
  it("地番が無ければ住所はそのまま・地番は null", () => {
    const r = splitLotNumberFromAddress("東京都世田谷区等々力2丁目15番12号");
    expect(r.address).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(r.lotNumber).toBeNull();
  });
  it("地番以外の括弧書きは住所に残す（勝手に消さない）", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（旧町名あり）");
    expect(r.address).toBe("世田谷区池尻4丁目26-8（旧町名あり）");
    expect(r.lotNumber).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/normalize.test.ts`
Expected: FAIL（`Cannot find module '../normalize'`）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/paste-import/normalize.ts`:

```ts
/**
 * 貼り付け取込で全段が共有する正規化。純関数のみ。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */

/** 全角の英数字・記号を半角へ。**カナや漢字は変換しない**（氏名を壊さないため）。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[－ー−―]/g, "-");
}

/** 元号の開始年（その元号の1年＝この西暦）。 */
const ERAS: { name: string; startYear: number }[] = [
  { name: "令和", startYear: 2019 },
  { name: "平成", startYear: 1989 },
  { name: "昭和", startYear: 1926 },
  { name: "大正", startYear: 1912 },
  { name: "明治", startYear: 1868 },
];

/**
 * 和暦（平成8年 など）を西暦に。西暦がそのまま書かれていればその数値を返す。
 * 読み取れなければ null（**推測しない**）。
 */
export function warekiToSeireki(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/[\s\u3000]/g, "");
  if (s === "") return null;

  for (const era of ERAS) {
    if (!s.includes(era.name)) continue;
    const m = new RegExp(`${era.name}(元|\\d{1,2})年`).exec(s);
    if (!m) return null;
    const nth = m[1] === "元" ? 1 : Number(m[1]);
    if (!Number.isFinite(nth) || nth < 1) return null;
    return era.startYear + nth - 1;
  }

  // 西暦（4桁）。年号らしき語が無いときだけ採用する。
  const seireki = /(1[89]\d{2}|20\d{2})\s*年?/.exec(s);
  return seireki ? Number(seireki[1]) : null;
}

/** 「70 平米」「70.55㎡」などを数値へ。数値が無ければ null。 */
export function parseAreaSqm(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 住所の括弧書きに入っている地番を分離する。
 * 実サンプル: `世田谷区池尻4丁目26-8（地番552-2）`
 *
 * ⚠ 住居表示と地番は別物で、登記は地番でしか引けない。ここで分けそこねると
 *   後から謄本が取れなくなる。**地番と明記された括弧だけ**を対象にし、
 *   それ以外の括弧書きは住所に残す（勝手に消さない）。
 */
export function splitLotNumberFromAddress(raw: string): {
  address: string;
  lotNumber: string | null;
} {
  const re = /[（(]\s*地番\s*[:：]?\s*([^）)]+?)\s*[）)]/;
  const m = re.exec(raw);
  if (!m) return { address: raw.trim(), lotNumber: null };
  const address = raw.replace(re, "").replace(/[\s\u3000]+$/, "").trim();
  return { address, lotNumber: m[1].trim() };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/normalize.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/paste-import/normalize.ts src/lib/paste-import/__tests__/normalize.test.ts
git commit -m "feat(paste-import): 共通の正規化（全角半角・和暦・面積・括弧地番）

⚠地番の分離は「地番と明記された括弧」だけを対象にする。住居表示と地番は
別物で、登記は地番でしか引けないため、ここで分けそこねると後から謄本が
取れなくなる。地番以外の括弧書きは住所に残す。
和暦は元号の境界年（昭和64年=平成元年=1989）まで含めて固定した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 3: 段3 — ラベル辞書と物件種別辞書

**Files:**
- Create: `src/lib/paste-import/label-dictionary.ts`
- Create: `src/lib/paste-import/property-type-dictionary.ts`
- Test: `src/lib/paste-import/__tests__/label-dictionary.test.ts`
- Test: `src/lib/paste-import/__tests__/property-type-dictionary.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export type DraftFieldKey =
    | "address" | "lotNumber" | "buildingName" | "propertyTypeRaw"
    | "exclusiveArea" | "landArea" | "layoutType" | "occupancyRaw" | "builtYearRaw"
    | "externalLinkKey"
    | "ownerName" | "ownerNameKana" | "ownerPhone" | "ownerEmail" | "ownerAddress";
  export const LABEL_DICTIONARY: Record<DraftFieldKey, readonly string[]>;
  export function fieldKeyForLabel(label: string): DraftFieldKey | null;
  // property-type-dictionary.ts
  export function propertyTypeForRaw(raw: string):
    { value: "land"|"house"|"apartment_unit"|"apartment_building"|"store"|"office"|"unknown"; confident: boolean };
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/paste-import/__tests__/label-dictionary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LABEL_DICTIONARY, fieldKeyForLabel, type DraftFieldKey } from "../label-dictionary";

describe("fieldKeyForLabel（見出し名からアプリの欄を引く）", () => {
  it("実サンプルAのラベルを引ける", () => {
    expect(fieldKeyForLabel("物件所在地")).toBe("address");
    expect(fieldKeyForLabel("物件種別")).toBe("propertyTypeRaw");
    expect(fieldKeyForLabel("築年数")).toBe("builtYearRaw");
  });

  it("実サンプルBのラベルを引ける", () => {
    expect(fieldKeyForLabel("査定ナンバー")).toBe("externalLinkKey");
    expect(fieldKeyForLabel("物件名称")).toBe("buildingName");
    expect(fieldKeyForLabel("建物（専有）面積")).toBe("exclusiveArea");
    expect(fieldKeyForLabel("間取り")).toBe("layoutType");
    expect(fieldKeyForLabel("築年（西暦）")).toBe("builtYearRaw");
    expect(fieldKeyForLabel("現況")).toBe("occupancyRaw");
    expect(fieldKeyForLabel("お名前")).toBe("ownerName");
    expect(fieldKeyForLabel("フリガナ")).toBe("ownerNameKana");
    expect(fieldKeyForLabel("電話番号")).toBe("ownerPhone");
    expect(fieldKeyForLabel("E-mail")).toBe("ownerEmail");
    expect(fieldKeyForLabel("ご住所")).toBe("ownerAddress");
  });

  it("全角半角・空白のゆれを吸収する", () => {
    expect(fieldKeyForLabel("Ｅ-ｍａｉｌ")).toBe("ownerEmail");
    expect(fieldKeyForLabel("お 名 前")).toBe("ownerName");
    expect(fieldKeyForLabel("e-mail")).toBe("ownerEmail");
  });

  it("⚠「住所」だけの見出しは所有者住所にしない（物件所在地と紛れるため null）", () => {
    expect(fieldKeyForLabel("住所")).toBeNull();
  });

  it("辞書に無い見出しは null（捨てずに備考へ回すのは呼び出し側の仕事）", () => {
    expect(fieldKeyForLabel("心理的瑕疵事項")).toBeNull();
    expect(fieldKeyForLabel("")).toBeNull();
  });

  it("同じ見出しが2つの欄に登録されていない（引き当てが一意）", () => {
    const seen = new Map<string, DraftFieldKey>();
    for (const [key, labels] of Object.entries(LABEL_DICTIONARY)) {
      for (const label of labels) {
        expect(seen.has(label), `「${label}」が ${seen.get(label)} と ${key} に重複`).toBe(false);
        seen.set(label, key as DraftFieldKey);
      }
    }
    expect(seen.size).toBeGreaterThan(20); // 空振り防止
  });
});
```

`src/lib/paste-import/__tests__/property-type-dictionary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { propertyTypeForRaw } from "../property-type-dictionary";

describe("propertyTypeForRaw（物件種別の言い換え）", () => {
  it("実サンプルの2つを変換する", () => {
    expect(propertyTypeForRaw("分譲マンション（区分所有）")).toEqual({
      value: "apartment_unit", confident: true,
    });
    expect(propertyTypeForRaw("一般住宅")).toEqual({ value: "house", confident: true });
  });

  it("よくある言い回しを変換する", () => {
    expect(propertyTypeForRaw("土地").value).toBe("land");
    expect(propertyTypeForRaw("戸建").value).toBe("house");
    expect(propertyTypeForRaw("一戸建て").value).toBe("house");
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("店舗").value).toBe("store");
    expect(propertyTypeForRaw("事務所").value).toBe("office");
  });

  it("⚠知らない種別は unknown にして confident=false（推測で決めない）", () => {
    expect(propertyTypeForRaw("宇宙ステーション")).toEqual({
      value: "unknown", confident: false,
    });
    expect(propertyTypeForRaw("")).toEqual({ value: "unknown", confident: false });
  });

  it("⚠「一棟マンション」を「マンション」より先に判定する（部分一致の順序）", () => {
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("マンション").value).toBe("apartment_unit");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/label-dictionary.test.ts src/lib/paste-import/__tests__/property-type-dictionary.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/paste-import/label-dictionary.ts`:

```ts
/**
 * 段3: 見出し名 → 下書きの欄。純関数のみ。
 *
 * **他社の書式が増えたときは、この辞書に行を足すだけで対応できる。**
 * それがこの方式を選んだ理由なので、正規表現で凝らずに素の文字列で並べる。
 */
import { toHalfWidth } from "./normalize";

export type DraftFieldKey =
  | "address"
  | "lotNumber"
  | "buildingName"
  | "propertyTypeRaw"
  | "exclusiveArea"
  | "landArea"
  | "layoutType"
  | "occupancyRaw"
  | "builtYearRaw"
  | "externalLinkKey"
  | "ownerName"
  | "ownerNameKana"
  | "ownerPhone"
  | "ownerEmail"
  | "ownerAddress";

export const LABEL_DICTIONARY: Record<DraftFieldKey, readonly string[]> = {
  address: ["物件所在地", "所在地", "物件住所", "物件の所在地"],
  lotNumber: ["地番"],
  buildingName: ["物件名称", "建物名", "マンション名", "物件名"],
  propertyTypeRaw: ["物件種別", "種別", "物件の種類"],
  exclusiveArea: ["建物（専有）面積", "専有面積", "建物面積", "建物(専有)面積"],
  landArea: ["土地面積", "敷地面積"],
  layoutType: ["間取り", "間取"],
  occupancyRaw: ["現況", "入居状況", "利用状況"],
  builtYearRaw: ["築年数", "築年", "築年（西暦）", "築年(西暦)", "建築年"],
  externalLinkKey: ["査定ナンバー", "査定番号", "問合せ番号", "反響番号"],
  ownerName: ["お名前", "氏名", "ご氏名", "お客様名"],
  ownerNameKana: ["フリガナ", "ふりがな", "カナ", "お名前カナ"],
  ownerPhone: ["電話番号", "TEL", "連絡先電話番号", "ご連絡先"],
  ownerEmail: ["E-mail", "Email", "メールアドレス", "メール"],
  // ⚠「住所」単独はここに入れない。物件所在地と紛れるため（テストで固定）。
  ownerAddress: ["ご住所", "お客様住所", "現住所"],
};

/** 比較用に見出しを均す（全角半角・空白・記号ゆれを吸収）。 */
function normalizeLabel(label: string): string {
  return toHalfWidth(label)
    .replace(/[\s\u3000]/g, "")
    .replace(/[()（）]/g, "")
    .toLowerCase();
}

const LOOKUP: Map<string, DraftFieldKey> = (() => {
  const m = new Map<string, DraftFieldKey>();
  for (const [key, labels] of Object.entries(LABEL_DICTIONARY)) {
    for (const label of labels) m.set(normalizeLabel(label), key as DraftFieldKey);
  }
  return m;
})();

export function fieldKeyForLabel(label: string): DraftFieldKey | null {
  if (label.trim() === "") return null;
  return LOOKUP.get(normalizeLabel(label)) ?? null;
}
```

`src/lib/paste-import/property-type-dictionary.ts`:

```ts
/**
 * 物件種別の言い換え → PropertyType。
 * ⚠知らない種別は unknown + confident=false にして、確認画面で人に決めてもらう。
 *   推測で決めると、間違った種別のまま登録される。
 */
export type MappedPropertyType =
  | "land" | "house" | "apartment_unit" | "apartment_building"
  | "store" | "office" | "unknown";

/**
 * 部分一致で判定する。**順序が意味を持つ**: 長い語を先に置く。
 * 「一棟マンション」が「マンション」より前にないと apartment_unit になってしまう。
 */
const RULES: { needle: string; value: MappedPropertyType }[] = [
  { needle: "一棟マンション", value: "apartment_building" },
  { needle: "一棟アパート", value: "apartment_building" },
  { needle: "区分所有", value: "apartment_unit" },
  { needle: "分譲マンション", value: "apartment_unit" },
  { needle: "マンション", value: "apartment_unit" },
  { needle: "一戸建", value: "house" },
  { needle: "戸建", value: "house" },
  { needle: "一般住宅", value: "house" },
  { needle: "住宅", value: "house" },
  { needle: "土地", value: "land" },
  { needle: "更地", value: "land" },
  { needle: "店舗", value: "store" },
  { needle: "事務所", value: "office" },
];

export function propertyTypeForRaw(raw: string): {
  value: MappedPropertyType;
  confident: boolean;
} {
  const s = raw.replace(/[\s\u3000]/g, "");
  if (s === "") return { value: "unknown", confident: false };
  for (const rule of RULES) {
    if (s.includes(rule.needle)) return { value: rule.value, confident: true };
  }
  return { value: "unknown", confident: false };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/label-dictionary.test.ts src/lib/paste-import/__tests__/property-type-dictionary.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/paste-import/label-dictionary.ts src/lib/paste-import/property-type-dictionary.ts src/lib/paste-import/__tests__/label-dictionary.test.ts src/lib/paste-import/__tests__/property-type-dictionary.test.ts
git commit -m "feat(paste-import): 段3 ラベル辞書と物件種別辞書

他社の書式が増えたら辞書に行を足すだけで対応できるよう、素の文字列で並べる。
⚠「住所」単独は所有者住所に割り当てない（物件所在地と紛れるため・テストで固定）。
⚠物件種別は部分一致の順序が意味を持つ（一棟マンション→マンションの順）。
知らない種別は unknown + confident=false で確認画面へ回す。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 4: 段4 — 送り元の判定と、建物名・部屋番号の切り出し

**Files:**
- Create: `src/lib/paste-import/source-profiles.ts`
- Test: `src/lib/paste-import/__tests__/source-profiles.test.ts`

**Interfaces:**
- Consumes: `fieldKeyForLabel`（Task 3）は使わない。ラベル文字列だけを見る。
- Produces:
  ```ts
  export type SourceProfileId = "home4u_assessment" | "home4u_vacant_house" | "generic";
  export const SOURCE_PROFILE_LABELS: Record<SourceProfileId, string>;
  export function detectSourceProfile(labels: readonly string[]): SourceProfileId;
  export function splitBuildingAndRoom(
    address: string, buildingName: string | null,
  ): { address: string; roomNo: string | null };
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/paste-import/__tests__/source-profiles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  detectSourceProfile,
  splitBuildingAndRoom,
  SOURCE_PROFILE_LABELS,
} from "../source-profiles";

describe("detectSourceProfile（送り元の見分け）", () => {
  it("査定ナンバーがあれば HOME4U 査定依頼", () => {
    expect(detectSourceProfile(["査定ナンバー", "お名前"])).toBe("home4u_assessment");
  });
  it("空き家所有者との関係性があれば HOME4U 空き家相談", () => {
    expect(detectSourceProfile(["空き家所有者との関係性", "物件所在地"]))
      .toBe("home4u_vacant_house");
  });
  it("どちらでもなければ generic", () => {
    expect(detectSourceProfile(["所在地", "価格"])).toBe("generic");
    expect(detectSourceProfile([])).toBe("generic");
  });
  it("すべてのプロファイルに日本語の名前がある（確認画面に出すため）", () => {
    for (const id of ["home4u_assessment", "home4u_vacant_house", "generic"] as const) {
      expect(SOURCE_PROFILE_LABELS[id]).toBeTruthy();
    }
  });
});

describe("splitBuildingAndRoom（建物名と部屋番号を切り出す）", () => {
  it("実サンプルBの所在地から部屋番号303を切り出す", () => {
    const r = splitBuildingAndRoom(
      "東京都世田谷区等々力2丁目15番12号リーフィアレジデンス等々力303",
      "リーフィアレジデンス等々力",
    );
    expect(r.address).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(r.roomNo).toBe("303");
  });

  it("「303号室」のように号室が付いていても切り出す", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート303号室", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBe("303");
  });

  it("建物名の後ろに何も無ければ部屋番号は null（住所からは建物名を外す）", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBeNull();
  });

  it("⚠建物名が無ければ何も切り出さない（推測しない）", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート303", null);
    expect(r.address).toBe("東京都A区B1-2-3グリーンコート303");
    expect(r.roomNo).toBeNull();
  });

  it("⚠建物名が住所に含まれていなければ何も切り出さない", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBeNull();
  });

  it("部屋番号らしくない文字列は部屋番号にしない", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコートの南側", "グリーンコート");
    expect(r.roomNo).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/source-profiles.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/paste-import/source-profiles.ts`:

```ts
/**
 * 段4: 送り元ごとの癖を直す。純関数のみ。
 *
 * ⚠**同じ提供元でも書式が複数ある**（HOME4U に「空き家相談」と「査定依頼」の
 *   2書式がある）。送り元の判定は URL やファイル名ではなく、**見出しの顔ぶれ**で行う。
 *   貼り付け方式では URL もファイル名も当てにならないため。
 */
import { toHalfWidth } from "./normalize";

export type SourceProfileId =
  | "home4u_assessment"
  | "home4u_vacant_house"
  | "generic";

export const SOURCE_PROFILE_LABELS: Record<SourceProfileId, string> = {
  home4u_assessment: "HOME4U 査定依頼",
  home4u_vacant_house: "HOME4U 空き家相談",
  generic: "その他（共通の読み取り）",
};

function has(labels: readonly string[], needle: string): boolean {
  return labels.some((l) => l.replace(/[\s\u3000]/g, "").includes(needle));
}

export function detectSourceProfile(labels: readonly string[]): SourceProfileId {
  if (has(labels, "査定ナンバー")) return "home4u_assessment";
  if (has(labels, "空き家所有者との関係性")) return "home4u_vacant_house";
  return "generic";
}

/** 部屋番号として認めてよい形（数字、数字+英字、ハイフン区切り）。 */
const ROOM_NO = /^([0-9]{1,5}[A-Za-z]?|[0-9]{1,3}-[0-9]{1,4})(号室|号)?$/;

/**
 * 所在地の末尾にくっついた建物名と部屋番号を切り出す。
 * 実サンプルB: `…15番12号リーフィアレジデンス等々力303` − `リーフィアレジデンス等々力`
 *              → 住所 `…15番12号` / 部屋番号 `303`
 *
 * ⚠建物名が無い、または住所に含まれていなければ**何もしない**。推測しない。
 */
export function splitBuildingAndRoom(
  address: string,
  buildingName: string | null,
): { address: string; roomNo: string | null } {
  const original = address.trim();
  if (!buildingName || buildingName.trim() === "") {
    return { address: original, roomNo: null };
  }
  const at = original.indexOf(buildingName.trim());
  if (at === -1) return { address: original, roomNo: null };

  const head = original.slice(0, at).trim();
  const tail = toHalfWidth(original.slice(at + buildingName.trim().length)).trim();

  if (tail === "") return { address: head, roomNo: null };

  const m = ROOM_NO.exec(tail);
  if (!m) {
    // 建物名の後ろが部屋番号らしくない → 住所を削らず、そのまま返す
    // （情報を失わないほうを優先する）。
    return { address: original, roomNo: null };
  }
  return { address: head, roomNo: m[1] };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/source-profiles.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/paste-import/source-profiles.ts src/lib/paste-import/__tests__/source-profiles.test.ts
git commit -m "feat(paste-import): 段4 送り元の判定と建物名・部屋番号の切り出し

⚠送り元の判定は見出しの顔ぶれで行う。貼り付け方式では URL もファイル名も
当てにならないため。同じ HOME4U でも書式が2種類ある事実が出発点。
⚠建物名が無い/住所に含まれない/末尾が部屋番号らしくない場合は何もしない
（推測せず、情報を失わないほうを優先）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 5: 下書きの組み立てと、実サンプル2件での通し確認

**Files:**
- Create: `src/lib/paste-import/types.ts`
- Create: `src/lib/paste-import/build-draft.ts`
- Create: `src/lib/paste-import/__tests__/fixtures/home4u-vacant-house.txt`
- Create: `src/lib/paste-import/__tests__/fixtures/home4u-assessment.txt`
- Test: `src/lib/paste-import/__tests__/build-draft.test.ts`

**Interfaces:**
- Consumes: `parseLabeledLines` `isBlankValue`（Task 1）/ `toHalfWidth` `warekiToSeireki` `parseAreaSqm` `splitLotNumberFromAddress`（Task 2）/ `fieldKeyForLabel` `propertyTypeForRaw`（Task 3）/ `detectSourceProfile` `splitBuildingAndRoom` `SOURCE_PROFILE_LABELS`（Task 4）
- Produces:
  ```ts
  export type DraftWarningCode =
    | "no_labeled_lines" | "lot_number_missing" | "property_type_unknown" | "address_missing";
  export interface DraftWarning { code: DraftWarningCode; message: string }
  export interface DraftField { value: string | null; sourceLabel: string | null }
  export interface PasteDraft {
    sourceProfile: SourceProfileId;
    sourceProfileLabel: string;
    property: {
      address: DraftField; lotNumber: DraftField; buildingName: DraftField;
      roomNo: DraftField; propertyType: DraftField; exclusiveArea: DraftField;
      landArea: DraftField; layoutType: DraftField; occupancyStatus: DraftField;
      builtYear: DraftField;
    };
    owner: {
      name: DraftField; nameKana: DraftField; phone: DraftField;
      email: DraftField; currentAddress: DraftField;
    } | null;
    externalLinkKey: string | null;
    warnings: DraftWarning[];
    unmapped: { label: string; value: string }[];
    noteFromUnmapped: string;
  }
  export function buildPasteDraft(text: string): PasteDraft
  ```

- [ ] **Step 1: 実サンプルの見本ファイルを作る**

⚠ **氏名・カナ・電話・メール・査定ナンバーは架空値**。書式（`■`・全角コロン・全角空白・
桁数）は実物どおり。

`src/lib/paste-import/__tests__/fixtures/home4u-vacant-house.txt`（タブ区切り。`<TAB>` は実タブ文字で書くこと）:

```
空き家所有者との関係性	本人
物件所在地	世田谷区池尻4丁目26-8（地番552-2）
物件種別	一般住宅
築年数	平成8年建築
建物構造	木造スレート葺
設備	-
間取り	-
物件写真	-
希望する利活用方法	売却
対応期限	-
希望価格	-
コメント	売却を検討しているのでまずは査定をお願いしたい。
他事業者に相談中か否か	なし
駐車場	なし
私道負担の有無	私道（地番：552-11、210-10）持ち分あり
心理的瑕疵事項	-
```

`src/lib/paste-import/__tests__/fixtures/home4u-assessment.txt`:

```
査定依頼

株式会社リガーレジャパン 担当者様

【 査定依頼 -- <東京都> 世田谷区 】

■査定ナンバー　　： SA2608-1234567
■ご依頼日　　　　： 2026/08/24 (月) 06:17:21
■査定方法　　　　： 簡易査定
■物件種別　　　　： 分譲マンション（区分所有）
■物件名称　　　　： リーフィアレジデンス等々力
■階数（棟物の場合記載）：
■土地面積　　　　：
■建物（専有）面積： 70 平米
■間取り　　　　　： 2LK/2LDK
■物件所在地　　　： 東京都世田谷区等々力2丁目15番12号リーフィアレジデンス等々力303
■築年（西暦）　　： 2013 年
■現況　　　　　　： 居住中
■名義　　　　　　： 本人所有
■フリガナ　　　　： サトウ　ハナコ
■お名前　　　　　： 佐藤　花子
■年齢　　　　　　： 71 歳
■ご住所　　　　　： 東京都世田谷区等々力2丁目15番12号リーフィアレジデンス等々力303号室
■電話番号　　　　： 09012345678
■E-mail　　　　　： hanako@example.jp
■売却の希望時期　： １年以内に売りたい
```

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/paste-import/__tests__/build-draft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPasteDraft } from "../build-draft";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

describe("buildPasteDraft — 実サンプルA（HOME4U 空き家相談）", () => {
  const draft = buildPasteDraft(fixture("home4u-vacant-house.txt"));

  it("送り元を見分ける", () => {
    expect(draft.sourceProfile).toBe("home4u_vacant_house");
  });

  it("★住所と地番を分けて取り出す（この機能の中心）", () => {
    expect(draft.property.address.value).toBe("世田谷区池尻4丁目26-8");
    expect(draft.property.lotNumber.value).toBe("552-2");
  });

  it("どの見出しから来たかを持つ", () => {
    expect(draft.property.address.sourceLabel).toBe("物件所在地");
  });

  it("種別を戸建にする", () => {
    expect(draft.property.propertyType.value).toBe("house");
  });

  it("和暦の築年を西暦にする", () => {
    expect(draft.property.builtYear.value).toBe("1996");
  });

  it("値が「-」の項目は拾わない（空欄のまま）", () => {
    expect(draft.property.layoutType.value).toBeNull();
    expect(draft.property.landArea.value).toBeNull();
  });

  it("所有者の情報が無いので owner は null", () => {
    expect(draft.owner).toBeNull();
  });

  it("一意の番号が無いので externalLinkKey は null", () => {
    expect(draft.externalLinkKey).toBeNull();
  });

  it("辞書に無い見出しは捨てずに備考へまとめる", () => {
    expect(draft.noteFromUnmapped).toContain("建物構造: 木造スレート葺");
    expect(draft.noteFromUnmapped).toContain("私道負担の有無: 私道（地番：552-11、210-10）持ち分あり");
    // 値が "-" のものは備考にも入れない（ノイズになるため）
    expect(draft.noteFromUnmapped).not.toContain("心理的瑕疵事項");
  });

  it("地番があるので地番の警告は出ない", () => {
    expect(draft.warnings.map((w) => w.code)).not.toContain("lot_number_missing");
  });
});

describe("buildPasteDraft — 実サンプルB（HOME4U 査定依頼）", () => {
  const draft = buildPasteDraft(fixture("home4u-assessment.txt"));

  it("送り元を見分ける", () => {
    expect(draft.sourceProfile).toBe("home4u_assessment");
  });

  it("★所在地から建物名と部屋番号を切り出す", () => {
    expect(draft.property.address.value).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(draft.property.buildingName.value).toBe("リーフィアレジデンス等々力");
    expect(draft.property.roomNo.value).toBe("303");
  });

  it("種別・面積・間取り・現況・築年を取り出す", () => {
    expect(draft.property.propertyType.value).toBe("apartment_unit");
    expect(draft.property.exclusiveArea.value).toBe("70");
    expect(draft.property.layoutType.value).toBe("2LK/2LDK");
    expect(draft.property.occupancyStatus.value).toBe("occupied");
    expect(draft.property.builtYear.value).toBe("2013");
  });

  it("★所有者の氏名・カナ・電話・メール・住所を取り出す", () => {
    expect(draft.owner).not.toBeNull();
    expect(draft.owner!.name.value).toBe("佐藤　花子");
    expect(draft.owner!.nameKana.value).toBe("サトウ　ハナコ");
    expect(draft.owner!.phone.value).toBe("09012345678");
    expect(draft.owner!.email.value).toBe("hanako@example.jp");
    expect(draft.owner!.currentAddress.value).toContain("等々力2丁目15番12号");
  });

  it("★査定ナンバーを外部キーにする（二重登録の防止に使う）", () => {
    expect(draft.externalLinkKey).toBe("SA2608-1234567");
  });

  it("★地番が無いので警告を出す", () => {
    const w = draft.warnings.find((x) => x.code === "lot_number_missing");
    expect(w).toBeDefined();
    expect(w!.message).toContain("謄本");
  });

  it("見出しの無い行（挨拶文など）に引きずられない", () => {
    expect(draft.property.address.value).not.toContain("担当者様");
  });
});

describe("buildPasteDraft — 読み取れないとき", () => {
  it("見出しが1つも無ければ警告を出し、欄は全部空", () => {
    const draft = buildPasteDraft("こんにちは\nよろしくお願いします");
    expect(draft.warnings.map((w) => w.code)).toContain("no_labeled_lines");
    expect(draft.property.address.value).toBeNull();
    expect(draft.owner).toBeNull();
  });

  it("住所が取れなければ警告を出す", () => {
    const draft = buildPasteDraft("■物件種別： 土地");
    expect(draft.warnings.map((w) => w.code)).toContain("address_missing");
  });

  it("知らない種別は unknown にして警告を出す", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■物件種別： 宇宙ステーション");
    expect(draft.property.propertyType.value).toBe("unknown");
    expect(draft.warnings.map((w) => w.code)).toContain("property_type_unknown");
  });

  it("氏名だけあって連絡先が無くても owner を作る（氏名が最低条件）", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎");
    expect(draft.owner).not.toBeNull();
    expect(draft.owner!.phone.value).toBeNull();
  });

  it("氏名が無ければ owner は作らない", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■電話番号： 09000000000");
    expect(draft.owner).toBeNull();
  });
});
```

- [ ] **Step 3: 型と組み立てを実装する**

`src/lib/paste-import/types.ts`:

```ts
import type { SourceProfileId } from "./source-profiles";

export type DraftWarningCode =
  | "no_labeled_lines"
  | "lot_number_missing"
  | "property_type_unknown"
  | "address_missing";

export interface DraftWarning {
  code: DraftWarningCode;
  message: string;
}

/** 1つの欄。**どの見出しから来たか**を持つ（確認画面で原文と照らすため）。 */
export interface DraftField {
  value: string | null;
  sourceLabel: string | null;
}

export interface PasteDraft {
  sourceProfile: SourceProfileId;
  sourceProfileLabel: string;
  property: {
    address: DraftField;
    lotNumber: DraftField;
    buildingName: DraftField;
    roomNo: DraftField;
    /** PropertyType の値（land / house / apartment_unit …）。 */
    propertyType: DraftField;
    exclusiveArea: DraftField;
    landArea: DraftField;
    layoutType: DraftField;
    /** OccupancyStatus の値（vacant / occupied / unknown）。 */
    occupancyStatus: DraftField;
    builtYear: DraftField;
  };
  owner: {
    name: DraftField;
    nameKana: DraftField;
    phone: DraftField;
    email: DraftField;
    /** ⚠現住所。登記上住所(address)には入れない（発注者承認 2026-08-26）。 */
    currentAddress: DraftField;
  } | null;
  externalLinkKey: string | null;
  warnings: DraftWarning[];
  unmapped: { label: string; value: string }[];
  /** 備考へそのまま入れる文字列（辞書に無かった見出しをまとめたもの）。 */
  noteFromUnmapped: string;
}
```

`src/lib/paste-import/build-draft.ts`:

```ts
/**
 * 段2〜4を通して下書きを組み立てる。純関数。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { parseLabeledLines, isBlankValue, type LabeledLine } from "./parse-labeled-lines";
import { warekiToSeireki, parseAreaSqm, splitLotNumberFromAddress } from "./normalize";
import { fieldKeyForLabel, type DraftFieldKey } from "./label-dictionary";
import { propertyTypeForRaw } from "./property-type-dictionary";
import {
  detectSourceProfile,
  splitBuildingAndRoom,
  SOURCE_PROFILE_LABELS,
} from "./source-profiles";
import type { DraftField, DraftWarning, PasteDraft } from "./types";

const EMPTY: DraftField = { value: null, sourceLabel: null };
const field = (value: string | null, sourceLabel: string): DraftField =>
  value === null ? EMPTY : { value, sourceLabel };

/** 現況の言い換え → OccupancyStatus。分からなければ null（unknown を推測で入れない）。 */
function occupancyFor(raw: string): string | null {
  const s = raw.replace(/[\s\u3000]/g, "");
  if (s.includes("居住中") || s.includes("入居中") || s.includes("賃貸中")) return "occupied";
  if (s.includes("空室") || s.includes("空家") || s.includes("空き家")) return "vacant";
  return null;
}

export function buildPasteDraft(text: string): PasteDraft {
  const { labeled } = parseLabeledLines(text);
  const warnings: DraftWarning[] = [];

  // 見出しごとの最初の値だけを採る（同じ見出しが2回出たら先勝ち）。
  const picked = new Map<DraftFieldKey, LabeledLine>();
  const unmapped: { label: string; value: string }[] = [];

  for (const line of labeled) {
    if (isBlankValue(line.value)) continue; // 値なしは拾わない
    const key = fieldKeyForLabel(line.label);
    if (key === null) {
      unmapped.push({ label: line.label, value: line.value });
      continue;
    }
    if (!picked.has(key)) picked.set(key, line);
  }

  if (labeled.length === 0) {
    warnings.push({
      code: "no_labeled_lines",
      message:
        "読み取れる項目がありませんでした。「項目名：値」の形で書かれた文章を貼り付けてください。",
    });
  }

  const sourceProfile = detectSourceProfile(labeled.map((l) => l.label));

  const raw = (key: DraftFieldKey): string | null => picked.get(key)?.value ?? null;
  const label = (key: DraftFieldKey): string => picked.get(key)?.label ?? "";

  // ---- 住所・地番・建物名・部屋番号 ----
  const addressRaw = raw("address");
  const buildingName = raw("buildingName");
  let address: string | null = null;
  let lotNumber: string | null = raw("lotNumber");
  let roomNo: string | null = null;

  if (addressRaw !== null) {
    const split = splitLotNumberFromAddress(addressRaw);
    address = split.address;
    if (lotNumber === null) lotNumber = split.lotNumber;
    const room = splitBuildingAndRoom(address, buildingName);
    address = room.address;
    roomNo = room.roomNo;
  }

  if (address === null) {
    warnings.push({
      code: "address_missing",
      message: "住所を読み取れませんでした。手で入力してください。",
    });
  }
  if (lotNumber === null) {
    warnings.push({
      code: "lot_number_missing",
      message:
        "地番がありません。このままでは謄本を取得できません。地番検索サービスで調べて入力してください。",
    });
  }

  // ---- 物件種別 ----
  const typeRaw = raw("propertyTypeRaw");
  const mappedType = typeRaw === null ? null : propertyTypeForRaw(typeRaw);
  if (mappedType !== null && !mappedType.confident) {
    warnings.push({
      code: "property_type_unknown",
      message: `物件種別「${typeRaw}」を判別できませんでした。選び直してください。`,
    });
  }

  // ---- 所有者（氏名があるときだけ作る） ----
  const ownerName = raw("ownerName");
  const owner = ownerName === null
    ? null
    : {
        name: field(ownerName, label("ownerName")),
        nameKana: field(raw("ownerNameKana"), label("ownerNameKana")),
        phone: field(raw("ownerPhone"), label("ownerPhone")),
        email: field(raw("ownerEmail"), label("ownerEmail")),
        currentAddress: field(raw("ownerAddress"), label("ownerAddress")),
      };

  const builtYearRaw = raw("builtYearRaw");
  const builtYear = builtYearRaw === null ? null : warekiToSeireki(builtYearRaw);
  const areaRaw = raw("exclusiveArea");
  const area = areaRaw === null ? null : parseAreaSqm(areaRaw);
  const landAreaRaw = raw("landArea");
  const landArea = landAreaRaw === null ? null : parseAreaSqm(landAreaRaw);
  const occRaw = raw("occupancyRaw");

  return {
    sourceProfile,
    sourceProfileLabel: SOURCE_PROFILE_LABELS[sourceProfile],
    property: {
      address: field(address, label("address")),
      lotNumber: field(lotNumber, label("lotNumber") || label("address")),
      buildingName: field(buildingName, label("buildingName")),
      roomNo: field(roomNo, label("address")),
      propertyType: field(mappedType?.value ?? null, label("propertyTypeRaw")),
      exclusiveArea: field(area === null ? null : String(area), label("exclusiveArea")),
      landArea: field(landArea === null ? null : String(landArea), label("landArea")),
      layoutType: field(raw("layoutType"), label("layoutType")),
      occupancyStatus: field(
        occRaw === null ? null : occupancyFor(occRaw),
        label("occupancyRaw"),
      ),
      builtYear: field(builtYear === null ? null : String(builtYear), label("builtYearRaw")),
    },
    owner,
    externalLinkKey: raw("externalLinkKey"),
    warnings,
    unmapped,
    noteFromUnmapped: unmapped.map((u) => `${u.label}: ${u.value}`).join("\n"),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/`
Expected: PASS（Task 1〜5 の全テスト）

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 6: コミット**

```bash
git add src/lib/paste-import/types.ts src/lib/paste-import/build-draft.ts src/lib/paste-import/__tests__/
git commit -m "feat(paste-import): 下書きの組み立てと、実サンプル2件での通し確認

いただいた実物2件（HOME4U 空き家相談PDF / 査定依頼ページ）を見本として固定。
⚠氏名・カナ・電話・メール・査定ナンバーは架空値に差し替え、書式（■・全角
コロン・全角空白・桁数）は実物どおりにした。

拾えた欄には「どの見出しから来たか」を持たせる（確認画面で原文と照らすため）。
値が「-」の項目は拾わず、備考にも入れない。辞書に無い見出しは捨てずに備考へ。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 6: 重複判定の純関数

**Files:**
- Create: `src/lib/paste-import/find-duplicates.ts`
- Test: `src/lib/paste-import/__tests__/find-duplicates.test.ts`

**Interfaces:**
- Consumes: なし（DB 検索の**結果**を受け取る形にして純関数を保つ）
- Produces:
  ```ts
  export interface ExistingProperty { id: string; address: string | null; lotNumber: string | null; externalLinkKey: string | null }
  export interface DuplicateVerdict {
    blocked: boolean;
    blockedByPropertyId: string | null;
    similarPropertyIds: string[];
  }
  export function judgeDuplicates(
    draft: { address: string | null; lotNumber: string | null; externalLinkKey: string | null },
    existing: readonly ExistingProperty[],
  ): DuplicateVerdict
  export function normalizeForCompare(s: string | null): string
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/paste-import/__tests__/find-duplicates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { judgeDuplicates, normalizeForCompare } from "../find-duplicates";

const P = (
  id: string,
  address: string | null,
  lotNumber: string | null,
  externalLinkKey: string | null = null,
) => ({ id, address, lotNumber, externalLinkKey });

describe("judgeDuplicates（二重登録の判定）", () => {
  it("★外部キーが一致したら登録を止める", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA2608-1234567" },
      [P("p1", "別の住所", null, "SA2608-1234567")],
    );
    expect(v.blocked).toBe(true);
    expect(v.blockedByPropertyId).toBe("p1");
  });

  it("外部キーが違えば止めない", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA-AAA" },
      [P("p1", "東京都A区B1-2-3", null, "SA-BBB")],
    );
    expect(v.blocked).toBe(false);
  });

  it("★住所+地番が一致したら警告するが止めない", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "552-2", externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", "552-2")],
    );
    expect(v.blocked).toBe(false);
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("⚠地番が両方とも無いときは住所だけで似ているとみなす", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("⚠片方だけ地番があるときは似ているとみなさない（別の筆の可能性）", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "552-2", externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual([]);
  });

  it("全角半角・空白・ハイフンのゆれを吸収して比べる", () => {
    const v = judgeDuplicates(
      { address: "東京都Ａ区Ｂ１－２－３", lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B 1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("住所が無ければ何とも比べない", () => {
    const v = judgeDuplicates(
      { address: null, lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.blocked).toBe(false);
    expect(v.similarPropertyIds).toEqual([]);
  });

  it("外部キーの一致と住所の一致が両方あっても、止める理由は外部キー", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA-1" },
      [P("p1", "東京都A区B1-2-3", null, "SA-1")],
    );
    expect(v.blocked).toBe(true);
    expect(v.blockedByPropertyId).toBe("p1");
  });
});

describe("normalizeForCompare", () => {
  it("空白・全角半角・ハイフン類を均す", () => {
    expect(normalizeForCompare("東京都Ａ区　Ｂ１－２－３")).toBe(
      normalizeForCompare("東京都A区B1-2-3"),
    );
  });
  it("null は空文字", () => {
    expect(normalizeForCompare(null)).toBe("");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/find-duplicates.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/lib/paste-import/find-duplicates.ts`:

```ts
/**
 * 二重登録の判定。**純関数**（DB 検索の結果を受け取るだけ）。
 *
 * 方針（設計書 §6）: 外部キーが一致したときだけ登録を止める。それ以外は
 * 警告を出すだけで止めない。住所が似ていても別物件のことがあり、人が判断できるため。
 */
import { toHalfWidth } from "./normalize";

export interface ExistingProperty {
  id: string;
  address: string | null;
  lotNumber: string | null;
  externalLinkKey: string | null;
}

export interface DuplicateVerdict {
  blocked: boolean;
  blockedByPropertyId: string | null;
  similarPropertyIds: string[];
}

export function normalizeForCompare(s: string | null): string {
  if (s === null) return "";
  return toHalfWidth(s).replace(/[\s\u3000]/g, "").replace(/[-]+/g, "-");
}

export function judgeDuplicates(
  draft: {
    address: string | null;
    lotNumber: string | null;
    externalLinkKey: string | null;
  },
  existing: readonly ExistingProperty[],
): DuplicateVerdict {
  // ① 外部キー完全一致 → 止める
  if (draft.externalLinkKey !== null && draft.externalLinkKey.trim() !== "") {
    const key = normalizeForCompare(draft.externalLinkKey);
    const hit = existing.find((e) => normalizeForCompare(e.externalLinkKey) === key);
    if (hit) {
      return { blocked: true, blockedByPropertyId: hit.id, similarPropertyIds: [] };
    }
  }

  // ② 住所（+地番）一致 → 警告のみ
  const addr = normalizeForCompare(draft.address);
  if (addr === "") {
    return { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] };
  }
  const lot = normalizeForCompare(draft.lotNumber);

  const similar = existing
    .filter((e) => normalizeForCompare(e.address) === addr)
    .filter((e) => {
      const eLot = normalizeForCompare(e.lotNumber);
      // ⚠片方だけ地番があるときは「似ている」と言わない。同じ住所でも
      //   別の筆であることがあり、誤って同一視すると取り違えを招く。
      if (lot === "" && eLot === "") return true;
      return lot !== "" && lot === eLot;
    })
    .map((e) => e.id);

  return { blocked: false, blockedByPropertyId: null, similarPropertyIds: similar };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/paste-import/__tests__/find-duplicates.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/paste-import/find-duplicates.ts src/lib/paste-import/__tests__/find-duplicates.test.ts
git commit -m "feat(paste-import): 二重登録の判定（純関数）

外部キーが一致したときだけ登録を止める。住所一致は警告のみで止めない
（似ていても別物件のことがあり、人が判断できるため）。
⚠片方だけ地番があるときは似ているとみなさない。同じ住所でも別の筆で
あることがあり、誤って同一視すると取り違えを招く。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 7: 下書きを返す API

**Files:**
- Create: `src/app/api/import/paste/route.ts`
- Test: `src/app/api/import/paste/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `buildPasteDraft`（Task 5）/ `judgeDuplicates` `ExistingProperty`（Task 6）/ 既存 `extractTextFromPdf` `isPdfBuffer`（`@/lib/pdf-extract`）/ 既存 `getApiSession` `getUserPermissions` `ApiError` `handleApiError` `apiResponse`（`@/lib/api-helpers`）/ 既存 `hasPermission`（`@/lib/permissions`）
- Produces: `POST /api/import/paste` → `{ draft: PasteDraft, duplicates: DuplicateVerdict, similar: {id,address,lotNumber}[] }`

**参照すべき既存コード:** `src/app/api/import/registry-pdf/route.ts`（multipart と JSON の двух受け口・権限チェック・`assertImportJsonBodySize` の使い方）

- [ ] **Step 1: 失敗するテストを書く**

`src/app/api/import/paste/__tests__/route.test.ts`:

```ts
/**
 * 貼り付け取込 API の契約テスト。
 * vitest は env=node のため、route を直接 import して NextRequest を渡す。
 * 認証・Prisma は vi.mock で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
let mockPerms: unknown = [{ resource: "property", action: "write" }];
const mockFindMany = vi.fn();

vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => mockSession),
    getUserPermissions: vi.fn(async () => mockPerms),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { property: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

const jsonReq = (body: unknown) =>
  new NextRequest("http://localhost/api/import/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockPerms = [{ resource: "property", action: "write" }];
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
});

describe("POST /api/import/paste", () => {
  it("貼り付けたテキストから下書きを返す", async () => {
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番552-2）" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.property.address.value).toBe("東京都A区B1-2-3");
    expect(body.draft.property.lotNumber.value).toBe("552-2");
  });

  it("★権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    expect(res.status).toBe(403);
  });

  it("★文字数の上限を超えたら400（無言で切り詰めない）", async () => {
    const res = await POST(jsonReq({ text: "あ".repeat(200_001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("長すぎ");
  });

  it("text が空なら400", async () => {
    const res = await POST(jsonReq({ text: "   " }));
    expect(res.status).toBe(400);
  });

  it("★同じ外部キーの物件があれば blocked で返す", async () => {
    mockFindMany.mockResolvedValue([
      { id: "p1", address: "別", lotNumber: null, externalLinkKey: "SA-1" },
    ]);
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p1");
  });

  it("★下書きに貼った原文をそのまま含めない（PII を返しっぱなしにしない）", async () => {
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■電話番号： 09012345678\n■お名前： 山田太郎" }),
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("rawText");
    // 所有者の欄には入るが、原文そのものは返さない
    expect(body.draft.owner.phone.value).toBe("09012345678");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/app/api/import/paste/__tests__/route.test.ts`
Expected: FAIL（`Cannot find module '../route'`）

- [ ] **Step 3: 実装を書く**

`src/app/api/import/paste/route.ts`:

```ts
import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import {
  judgeDuplicates,
  normalizeForCompare,
  type ExistingProperty,
} from "@/lib/paste-import/find-duplicates";

/** 貼り付けの上限。実サンプルは334文字と約900文字なので3桁の余裕がある。 */
const MAX_CHARS = 200_000;
/** PDF の上限（10MB）。 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ApiError(400, "PDFファイルが見つかりません", "BAD_REQUEST");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new ApiError(400, "PDFが大きすぎます（10MBまで）", "BAD_REQUEST");
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
      }
      text = await extractTextFromPdf(buffer);
      if (text.trim() === "") {
        // ⚠無言で空の下書きを返さない。スキャン画像の PDF はここに来る。
        throw new ApiError(
          400,
          "このPDFには文字が入っていません（画像として保存されたPDFの可能性があります）。画面をコピーして貼り付けてください。",
          "BAD_REQUEST",
        );
      }
    } else {
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string") {
        throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
      }
      text = body.text;
    }

    if (text.length > MAX_CHARS) {
      throw new ApiError(
        400,
        `貼り付けた文章が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`,
        "BAD_REQUEST",
      );
    }
    if (text.trim() === "") {
      throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
    }

    const draft = buildPasteDraft(text);

    // 重複の手がかり: 外部キーか、正規化前の住所で粗く引いてから純関数で判定する。
    const candidates: ExistingProperty[] = [];
    const or: Record<string, unknown>[] = [];
    if (draft.externalLinkKey) or.push({ externalLinkKey: draft.externalLinkKey });
    if (draft.property.address.value) {
      or.push({ address: { contains: draft.property.address.value.slice(0, 20) } });
    }
    if (or.length > 0) {
      const rows = await prisma.property.findMany({
        where: { OR: or, isArchived: false },
        select: { id: true, address: true, lotNumber: true, externalLinkKey: true },
        take: 50,
      });
      candidates.push(...rows);
    }

    const duplicates = judgeDuplicates(
      {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
      },
      candidates,
    );

    const similar = candidates
      .filter((c) => duplicates.similarPropertyIds.includes(c.id))
      .map((c) => ({ id: c.id, address: c.address, lotNumber: c.lotNumber }));

    const blocked = candidates.find((c) => c.id === duplicates.blockedByPropertyId) ?? null;

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。
    return apiResponse({
      draft,
      duplicates,
      similar,
      blockedProperty: blocked
        ? { id: blocked.id, address: blocked.address, lotNumber: blocked.lotNumber }
        : null,
      _normalizedAddress: normalizeForCompare(draft.property.address.value),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/app/api/import/paste/__tests__/route.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/app/api/import/paste/
git commit -m "feat(paste-import): 下書きを返す API

PDF(multipart) とテキスト(JSON) の両方を受ける。文字数の上限を超えたら
無言で切り詰めず400で断る。⚠スキャン画像のPDFは「文字が入っていません」と
理由を伝える（無言で空の下書きを返さない）。
貼った原文はレスポンスに含めない（往復させるとログと履歴にPIIが増えるだけ）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 8: 確定して物件・所有者・添付を作る API

**Files:**
- Create: `src/app/api/import/paste/commit/route.ts`
- Test: `src/app/api/import/paste/commit/__tests__/route.test.ts`

**Interfaces:**
- Consumes: 既存 `prisma`・`writeAuditLog`（`@/lib/audit`）・`buildOwnerDedupKey`（`@/lib/owner-dedup`）
- Produces: `POST /api/import/paste/commit` → `{ propertyId: string, ownerId: string | null }`

**⚠ この Task の要点（リポジトリの規約）**
- **物件・所有者・紐付け・添付を1つのトランザクションで作る。**
- **添付は親の物件行を `FOR UPDATE` した同一tx内で作る。** リポジトリ全体の走査テストで
  固定されており、ロック無しで添付を作ると名指しで落ちる。既存の作り方は
  `src/app/api/import/registry-pdf/route.ts` の Attachment 作成箇所を読んで合わせること。
- **監査ログに貼った原文・氏名・電話・メールを入れない。** 出してよいのは
  固定文字列と件数・propertyId のみ。

- [ ] **Step 1: 失敗するテストを書く**

`src/app/api/import/paste/commit/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
let mockPerms: unknown = [
  { resource: "property", action: "write" },
  { resource: "owner", action: "write" },
];
const created: Record<string, unknown[]> = {};
const auditCalls: unknown[] = [];

vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => mockSession),
    getUserPermissions: vi.fn(async () => mockPerms),
  };
});
vi.mock("@/lib/audit", () => ({
  writeAuditLog: vi.fn(async (input: unknown) => { auditCalls.push(input); }),
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    property: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.property ??= []).push(data);
        return { id: "new-prop", ...(data as object) };
      }),
      findUnique: vi.fn(async () => ({ id: "new-prop" })),
    },
    owner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.owner ??= []).push(data);
        return { id: "new-owner", ...(data as object) };
      }),
      findFirst: vi.fn(async () => null),
    },
    propertyOwner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.propertyOwner ??= []).push(data);
        return { id: "po-1" };
      }),
    },
    $queryRaw: vi.fn(async () => [{ id: "new-prop" }]),
  };
  return { prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)), ...tx } };
});

import { POST } from "../route";
import { NextRequest } from "next/server";

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/import/paste/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const baseBody = {
  property: {
    address: "東京都A区B1-2-3",
    lotNumber: "552-2",
    propertyType: "house",
    buildingName: null, roomNo: null, exclusiveArea: null,
    layoutType: null, occupancyStatus: null, note: "建物構造: 木造",
  },
  owner: null,
  externalLinkKey: null,
};

beforeEach(() => {
  mockPerms = [
    { resource: "property", action: "write" },
    { resource: "owner", action: "write" },
  ];
  for (const k of Object.keys(created)) delete created[k];
  auditCalls.length = 0;
});

describe("POST /api/import/paste/commit", () => {
  it("物件を作って id を返す", async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.propertyId).toBe("new-prop");
    expect(created.property?.[0]).toMatchObject({
      address: "東京都A区B1-2-3",
      lotNumber: "552-2",
      propertyType: "house",
      introductionRoute: "web_inquiry",
      caseStatus: "new_case",
      createdBy: "user-1",
    });
  });

  it("★所有者の住所は currentAddress に入れる（登記上住所には入れない）", async () => {
    await POST(req({
      ...baseBody,
      owner: {
        name: "山田太郎", nameKana: "ヤマダタロウ",
        phone: "09000000000", email: "a@example.jp",
        currentAddress: "東京都A区B1-2-3",
      },
    }));
    expect(created.owner?.[0]).toMatchObject({
      name: "山田太郎",
      currentAddress: "東京都A区B1-2-3",
    });
    expect(created.owner?.[0]).not.toHaveProperty("address");
  });

  it("★物件の権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(req(baseBody));
    expect(res.status).toBe(403);
  });

  it("★所有者を作るのに owner:write が無ければ403", async () => {
    mockPerms = [{ resource: "property", action: "write" }];
    const res = await POST(req({ ...baseBody, owner: { name: "山田太郎" } }));
    expect(res.status).toBe(403);
  });

  it("住所が無ければ400", async () => {
    const res = await POST(req({ ...baseBody, property: { ...baseBody.property, address: "" } }));
    expect(res.status).toBe(400);
  });

  it("★監査ログに氏名・電話・メール・住所を入れない", async () => {
    await POST(req({
      ...baseBody,
      owner: { name: "山田太郎", phone: "09000000000", email: "a@example.jp",
               currentAddress: "東京都A区B1-2-3", nameKana: null },
    }));
    const dumped = JSON.stringify(auditCalls);
    expect(dumped).not.toContain("山田太郎");
    expect(dumped).not.toContain("09000000000");
    expect(dumped).not.toContain("a@example.jp");
    expect(dumped).not.toContain("東京都A区B1-2-3");
    expect(dumped).toContain("new-prop");
  });

  it("★1つのトランザクションで作る", async () => {
    const { prisma } = await import("@/lib/prisma");
    await POST(req(baseBody));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/app/api/import/paste/commit/__tests__/route.test.ts`
Expected: FAIL（`Cannot find module '../route'`）

- [ ] **Step 3: 実装を書く**

`src/app/api/import/paste/commit/route.ts`:

```ts
import { NextRequest } from "next/server";
import {
  getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";

interface CommitBody {
  property: {
    address: string;
    lotNumber: string | null;
    propertyType: string;
    buildingName: string | null;
    roomNo: string | null;
    exclusiveArea: string | null;
    layoutType: string | null;
    occupancyStatus: string | null;
    note: string | null;
  };
  owner: {
    name: string;
    nameKana: string | null;
    phone: string | null;
    email: string | null;
    currentAddress: string | null;
  } | null;
  externalLinkKey: string | null;
  /** 既存の所有者に紐付ける場合。指定があれば新規作成しない。 */
  linkExistingOwnerId?: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const body = (await request.json()) as CommitBody;
    if (!body?.property?.address || body.property.address.trim() === "") {
      throw new ApiError(400, "住所がありません", "BAD_REQUEST");
    }
    const wantsOwner = Boolean(body.owner?.name || body.linkExistingOwnerId);
    if (wantsOwner && !hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者を作る権限がありません", "FORBIDDEN");
    }

    const p = body.property;
    const result = await prisma.$transaction(async (tx) => {
      const property = await tx.property.create({
        data: {
          address: p.address.trim(),
          lotNumber: p.lotNumber?.trim() || null,
          buildingName: p.buildingName?.trim() || null,
          roomNo: p.roomNo?.trim() || null,
          propertyType: (p.propertyType || "unknown") as never,
          exclusiveArea: p.exclusiveArea ? p.exclusiveArea : null,
          layoutType: p.layoutType?.trim() || null,
          occupancyStatus: (p.occupancyStatus || null) as never,
          externalLinkKey: body.externalLinkKey?.trim() || null,
          note: p.note?.trim() || null,
          introductionRoute: "web_inquiry",
          caseStatus: "new_case",
          registryStatus: "unconfirmed",
          dmStatus: "hold",
          createdBy: session.id,
        },
      });

      let ownerId: string | null = body.linkExistingOwnerId ?? null;
      if (ownerId === null && body.owner?.name) {
        const owner = await tx.owner.create({
          data: {
            name: body.owner.name.trim(),
            nameKana: body.owner.nameKana?.trim() || null,
            phone: body.owner.phone?.trim() || null,
            email: body.owner.email?.trim() || null,
            // ⚠反響フォームの住所は本人の連絡先住所であり、登記上の住所とは
            //   限らない。address（登記上住所）は空のままにする（設計書 §7）。
            currentAddress: body.owner.currentAddress?.trim() || null,
          },
        });
        ownerId = owner.id;
      }

      if (ownerId !== null) {
        await tx.propertyOwner.create({
          data: { propertyId: property.id, ownerId },
        });
      }

      return { propertyId: property.id, ownerId };
    });

    // ⚠監査ログに原文・氏名・電話・メール・住所を入れない。
    //   出してよいのは固定文字列と id・件数のみ。
    await writeAuditLog({
      userId: session.id,
      action: "paste_import_property_create",
      targetType: "property",
      targetId: result.propertyId,
      detail: {
        ownerCreated: result.ownerId !== null,
        hasExternalKey: Boolean(body.externalLinkKey),
      },
    } as never);

    return apiResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 添付の作成を既存の作法に合わせて足す**

`src/app/api/import/registry-pdf/route.ts` の Attachment 作成箇所を読み、
**親の物件行を `FOR UPDATE` した同一tx内で作る**形にそろえて、PDF を投入した場合の
添付作成を上記トランザクションの中に加える。走査テストの名前と要求は
`npx vitest run -t "FOR UPDATE"` で確認できる。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/app/api/import/paste/`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/app/api/import/paste/commit/
git commit -m "feat(paste-import): 確定して物件・所有者・添付を作る API

物件・所有者・紐付け・添付を1つのトランザクションで作る。添付は親の物件行を
FOR UPDATE した同一tx内で作る（リポジトリ全体の走査テストで固定されている規約）。
⚠所有者の住所は currentAddress へ。address（登記上住所）は空のままにする。
⚠監査ログに氏名・電話・メール・住所・貼った原文を入れない（テストで固定）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 9: 画面（貼り付け欄と確認画面）

**Files:**
- Create: `src/components/import/paste-import-review.tsx`
- Create: `src/app/(dashboard)/import/paste/page.tsx`
- Test: `src/components/import/__tests__/paste-import-review.test.tsx`

**Interfaces:**
- Consumes: `PasteDraft` `DraftField`（Task 5 の `types.ts`）/ 既存 `PageHeader`（`@/components/ui/page-header`）/ 既存 `Button`（`@/components/ui/button`）/ 既存 `ImportSwitcher`
- Produces: `export function PasteImportReview(props: { draft: PasteDraft; ... }): JSX.Element`

**⚠ 画面の要件（設計書 §5・確認画面の見本 Artifact に対応）**
1. 左に貼った原文、右に読み取り結果（狭いときは縦に並ぶ）
2. **3つの状態を区別**: 拾えた／元資料に無い（空欄+「元の資料に記載がありません」）／要確認
3. 拾えた欄には**どの見出しから来たか**を小さく添える
4. 警告は欄の上に帯で出す
5. **題名は `PageHeader` で描き、サイドバーの項目名と一字一句同じにする**
   （`src/components/layout/__tests__/sidebar-page-title-parity.test.ts` が名指しで落とす）

- [ ] **Step 1: 失敗するテストを書く**

`src/components/import/__tests__/paste-import-review.test.tsx`:

```tsx
/**
 * vitest は env=node（jsdom なし）なので renderToStaticMarkup + 文字列 assert で検証する。
 * クリックや state 遷移はここでは見られない（リポジトリの既定の作法）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PasteImportReview } from "../paste-import-review";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";

const draft = buildPasteDraft(
  "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3グリーンコート303\n" +
  "■物件名称： グリーンコート\n■お名前： 山田太郎",
);

const html = renderToStaticMarkup(
  createElement(PasteImportReview, { draft, rawText: "■物件所在地： 東京都A区B1-2-3" }),
);

describe("PasteImportReview（確認画面）", () => {
  it("拾えた値を表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
    expect(html).toContain("303");
  });

  it("★どの見出しから来たかを添える", () => {
    expect(html).toContain("物件所在地");
  });

  it("★元資料に無い欄は「元の資料に記載がありません」と出す", () => {
    expect(html).toContain("元の資料に記載がありません");
  });

  it("★地番が無いので謄本が取れない旨の警告を出す", () => {
    expect(html).toContain("地番がありません");
    expect(html).toContain("謄本");
  });

  it("貼った原文を並べて表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
  });

  it("送り元の名前を出す", () => {
    expect(html).toContain("HOME4U 査定依頼");
  });

  it("★推測で埋めた形跡がない（空欄の欄に値が入っていない）", () => {
    // 土地面積は元資料に無い → 数字が入っていないこと
    expect(html).not.toContain('data-field="landArea" data-value="');
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/components/import/__tests__/paste-import-review.test.tsx`
Expected: FAIL（`Cannot find module '../paste-import-review'`）

- [ ] **Step 3: 確認画面の部品を作る**

`src/components/import/paste-import-review.tsx` に、上の要件1〜4を満たす表示専用部品を
作る。値の編集は `page.tsx` 側が state を持ち、この部品は `onChange` を受け取る。

実装の骨格:

```tsx
"use client";

import type { PasteDraft, DraftField } from "@/lib/paste-import/types";

const FIELD_LABELS: { key: keyof PasteDraft["property"]; label: string }[] = [
  { key: "address", label: "住所" },
  { key: "lotNumber", label: "地番" },
  { key: "buildingName", label: "建物名" },
  { key: "roomNo", label: "部屋番号" },
  { key: "propertyType", label: "種別" },
  { key: "exclusiveArea", label: "専有面積" },
  { key: "landArea", label: "土地面積" },
  { key: "layoutType", label: "間取り" },
  { key: "occupancyStatus", label: "現況" },
  { key: "builtYear", label: "築年" },
];

function FieldRow({ label, field }: { label: string; field: DraftField }) {
  const missing = field.value === null;
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-dashed border-gray-200 py-2 dark:border-gray-700">
      <div className="pt-2 text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div>
        <div
          className={
            missing
              ? "rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
              : "rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-500/10"
          }
        >
          {missing ? "元の資料に記載がありません" : field.value}
        </div>
        {!missing && field.sourceLabel && (
          <span className="mt-0.5 block text-[10px] text-gray-400">
            {field.sourceLabel} から
          </span>
        )}
      </div>
    </div>
  );
}

export function PasteImportReview({
  draft,
  rawText,
}: {
  draft: PasteDraft;
  rawText: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500">貼った原文</h2>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-800">
          {rawText}
        </pre>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500">
          読み取り結果（{draft.sourceProfileLabel}）
        </h2>

        {draft.warnings.map((w) => (
          <div
            key={w.code}
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {w.message}
          </div>
        ))}

        {FIELD_LABELS.map((f) => (
          <FieldRow key={f.key} label={f.label} field={draft.property[f.key]} />
        ))}

        {draft.owner && (
          <FieldRow
            label="所有者"
            field={{
              value: [draft.owner.name.value, draft.owner.phone.value]
                .filter(Boolean)
                .join(" / ") || null,
              sourceLabel: draft.owner.name.sourceLabel,
            }}
          />
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: 画面本体を作る**

`src/app/(dashboard)/import/paste/page.tsx`:
- `ImportSwitcher` → `PageHeader title="貼り付けて物件化"` の順（他の取込画面と同じ並び）
- 貼り付け用の `<textarea>` と PDF 用の `<input type="file" accept="application/pdf">`
- 「読み取る」で `POST /api/import/paste` → 下書きを state に持つ
- `PasteImportReview` を表示し、各欄を編集できるようにする
- 「この内容で登録」で `POST /api/import/paste/commit` → 成功したら物件ページへ
- `duplicates.blocked` のときは登録ボタンを無効にし、既存物件へのリンクを出す

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/components/import/__tests__/paste-import-review.test.tsx`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/components/import/paste-import-review.tsx src/app/\(dashboard\)/import/paste/ src/components/import/__tests__/paste-import-review.test.tsx
git commit -m "feat(paste-import): 貼り付け欄と確認画面

左に貼った原文、右に読み取り結果。3つの状態（拾えた／元資料に無い／要確認）を
見た目で区別し、拾えた欄にはどの見出しから来たかを添える。
⚠拾えなかった欄は空欄のまま「元の資料に記載がありません」と出す。推測で埋めない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

---

### Task 10: 導線（取込タブとサイドバー）と全ゲート

**Files:**
- Modify: `src/components/import/import-switcher.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`
- Modify: `src/app/(dashboard)/help/page.tsx`（使い方の記載があれば1行追加）
- Modify: `public/docs/guide.html` / `public/docs/manual.html`

**Interfaces:**
- Consumes: Task 9 の画面（`/import/paste`）
- Produces: なし（最終タスク）

**⚠ 既存の走査テストが名指しで落とす点**
`src/components/layout/__tests__/sidebar-page-title-parity.test.ts` は、
**サイドバーの項目名 = ページの `PageHeader` の題名 = パンくずの現在地**
を一字一句そろえることを要求する。項目名を「貼り付けて物件化」にするなら、
Task 9 の `PageHeader title` も**同じ文字列**でなければ落ちる。

- [ ] **Step 1: 走査テストが落ちることを確認（サイドバーだけ先に足す）**

`src/components/layout/sidebar-model.tsx` の `imp`（物件データ取り込み）グループに追加:

```tsx
      // 社外から届いたメール・PDF・ブラウザ画面を貼って物件にする（2026-08 新設）。
      { label: "貼り付けて物件化", href: "/import/paste", icon: ic(ClipboardPaste), minRole: "office_staff" },
```

`ClipboardPaste` を `lucide-react` の import に足す。

Run: `npx vitest run src/components/layout/__tests__/sidebar-page-title-parity.test.ts`
Expected: `/import/paste の題名が「貼り付けて物件化」である` が **PASS**
（Task 9 で `PageHeader title="貼り付けて物件化"` を入れてあるため）。
落ちる場合は題名の文字列が一致していないので、そろえる。

- [ ] **Step 2: 取込タブに足す**

`src/components/import/import-switcher.tsx` の `ITEMS` に追加:

```tsx
  { href: "/import/paste", label: "貼り付けて物件化", icon: ClipboardPaste },
```

- [ ] **Step 3: 社内資料を更新する**

`public/docs/guide.html` と `public/docs/manual.html` の取込の説明に、
**「貼り付けて物件化」で社外から届いたメール・PDF・ブラウザ画面から物件を作れる**旨を
1〜2行で足す。機能が進むたび資料も更新するのがこのリポジトリの運用。

- [ ] **Step 4: 全ゲートを通す**

```bash
npx tsc --noEmit
npx vitest run
npx eslint src/lib/paste-import src/app/api/import/paste src/components/import/paste-import-review.tsx "src/app/(dashboard)/import/paste/page.tsx"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
```

Expected:
- tsc = エラー0
- vitest = **フルスイート緑**（対象限定で「緑」と言わない）
- eslint = 新規の指摘0（既存の警告は `git stash` でベースライン比較して自分の差分か判別する）
- build = 成功し、route 一覧に `/import/paste` と `/api/import/paste` が載る

- [ ] **Step 5: コミット**

```bash
git add src/components/import/import-switcher.tsx src/components/layout/sidebar-model.tsx public/docs/
git commit -m "feat(paste-import): 導線（取込タブとサイドバー）と社内資料の更新

サイドバーの項目名・ページの題名・取込タブの名前をすべて「貼り付けて物件化」で
そろえる（sidebar-page-title-parity の走査テストが名指しで落とすため）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XU3wJGZEpmiLA8ZUGtjxx4"
```

- [ ] **Step 6: 提出前の内部レビュー**

`git add -A` のうえで差分を読み直し、次の観点を自分で点検する（@codex に小出しに
指摘される前に潰す）:

- 認可: 両 API で `property:write`、所有者を作るとき `owner:write` を要求しているか
- PII: 監査ログ・エラーメッセージ・レスポンスに氏名/電話/メール/原文が漏れていないか
- 原子性: 物件・所有者・紐付け・添付が同一tx、添付は親行 `FOR UPDATE` の中か
- 純関数: `src/lib/paste-import/` が Prisma/next/node:fs を import していないか
  （`grep -rn "from \"@/lib/prisma\"\|next/server\|node:fs" src/lib/paste-import/` が空であること）
- 走査テスト: サイドバー名 = 題名 = タブ名 が一致しているか

- [ ] **Step 7: PR を出して @codex レビューを依頼**

```bash
git push -u origin feat/paste-to-property
gh pr create --title "feat(paste-import): 貼り付けて物件化（第1弾）" --body "<平易な日本語で Summary/実装/テスト/セキュリティ>"
gh pr comment <PR番号> --body "@codex review"
```

⚠ PR を作ったら**専用の Monitor ツールでレビュー到着を監視する**（Bash の裏実行で
無限ループを回すのは禁止。通知が飛ばないため）。マージは常にユーザー。

---

## Self-Review（この計画を書いたあとの点検結果）

**1. 設計書の網羅** — 設計書の各節に対応するタスク:

| 設計書 | タスク |
|---|---|
| §4.2 段2 | Task 1 |
| §4.4 共通の後処理 | Task 2 |
| §4.3 段3 辞書 | Task 3 |
| §4.4 送り元プロファイル | Task 4 |
| §4.5 下書き / §3 実サンプル | Task 5 |
| §6 二重登録 | Task 6（判定）+ Task 7（DB 検索と組み込み） |
| §5 確認画面 | Task 9 |
| §7 登録時に書き込むもの | Task 8 |
| §8 権限 | Task 7・Task 8 |
| §9 誤りへの備え | Task 7（PDF 無文字・上限）+ Task 5（種別不明・見出しゼロ） |
| §10 テスト方針 | 全タスク + Task 10 Step 4 |
| §11 変更ファイル | File Structure と一致 |

**2. 抜けていた要件を追加済み** — 設計書 §7 の「備考へ辞書に無かったラベルを入れる」は
Task 5 の `noteFromUnmapped` と Task 8 の `note` で実装される。設計書 §5.4 の
「所有者を作らない選択」は Task 9 の画面 state と Task 8 の `owner: null` で満たす。

**3. 型の一貫性** — `DraftField` / `PasteDraft` / `DraftFieldKey` / `SourceProfileId` /
`ExistingProperty` / `DuplicateVerdict` は Task 5・3・4・6 で定義し、以降のタスクは
その名前のまま使う。`propertyTypeForRaw` の戻り値 `{ value, confident }` は Task 3 で
定義し Task 5 で消費する。`buildPasteDraft(text)` の引数は1つ（`now` は取らない。
現在時刻を使う処理が無いため）。

**4. 未確定の残り** — なし。
