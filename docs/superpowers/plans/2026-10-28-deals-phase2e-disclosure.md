# 取引・帳票 第2段階 段E(物件状況確認書=告知書)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全宅連の「物件状況確認書(告知書)」の土地建物・土地用と区分所有建物用を、空欄で印刷して手で書くことも、画面で入れて印字することもできるようにする。

**Architecture:**
- 全宅連の Excel(.xlsx)から、表紙・「ご記入にあたって」・告知書の頁のセルの文字を取り出すスクリプトを1本置く(段D と同じ考え方)。取り出したものは書類ごとに TS ファイルにする。
- 告知書の入力欄と PDF の表は、段B の「項目の表」で作る。告知書は、1つの番号の下に小さな行(□の付いた文、未・済、年・月頃の書き込みなど)が続く。そのため、項目の表に次の4つを足す。
  - 下の行(`sub`)
  - 書き込み欄の文字を下線の後ろに出す(`after`。例: 「＿年＿月頃」)
  - PDF に出さない欄(`noPrint`。説明のページを付けるかどうか)
  - 区切りの見出しの出し分け(`only`)
- 種類(土地建物・土地用/区分所有建物用)は、段D と同じく小窓の上のタブで選ぶ。初めは物件の元の種別から決める(区分=区分所有建物用・それ以外=土地建物・土地用)。
- 項目の表の見出し・選択肢・書き込み欄の名前は、全宅連の書式のセルの文字と一字も違わないことをテストで確かめる(空白は比べない)。
- 「ご記入にあたって」(表紙と記入の要領)は、発行のときに「付ける」を選べば一緒に出す(初めは付ける)。

**Tech Stack:** Next.js 16 / React 19 / zod 4.6 / vitest(env=node)/ Python 3 + openpyxl(取り出しのスクリプトだけ・手元のパソコンに入っている・npm の依存は足さない)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§2 の 8、§3.3、§3.4、§4.7)

## Global Constraints

- 表・列は足さない(migration なし)。npm の依存も足さない。
- 書式の説明文と項目の文言は、全宅連の書式から一字も変えずに写す。行をそろえるためだけの空白は写さない(発注者 2026-10-28「スペースは不要」)。書式にない項目は足さない。写した文面は書類ごとに1つのファイルにまとめ、ファイルの先頭に、どこから写したか(ファイル名と作成日・更新日)を書く。
- 写した文面が元と同じかをテストで守る(指紋)。
- 何も選ばなかった項目は □ を並べた空欄で出し、選んだものは ■ で出す。書き込み欄が空なら下線で出す。入力画面の一番上に「すべて空欄に戻す」を置く(段B の部品のまま)。
- 自動で入れるのは物件名だけ(書式の頭)。売主・買主の名前は署名の欄なので入れない(空欄)。
- 前の会社の名前・リースバックの語を使わない(走査テスト)。テストに実在の人の名前・住所を使わない。画面の文言は平易な日本語にする。

## Review Focus

1. 全部空欄のまま発行する(手書き用)。期待する動き: 全項目の選択肢が □ で並び、■ は1つも出ない。年・月の欄は「＿年＿月頃」のように下線の後ろに字が出る。Task 2・4 で固定する。
2. 種類のタブを切り替える(土地建物 ⇄ 区分)。期待する動き: 入力欄・PDF・Excel とも、選んだ種類の項目だけが出る。区分用だけに「表２」が出る。Task 4 で固定する。
3. 「説明のページを付ける」を付けない/付ける。期待する動き: 付けないときは告知書だけを出す。付けるときは、表紙と「ご記入にあたって」(人の死の告知のガイドラインの説明を含む)を後ろに付ける。この設定は告知書の表に出さない。Task 2・4 で固定する。
4. 書き込みに `<` などが入っている。期待する動き: エスケープされて出る。Task 4 で固定する。
5. 前回の入力(remember)が別の種類の値を持つ。期待する動き: 鍵が種類ごとに別(土地建物=`h`・区分=`u` で始まる)なので混ざらない。Task 3 で、鍵が重ならないことを固定する。

## 決めたこと(この計画での読み替え)

1. **1つの書類にし、種類は小窓の上のタブで選ぶ**(段D の媒介契約書と同じ扱い・発注者の指示「同じページの中でタブで選択」に合わせる)。
   - 設計 §2 は「種別で自動で切り替え」。そのため、タブの初めの値を物件の元の種別から決める。
   - 区分の建物でも土地建物用が要ることがあるので、手でも選べるようにする。
   - コスト: タブを使わないなら、初めの値の決め方はそのまま、タブだけを隠す。
2. **項目の表の文字は手で書き、取り出したセルの文字とテストで突き合わせる**。セルの並び(結合セル・飛び飛びの列)から項目の形を自動で読み取るのは誤りやすいため。
   - 突き合わせは、空白(全角・半角・改行)を外して、セルの文字をすべてつないだものに含まれるかで見る。
   - 書き込み欄の名前の最後の「：」「:」は比べない。
   - コスト: 突き合わせを通るが並びが違う、という誤りは見つけられない。番号の並び(①②③…)だけは別のテストで見る。
3. **PDF の形は、書式の表の「項目|状況」の2列にそろえる**。番号の行の下に小さな行を続ける。Excel の書式の細かい位置(何列目か)までは写さない。
4. **選択肢の値は、選択肢の文字そのもの**(例: 「未」「済」「発見していない」)。

---

### Task 1: 全宅連の告知書(Excel)から文面を取り出す

**Files:**
- Create: `scripts/deals/extract-zentaku-disclosure.py`
- Create(スクリプトが生成): `src/lib/deals/documents/texts/disclosure-house.ts`、`disclosure-unit.ts`
- Create: `src/lib/deals/documents/texts/disclosure-types.ts`
- Test: `src/lib/deals/documents/__tests__/disclosure-texts.test.ts`(新規)

**Interfaces:**
- Produces: `DisclosureSource`、`DISCLOSURE_HOUSE_SOURCE`・`DISCLOSURE_UNIT_SOURCE`

- [ ] **Step 1: 型を書く**

`src/lib/deals/documents/texts/disclosure-types.ts`:

```ts
/** 全宅連の物件状況確認書(告知書)から写した文面(設計 第2段階 §3.4)。scripts/deals/extract-zentaku-disclosure.py が作る。 */
export type GuideBlock = { kind: "note"; text: string } | { kind: "row"; item: string; text: string };
export interface DisclosureSource {
  source: string;
  created: string;
  modified: string;
  /** 表紙(「…ご記入にあたって」と売主様へのお願い)。 */
  coverTitle: string;
  cover: string[];
  /** 「ご記入にあたって」(記入の要領)。 */
  guideTitle: string;
  guide: GuideBlock[];
  /** 告知書の頁のセルの文字(並びはシートの行の順)。項目の表の文字の突き合わせに使う。 */
  formCells: string[];
}
```

- [ ] **Step 2: スクリプトを書く**

`scripts/deals/extract-zentaku-disclosure.py`:

```python
"""
全宅連の物件状況確認書(告知書・Excel)から文面を取り出して TS にする(設計 第2段階 §3.4・段E の計画 Task 1)。
手元で1回動かす: python -X utf8 -I scripts/deals/extract-zentaku-disclosure.py <全宅書式のフォルダ>
出力: src/lib/deals/documents/texts/disclosure-{house,unit}.ts(手で直さない)
- シートは [表紙, 記入にあたって, 告知書の頁] の順と決めて読む
- セルの文字は前後の空白(全角・半角)だけ外す。セルの中の改行は残す
- 「記入にあたって」は、項目・状況の2つがそろう行を row、1つだけの行を note にする(「項目」「状況」の見出しの行は入れない)
⚠ 読むのは自分の手元の全宅連の書式だけ。openpyxl は手元のパソコンに入っているものを使う(npm の依存ではない)。
"""
import json
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src/lib/deals/documents/texts"
FILES = [
    ("kokuchisyo_kodate.2205.xlsx", "disclosure-house.ts", "DISCLOSURE_HOUSE_SOURCE", "土地建物・土地用"),
    ("kokuchisyo_kubun.2205 (1).xlsx", "disclosure-unit.ts", "DISCLOSURE_UNIT_SOURCE", "区分所有建物用"),
]


def text(v):
    return v.strip(" \u3000") if isinstance(v, str) and v.strip(" \u3000\n") else None


def cells(ws):
    out = []
    for row in ws.iter_rows():
        for c in row:
            t = text(c.value)
            if t:
                out.append((c.row, c.column, t))
    return out


def squeeze(t):
    return re.sub(r"[\s\u3000]", "", t)


def extract(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    cover_ws, guide_ws, form_ws = (wb[n] for n in wb.sheetnames[:3])
    cover = [t for _, _, t in cells(cover_ws)]
    g = cells(guide_ws)
    guide_title = g[0][2]
    by_row = {}
    for r, col, t in g[1:]:
        by_row.setdefault(r, []).append((col, t))
    guide = []
    for r in sorted(by_row):
        parts = [t for _, t in sorted(by_row[r])]
        if [squeeze(p) for p in parts] == ["項目", "状況"]:
            continue
        if len(parts) >= 2:
            guide.append({"kind": "row", "item": parts[0], "text": "\n".join(parts[1:])})
        else:
            guide.append({"kind": "note", "text": parts[0]})
    p = wb.properties
    return {
        "created": p.created.strftime("%Y-%m-%d") if p.created else "",
        "modified": p.modified.strftime("%Y-%m-%d") if p.modified else "",
        "coverTitle": cover[0], "cover": cover[1:],
        "guideTitle": guide_title, "guide": guide,
        "formCells": [t for _, _, t in cells(form_ws)],
    }


def write(src_name, out_name, const, kind, d):
    j = lambda v: json.dumps(v, ensure_ascii=False)
    lines = [
        "// 生成: scripts/deals/extract-zentaku-disclosure.py(手で直さない)",
        "/**",
        f" * 全宅連の書式「物件状況確認書（告知書／{kind}）」から写した文面(設計 第2段階 §3.4)。",
        f" * 元: 全宅書式/{src_name}(作成 {d['created']}・更新 {d['modified']})。セルの文字の前後の空白だけ外した。そのほかは元のまま。",
        " */",
        'import type { DisclosureSource } from "./disclosure-types";',
        "",
        f"export const {const}: DisclosureSource = {{",
        f"  source: {j(src_name)},",
        f"  created: {j(d['created'])},",
        f"  modified: {j(d['modified'])},",
        f"  coverTitle: {j(d['coverTitle'])},",
        "  cover: [",
        *[f"    {j(t)}," for t in d["cover"]],
        "  ],",
        f"  guideTitle: {j(d['guideTitle'])},",
        "  guide: [",
        *[f"    {j(b)}," for b in d["guide"]],
        "  ],",
        "  formCells: [",
        *[f"    {j(t)}," for t in d["formCells"]],
        "  ],",
        "};",
        "",
    ]
    (OUT / out_name).write_text("\n".join(lines), encoding="utf8", newline="\n")


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for src_name, out_name, const, kind in FILES:
        d = extract(folder / src_name)
        write(src_name, out_name, const, kind, d)
        print(out_name, len(d["cover"]), len(d["guide"]), len(d["formCells"]))
```

- [ ] **Step 3: 動かして、生成されたファイルを読む**

```bash
python -X utf8 -I scripts/deals/extract-zentaku-disclosure.py "C:/Users/issin/Desktop/Ligare Japan/不動産関係/営業ツール/全宅書式"
```

Expected: 2行出る。生成された2つのファイルを開いて、次を確かめる。
- 表紙の題名が「『物件状況確認書（告知書／…）』のご記入にあたって」になっている。
- 「ご記入にあたって」の row に①〜の項目が並んでいる。
- note に「全項目共通の記入方法について」と、人の死の告知のガイドラインの段落がある。
- formCells の先頭が「物件状況確認書（告知書／…）」になっている。

おかしな所があれば、スクリプトを直して動かし直す。直したことは台帳に書く。

- [ ] **Step 4: 指紋のテストを書く**

`src/lib/deals/documents/__tests__/disclosure-texts.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";

const ALL = { house: DISCLOSURE_HOUSE_SOURCE, unit: DISCLOSURE_UNIT_SOURCE };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、全宅連の書式と見比べてから値を直す。値は生成したファイルから取って書いた。 */
const FINGERPRINTS: Record<keyof typeof ALL, string> = { house: "", unit: "" };

describe("全宅連の物件状況確認書(告知書)から写した文面", () => {
  it("どこから写したか・指紋", () => {
    for (const [k, t] of Object.entries(ALL) as [keyof typeof ALL, (typeof ALL)[keyof typeof ALL]][]) {
      expect(t.source).toMatch(/^kokuchisyo_/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(hash({ cover: [t.coverTitle, ...t.cover], guide: [t.guideTitle, t.guide], form: t.formCells }), k).toBe(FINGERPRINTS[k]);
    }
  });
  it("表紙・ご記入にあたって・告知書の頁の要の文", () => {
    expect(DISCLOSURE_HOUSE_SOURCE.coverTitle).toBe("『物件状況確認書（告知書／土地建物・土地用）』のご記入にあたって");
    expect(DISCLOSURE_UNIT_SOURCE.formCells[0]).toBe("物件状況確認書（告知書／区分所有建物用）");
    for (const t of Object.values(ALL)) {
      expect(t.formCells).toContain("売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。");
      expect(t.guide.some((b) => b.kind === "note" && b.text.includes("宅地建物取引業者による人の死の告知に関するガイドライン"))).toBe(true);
      expect(t.guide.find((b) => b.kind === "row")).toMatchObject({ item: "①雨漏り" });
    }
  });
  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
```

- [ ] **Step 5: 指紋を固定して通す**

Run: `npx vitest run src/lib/deals/documents/__tests__/disclosure-texts.test.ts`

Expected:
- 1回目: 指紋だけが落ちる。出た値を `FINGERPRINTS` に書く。2つ目の値が出ないときは、Python で同じ JSON の sha256 を計算して書く。
  - ⚠ JSON.stringify と Python の json.dumps は、区切りの空白が違う。Python で計算するときは `separators=(",", ":")` と `ensure_ascii=False` を付ける。
- 2回目: PASS(3 tests)。

- [ ] **Step 6: Commit**

```bash
git add scripts/deals/extract-zentaku-disclosure.py src/lib/deals/documents/texts src/lib/deals/documents/__tests__/disclosure-texts.test.ts
git commit -m "feat(deals): 全宅連の告知書の文面を写す(第2段階 段E)"
```

---

### Task 2: 項目の表に「下の行」「下線の後ろの字」「PDF に出さない欄」「見出しの出し分け」

**Files:**
- Modify: `src/lib/deals/documents/forms/types.ts`・`values.ts`・`render.ts`
- Modify: `src/components/deals/doc-form-fields.tsx`
- Test: `src/lib/deals/documents/__tests__/forms.test.ts`(describe を足す)、`src/components/deals/__tests__/doc-form-fields.test.tsx`(it を足す)

**Interfaces:**
- Produces:
  - `FormItem.sub?: boolean`: 番号の行の下の行。PDF では項目の欄を空け、状況の欄の頭に見出しを出す。
  - `FormItem.noPrint?: boolean`: 入力欄だけに出し、PDF・Excel には出さない。
  - `FormField.after?: boolean`: 下線の後ろに字を出す(「＿年」)。
  - 区切りの見出しの `only?: string[]`

- [ ] **Step 1: 失敗するテストを書く**

`forms.test.ts` の末尾に足す:

```ts
describe("告知書のための項目の表の形(第2段階 段E)", () => {
  const F: FormDef = {
    key: "f",
    tabs: { key: "kind", label: "種類", choices: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] },
    entries: [
      { kind: "section", title: "甲だけの見出し", only: ["a"] },
      { kind: "item", key: "n1", label: "①雨漏り" },
      { kind: "item", key: "n1a", label: "", sub: true, multiple: true, choices: [{ value: "現在まで雨漏りを発見していない。", label: "現在まで雨漏りを発見していない。" }] },
      { kind: "item", key: "n1b", label: "修理工事：", sub: true, choices: [{ value: "未", label: "未" }, { value: "済", label: "済" }], fields: [{ key: "n1bY", label: "年", max: 10, after: true }, { key: "n1bM", label: "月頃", max: 10, after: true }] },
      { kind: "item", key: "n1c", label: "", sub: true, fields: [{ key: "n1cPlace", label: "箇所：", max: 20 }] },
      { kind: "item", key: "guide", label: "説明のページ", noPrint: true, choices: [{ value: "付ける", label: "付ける" }] },
    ],
  };
  it("見出しの出し分け・下の行は項目の欄を空ける・下線の後ろに字・「：」で終わる名前に「:」を重ねない・PDF に出さない欄", () => {
    const h = renderFormHtml(F, { ...emptyFormValues(F), n1bY: "2020" }).toString();
    expect(h).toContain("<h2>甲だけの見出し</h2>");
    expect(renderFormHtml(F, { ...emptyFormValues(F), kind: "b" }).toString()).not.toContain("甲だけの見出し");
    expect(h).toContain("<th style=\"width:30%\">①雨漏り</th>");
    expect(h).toMatch(/<th style="width:30%"><\/th><td>\s*<div>[^<]*<span class="form-choice">□ 現在まで雨漏りを発見していない。<\/span>/);
    expect(h).toContain("修理工事：");
    expect(h).toMatch(/<span class="form-text">2020<\/span>年/);
    expect(h).toMatch(/<span class="form-blank short"><\/span>月頃/);
    expect(h).toContain("箇所：<span class=\"form-blank\"></span>");
    expect(h).not.toContain("箇所：:");
    expect(h).not.toContain("説明のページ");
    expect(formValueRows(F, emptyFormValues(F)).map((r) => r.label)).toEqual([
      "甲だけの見出し", "①雨漏り 現在まで雨漏りを発見していない。", "①雨漏り 修理工事：", "①雨漏り 修理工事： 年", "①雨漏り 修理工事： 月頃", "①雨漏り 箇所：",
    ]);
  });
});
```

`doc-form-fields.test.tsx` の describe の末尾に足す:

```tsx
  it("下の行は字下げ・下線の後ろの字の欄も入力できる・PDF に出さない欄も入力欄には出す", () => {
    const F: FormDef = {
      key: "f",
      entries: [
        { kind: "item", key: "n1", label: "①雨漏り" },
        { kind: "item", key: "n1b", label: "修理工事：", sub: true, choices: [{ value: "未", label: "未" }], fields: [{ key: "n1bY", label: "年", max: 10, after: true }] },
        { kind: "item", key: "guide", label: "説明のページ", noPrint: true, choices: [{ value: "付ける", label: "付ける" }] },
      ],
    };
    const out = renderToStaticMarkup(<DocFormFields form={F} values={{}} onChange={() => {}} />);
    expect(out).toContain("①雨漏り");
    expect(out).toMatch(/<div class="[^"]*ml-4[^"]*">[\s\S]*修理工事：/);
    expect(out).toContain('aria-label="修理工事： 年"');
    expect(out).toContain("説明のページ");
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/forms.test.ts src/components/deals/__tests__/doc-form-fields.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装**

`forms/types.ts`:
- `FormField` を次にする:
```ts
/** 書き込み欄。key は表の中で重ならない名前(項目の鍵とも重ならない)。after = 下線の後ろに名前を出す(「＿年」)。 */
export interface FormField { key: string; label: string; max: number; lines?: number; after?: boolean }
```
- `FormItem` の `only?: string[];` の次に:
```ts
  /** 番号の行の下の行(PDF では項目の欄を空け、状況の欄の頭に見出しを出す・告知書)。 */
  sub?: boolean;
  /** 入力欄だけに出し、PDF・Excel には出さない(説明のページを付けるかなどの設定)。 */
  noPrint?: boolean;
```
- `FormEntry` を次にする:
```ts
export type FormEntry = { kind: "section"; title: string; only?: string[] } | FormItem;
```

`forms/values.ts` の `visibleEntries` の filter を次にする:
```ts
  return f.entries.filter((e) => !e.only || (typeof tab === "string" && e.only.includes(tab)));
```

`forms/render.ts`:
- `FORM_CSS` に足す: `.form-blank.short{min-width:12mm}`
- `sections` の中で、`noPrint` の項目を入れない。`for` の中の `else {` の先頭に `if (e.noPrint) continue;` を足す。
- `renderFormHtml` の行の組み立てを次にする:
```ts
    const on = picked(it, v);
    const field = (fl: FormField) => {
      const t = str(v[fl.key]);
      const value = t ? html`<span class="form-text">${t}</span>` : html`<span class="form-blank${fl.after ? " short" : ""}"></span>`;
      return fl.after
        ? html`<span class="form-field-inline">${value}${fl.label}</span> `
        : html`<div class="form-field">${fl.label}${/[：:]$/.test(fl.label) ? "" : ":"}${t ? " " : ""}${value}</div>`;
    };
    return html`<tr><th style="width:30%">${it.sub ? "" : it.label}</th><td>
${it.sub && it.label && !it.choices?.length && !(it.fields ?? []).some((f) => !f.after) ? html`<span>${it.label}</span>` : null}
${it.choices?.length ? html`<div>${it.sub && it.label ? html`${it.label}` : null}${it.choices.map((c) => html`<span class="form-choice">${on.includes(c.value) ? "■" : "□"} ${c.label}</span>`)}${(it.fields ?? []).filter((f) => f.after).map(field)}</div>` : (it.fields ?? []).filter((f) => f.after).map(field)}
${(it.fields ?? []).filter((f) => !f.after).map(field)}
${it.note && on.includes(it.note.when) ? html`<div class="form-note">※ ${it.note.text}</div>` : null}
</td></tr>`;
```
(import に `type FormField` を足す。)

⚠ 段B の売主属性調査書の表示を変えないこと:
- 書き込み欄の名前に「：」が無いときは、今までどおり「名前:」+下線になる。
- 下線は値が無いとき、名前の直後に続く(今の `${fl.label}: ${…}` の「: 」の空白は、値があるときだけ入れる)。
- 売主属性調査書のテスト(`business-docs-seller-survey.test.ts`)が落ちたら、テストの期待値ではなく組み立てを直す。

- `formValueRows` を次にする(下の行は、上の番号の行の見出しを頭に付ける):
```ts
export function formValueRows(f: FormDef, v: FormValues): ValueRow[] {
  return sections(f, v).flatMap((s) => {
    let head = "";
    return [
      ...(s.title ? [{ label: s.title, heading: true }] : []),
      ...s.items.flatMap((it): ValueRow[] => {
        if (!it.sub) head = it.label;
        const own = it.label || (it.choices ?? []).map((c) => c.label).join("・");
        const label = it.sub ? `${head} ${own}`.trim() : it.label;
        const on = picked(it, v);
        const labels = (it.choices ?? []).filter((c) => on.includes(c.value)).map((c) => c.label);
        return [
          ...(it.choices?.length ? [{ label, value: labels.length ? labels.join("・") : null }] : []),
          ...(it.fields ?? []).map((fl) => ({ label: `${label} ${fl.label}`.trim(), value: str(v[fl.key]) })),
        ];
      }),
    ];
  });
}
```

⚠ 上の期待値の「①雨漏り 箇所：」は、`label` が空の下の行の書き込み欄。`own` が空のとき `label` は「①雨漏り」、書き込み欄の行は「①雨漏り 箇所：」になる。番号の行(選択肢・書き込み欄なし)は Excel の行を出さない。

`doc-form-fields.tsx` の `ItemFields`:
- 一番外の `<div className="space-y-1.5">` を `<div className={`space-y-1.5${item.sub ? " ml-4" : ""}`}>` にする。
- 見出し `<p …>{item.label}</p>` は、`item.label` があるときだけ出す。
  - 選択肢も書き込み欄も無い項目(番号の行)は、`text-sm font-semibold text-gray-700 dark:text-gray-300` にする。
- 書き込み欄の `aria-label` は `${item.label} ${f.label}` のまま。`after` の欄も同じ入力欄にする。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals src/components && npx tsc --noEmit`
Expected: PASS・型エラー 0(売主属性調査書・媒介契約書の既存のテストも通る)

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/documents/forms src/components/deals src/lib/deals/documents/__tests__/forms.test.ts
git commit -m "feat(deals): 項目の表に下の行・下線の後ろの字・PDF に出さない欄・見出しの出し分け(告知書のため)"
```

---

### Task 3: 告知書の項目の表(土地建物・土地用/区分所有建物用)

**Files:**
- Create: `src/lib/deals/documents/forms/disclosure.ts`
- Test: `src/lib/deals/documents/__tests__/disclosure-form.test.ts`(新規)

**Interfaces:**
- Produces:
  - `DisclosureKind = "house" | "unit"`
  - `DISCLOSURE_KIND_LABELS`
  - `DISCLOSURE_FORM: FormDef`(タブ `kind`・設定 `withGuide`・`h…`=土地建物・`u…`=区分)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/disclosure-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DISCLOSURE_FORM } from "../forms/disclosure";
import { formItems, visibleEntries } from "../forms/values";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";
import type { FormItem } from "../forms/types";

const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");
const NUMS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕";
const itemsOf = (kind: string) => visibleEntries(DISCLOSURE_FORM, { kind }).filter((e): e is FormItem => e.kind === "item" && !e.noPrint);
/** 項目の表の文字(見出し・選択肢・書き込み欄の名前・区切りの見出し)。 */
const textsOf = (kind: string) => [
  ...visibleEntries(DISCLOSURE_FORM, { kind }).filter((e) => e.kind === "section").map((e) => (e.kind === "section" ? e.title : "")),
  ...itemsOf(kind).flatMap((i) => [i.label, ...(i.choices ?? []).map((c) => c.label), ...(i.fields ?? []).map((f) => f.label.replace(/[：:]$/, ""))]),
].filter(Boolean);

describe("告知書の項目の表(設計 第2段階 §4.7)", () => {
  it("種類はタブ・説明のページの設定は PDF に出さない", () => {
    expect(DISCLOSURE_FORM.tabs).toEqual({ key: "kind", label: "種類", choices: [{ value: "house", label: "土地建物・土地用" }, { value: "unit", label: "区分所有建物用" }] });
    const g = formItems(DISCLOSURE_FORM).find((i) => i.key === "withGuide")!;
    expect(g.noPrint).toBe(true);
    expect(g.choices?.map((c) => c.value)).toEqual(["付ける", "付けない"]);
  });

  it("見出し・選択肢・書き込み欄の名前は、全宅連の書式のセルの文字と一字も違わない(空白は比べない)", () => {
    for (const [kind, src] of [["house", DISCLOSURE_HOUSE_SOURCE], ["unit", DISCLOSURE_UNIT_SOURCE]] as const) {
      const all = squeeze(src.formCells.join(""));
      for (const t of textsOf(kind)) expect(all, `${kind}: ${t}`).toContain(squeeze(t));
    }
  });

  it("番号の並びは書式のとおり(土地建物=①〜㉕・区分=表１ ①〜⑳ と 表２ ①〜④)", () => {
    const nums = (kind: string) => itemsOf(kind).filter((i) => !i.sub && NUMS.includes(i.label[0])).map((i) => i.label[0]).join("");
    expect(nums("house")).toBe(NUMS);
    expect(nums("unit")).toBe(NUMS.slice(0, 20) + "①②③④");
  });

  it("鍵が重ならず、土地建物は h・区分は u で始まる(前回の入力が種類で混ざらない)", () => {
    const keys = formItems(DISCLOSURE_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of formItems(DISCLOSURE_FORM).filter((i) => !i.noPrint)) {
      expect(i.key, i.key).toMatch(i.only?.[0] === "unit" ? /^u/ : /^h/);
      expect(i.only, i.key).toHaveLength(1);
    }
  });

  it("区分用だけに表２(管理費・修繕積立金の変更予定)", () => {
    expect(textsOf("unit")).toContain("表２ 管理費・修繕積立金の変更予定");
    expect(textsOf("house").join()).not.toContain("表２");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/disclosure-form.test.ts`
Expected: FAIL(`../forms/disclosure` が無い)

- [ ] **Step 3: 項目の表を書く**

`src/lib/deals/documents/forms/disclosure.ts`:

```ts
import type { FormChoice, FormDef, FormEntry, FormField, FormItem } from "./types";

/** 告知書の種類(設計 第2段階 §4.7)。同じ書類の中でタブで選ぶ(段E の決めたこと 1)。 */
export type DisclosureKind = "house" | "unit";
export const DISCLOSURE_KIND_LABELS: Record<DisclosureKind, string> = { house: "土地建物・土地用", unit: "区分所有建物用" };

/**
 * 項目の表の文字は全宅連の書式のセルの文字のまま(段E の決めたこと 2・テストで突き合わせる)。
 * 鍵は土地建物=h・区分=u で始める(前回の入力が種類で混ざらないように)。
 */
type Ctx = { p: "h" | "u"; only: [DisclosureKind] };
const cs = (xs: string[]): FormChoice[] => xs.map((x) => ({ value: x, label: x }));
const fl = (c: Ctx, key: string, label: string, opt: Partial<FormField> = {}): FormField => ({ key: c.p + key, label, max: 200, ...opt });
const yy = (c: Ctx, key: string, last: "月頃" | "日" = "月頃"): FormField[] => [
  fl(c, `${key}Y`, "年", { max: 10, after: true }),
  ...(last === "日" ? [fl(c, `${key}M`, "月", { max: 10, after: true }), fl(c, `${key}D`, "日", { max: 10, after: true })] : [fl(c, `${key}M`, "月頃", { max: 10, after: true })]),
];
/** 番号の行。 */
const head = (c: Ctx, key: string, label: string, choices?: string[], fields?: FormField[]): FormItem =>
  ({ kind: "item", key: c.p + key, label, only: c.only, ...(choices ? { choices: cs(choices) } : {}), ...(fields ? { fields } : {}) });
/** 番号の行の下の行。 */
const sub = (c: Ctx, key: string, label: string, choices?: string[], fields?: FormField[], multiple = false): FormItem =>
  ({ kind: "item", key: c.p + key, label, sub: true, only: c.only, ...(choices ? { choices: cs(choices), ...(multiple ? { multiple: true } : {}) } : {}), ...(fields ? { fields } : {}) });
/** 書式の □ の付いた文1つ(チェックを付けるだけ)。 */
const check = (c: Ctx, key: string, text: string, fields?: FormField[]): FormItem => sub(c, key, "", [text], fields, true);
/** 下の行の書き込み欄だけ。 */
const write = (c: Ctx, key: string, label: string, lines?: number): FormItem => sub(c, key, "", undefined, [fl(c, key + "Text", label, lines ? { lines, max: 1000 } : {})]);

const YN = ["無", "有"];
const YNU = ["無", "有", "不明"];
const FOUND = ["発見していない", "発見している"];
const HAS = ["有", "無"];

/** ①〜⑪(建物のこと)。土地建物と区分で文字の違う所だけ引数で変える。 */
function buildingItems(c: Ctx, v: { reform: string; asbestos: string; asbestosDate: string; built: string; fireArea: string; otherDoc: "split" | "one" }): FormEntry[] {
  return [
    head(c, "01", "①雨漏り"),
    check(c, "01a", "現在まで雨漏りを発見していない。"),
    check(c, "01b", "過去に雨漏りがあった。", [fl(c, "01bPlace", "箇所：")]),
    sub(c, "01c", "修理工事：", ["未", "済"], yy(c, "01c")),
    check(c, "01d", "現在雨漏り箇所がある。", [fl(c, "01dPlace", "箇所：")]),
    head(c, "02", "②白蟻被害"),
    check(c, "02a", "現在まで白蟻の被害を発見していない。"),
    sub(c, "02b", "白蟻予防工事：", ["未", "済"], yy(c, "02b")),
    check(c, "02c", "過去に白蟻の被害があった。", [fl(c, "02cPlace", "箇所：")]),
    sub(c, "02d", "駆除と修理工事：", ["未", "済"], yy(c, "02d")),
    check(c, "02e", "現在白蟻の被害がある。", [fl(c, "02ePlace", "箇所：")]),
    head(c, "03", "③建物の不具合（傾き・腐食・不具合等）", FOUND),
    write(c, "03a", "箇所・状況："),
    head(c, "04", "④給排水施設の故障・漏水", FOUND),
    write(c, "04a", "箇所・状況："),
    head(c, "05", v.reform, ["実施していない", "実施している", "不明"], yy(c, "05")),
    write(c, "05a", "箇所・内容："),
    write(c, "05b", "建設業者："),
    sub(c, "05c", "建築確認済証：", HAS),
    sub(c, "05d", "検査済証：", HAS),
    sub(c, "05e", "設計図書：", HAS),
    head(c, "06", "⑥火災(ボヤ等含む)の被害", YN, [fl(c, "06When", "時期：", { max: 30 }), ...yy(c, "06")]),
    write(c, "06a", v.fireArea),
    head(c, "07", v.asbestos, YN),
    sub(c, "07a", v.asbestosDate, undefined, yy(c, "07a", "日")),
    write(c, "07b", "調査の実施機関："),
    write(c, "07c", "調査の範囲："),
    write(c, "07d", "備考："),
    head(c, "08", "⑧建物状況調査", YN),
    sub(c, "08a", "", ["建物状況調査報告書", "建物状況調査の結果の概要"]),
    sub(c, "08b", "作成年月日", undefined, yy(c, "08b", "日")),
    write(c, "08c", "調査実施者："),
    head(c, "09", "⑨耐震診断及び地震に対する安全性に関する資料", YN),
    sub(c, "09a", "（保存している資料）", ["耐震基準適合証明書", "既存住宅性能評価書", "耐震診断結果報告書", "既存住宅売買瑕疵保険の付保証明書", "その他"], [fl(c, "09aName", v.otherDoc === "split" ? "資料名：" : "その他（資料名：")], true),
    head(c, "10", "⑩住宅性能評価", YN),
    sub(c, "10a", "（保存している資料）", ["設計住宅性能評価書", "建設住宅性能評価書", "既存住宅性能評価書"], undefined, true),
    head(c, "11", "⑪建物新築時の資料及び分譲業者名"),
    sub(c, "11a", "建築確認済証：", HAS),
    sub(c, "11b", "設計図書：", HAS),
    sub(c, "11c", "検査済証：", HAS),
    write(c, "11d", v.built),
  ];
}

const status = (c: Ctx, key: string, label: string, choices: string[], text: string, lines?: number): FormEntry[] => [head(c, key, label, choices), write(c, `${key}a`, text, lines)];

const H: Ctx = { p: "h", only: ["house"] };
const U: Ctx = { p: "u", only: ["unit"] };

const HOUSE: FormEntry[] = [
  ...buildingItems(H, {
    reform: "⑤増改築･修繕･リフォーム･用途変更の履歴及び資料", asbestos: "⑦石綿使用調査結果の記録", asbestosDate: "調査年月日",
    built: "分譲業者・宅建業者名：", fireArea: "箇所・状況:", otherDoc: "split",
  }),
  head(H, "12", "⑫境界について"),
  sub(H, "12a", "隣地との境界：", ["確認できた", "確認できない"]),
  write(H, "12b", "確認できない箇所："),
  sub(H, "12c", "取決め書：", YN),
  sub(H, "12d", "紛争:", YN, [fl(H, "12dText", "紛争の内容：")]),
  head(H, "13", "⑬越境について"),
  sub(H, "13a", "越境：", YNU),
  sub(H, "13b", "越境物：", ["塀", "フェンス", "擁壁", "建物", "植栽", "給水管", "排水管", "ガス管", "その他"], [fl(H, "13bOther", "その他")], true),
  sub(H, "13c", "取決め書：", YN),
  sub(H, "13d", "紛争:", YN, [fl(H, "13dText", "紛争の内容：")]),
  write(H, "13e", "場所・状況："),
  head(H, "14", "⑭擁壁について", YN),
  sub(H, "14a", "／所有者：", ["売主", "隣地所有者", "共有", "不明"], [fl(H, "14aDir", "方角:", { max: 20 })]),
  sub(H, "14b", "／所有者：", ["売主", "隣地所有者", "共有", "不明"], [fl(H, "14bDir", "方角:", { max: 20 })]),
  sub(H, "14c", "取決め書：", YN),
  sub(H, "14d", "紛争：", YN, [fl(H, "14dText", "紛争の内容:")]),
  sub(H, "14e", "亀裂等の有無：", FOUND),
  write(H, "14f", "状況："),
  ...status(H, "15", "⑮地盤の沈下、軟弱", FOUND, "状況："),
  head(H, "16", "⑯土壌汚染に関する情報"),
  sub(H, "16a", "敷地の住宅以外（店舗・工場等）の用途での使用履歴", YNU, [...yy(H, "16a"), fl(H, "16aUse", "用途：")]),
  sub(H, "16b", "土壌汚染に関するその他の情報", YNU, [fl(H, "16bText", "内容：")]),
  head(H, "17", "⑰地中埋設物"),
  check(H, "17a", "発見していない"),
  sub(H, "17b", "発見している／", ["旧建物基礎", "建物廃材", "浄化槽", "井戸", "その他"], [fl(H, "17bOther", "その他"), fl(H, "17bPlace", "場所・状況／")], true),
  ...status(H, "18", "⑱騒音・振動・臭気等", YNU, "状況："),
  ...status(H, "19", "⑲電波障害", YNU, "状況："),
  ...status(H, "20", "⑳浸水等の被害", YNU, "状況："),
  ...status(H, "21", "㉑近隣の建築計画", YNU, "状況："),
  ...status(H, "22", "㉒売買物件に影響を及ぼすと思われる周辺施設", YNU, "内容："),
  ...status(H, "23", "㉓売買物件に影響を及ぼすと思われる過去に起きた事件・事故", YNU, "内容："),
  ...status(H, "24", "㉔近隣との申し合わせ事項", YNU, "内容："),
  head(H, "25", "㉕その他売主から買主に引き継ぐ事項"),
  write(H, "25a", "", 3),
  head(H, "99", "備考"),
  write(H, "99a", "", 4),
];

const UNIT: FormEntry[] = [
  { kind: "section", title: "表１ 物件の状況 本物件は通常の経年変化があるほか、下記のとおりの状況であります。", only: ["unit"] },
  ...buildingItems(U, {
    reform: "⑤改築・修繕・リフォーム・用途変更の履歴及び資料", asbestos: "⑦石綿使用調査結果の記録", asbestosDate: "調査年月日：",
    built: "分譲業者・宅建業者名：", fireArea: "箇所・状況：", otherDoc: "one",
  }),
  head(U, "12", "⑫土壌汚染に関する情報"),
  sub(U, "12a", "敷地の住宅以外（店舗・工場等）の用途での使用履歴", YNU, [...yy(U, "12a"), fl(U, "12aUse", "用途：")]),
  sub(U, "12b", "土壌汚染に関するその他の情報", YNU, [fl(U, "12bText", "内容：")]),
  ...status(U, "13", "⑬騒音・振動・臭気等", YNU, "状況："),
  head(U, "98", "備考："),
  write(U, "98a", "", 3),
  ...status(U, "14", "⑭近隣の建築計画", YNU, "状況："),
  ...status(U, "15", "⑮電波障害", YNU, "状況："),
  ...status(U, "16", "⑯浸水等の被害", YNU, "状況："),
  ...status(U, "17", "⑰売買物件に影響を及ぼすと思われる周辺施設", YNU, "内容："),
  ...status(U, "18", "⑱売買物件に影響を及ぼすと思われる過去に起きた事件・事故等", YNU, "内容："),
  ...status(U, "19", "⑲近隣との申し合わせ事項", YNU, "内容："),
  ...status(U, "20", "⑳その他売主から買主に引き継ぐ事項", YNU, "内容：", 3),
  head(U, "99", "備考："),
  write(U, "99a", "", 4),
  { kind: "section", title: "表２ 管理費・修繕積立金の変更予定", only: ["unit"] },
  ...status(U, "t1", "①管理費・修繕積立金等の変更予定", ["無", "協議中", "有"], "時期・金額："),
  ...status(U, "t2", "②大規模修繕の予定", ["無", "協議中", "有"], "時期・概要・臨時負担金の有無："),
  ...status(U, "t3", "③自治会費等", YN, "金額・支払方法："),
  head(U, "t4", "④管理組合集会における討議事項"),
  write(U, "t4a", "概要：", 3),
];

export const DISCLOSURE_FORM: FormDef = {
  key: "disclosure",
  tabs: { key: "kind", label: "種類", choices: (Object.keys(DISCLOSURE_KIND_LABELS) as DisclosureKind[]).map((k) => ({ value: k, label: DISCLOSURE_KIND_LABELS[k] })) },
  entries: [
    { kind: "item", key: "withGuide", label: "説明のページ（表紙と「ご記入にあたって」）", noPrint: true, choices: cs(["付ける", "付けない"]) },
    ...HOUSE,
    ...UNIT,
  ],
};
```

⚠注意点:
- `check` は書式の □ の付いた文を、選択肢1つのチェックで持つ(いくつでも選べる形=チェックボックス)。
- 書き込み欄だけの行(`write`)は、見出しを空にし、書き込み欄の名前に書式の文字(「箇所・状況：」など)を入れる。
- 突き合わせのテストが落ちたら、セルの文字(`texts/disclosure-*.ts` の `formCells`)を見て、項目の表の文字のほうを直す。直したことは台帳に書く。
  - 区分の「⑦石綿使用調査結果の⏎記録」のようにセルの中で改行している文字は、空白を外して比べるので、改行なしで書いてよい。
  - 書式の「㉕その他売主から買主に⏎引き継ぐ事項」も同じ扱い。
  - 書き込み欄の名前が空の行(`write(…, "", 3)`)は、突き合わせの対象から外れる(空文字は比べない)。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/disclosure-form.test.ts && npx tsc --noEmit`
Expected: PASS(5 tests)・型エラー 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/documents/forms/disclosure.ts src/lib/deals/documents/__tests__/disclosure-form.test.ts
git commit -m "feat(deals): 告知書の項目の表(土地建物・土地用/区分所有建物用)"
```

---

### Task 4: 物件状況確認書(告知書)の組み立てと一覧表

**Files:**
- Create: `src/lib/deals/documents/business/disclosure.ts`
- Modify: `registry.ts`(`sale_guide` の次に1行)・`issue.ts`
- Test: `src/lib/deals/documents/__tests__/business-docs-disclosure.test.ts`(新規)、既存の一覧の並びの期待値

**Interfaces:**
- Consumes: Task 1〜3
- Produces: `disclosureDefaults(c)`・`disclosureMissing(c)`・`buildDisclosure(c, o)`・一覧表のキー `disclosure`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-disclosure.test.ts`。先頭の fixture(rateRows・party・deal・company・settings・ctx)は `business-docs-mediation.test.ts` の先頭と同じものを、import も含めてそのまま書く。媒介契約書だけの import は外す。そのうえで、次を足す:

```ts
import { emptyFormValues } from "../forms/values";
import { DISCLOSURE_FORM } from "../forms/disclosure";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";

const K = "disclosure";
const doc = () => businessDocOf(K)!;
const blank = (kind: string, withGuide = "付けない") => ({ ...emptyFormValues(DISCLOSURE_FORM), kind, withGuide });
const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");

describe("物件状況確認書(告知書・第2段階 §4.7)", () => {
  it("「契約・媒介の書類」の説明書の次・どの取引でも出せる・前回の入力を引き継ぐ・種類はタブ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("sale_guide") + 1);
    expect(doc().label).toBe("物件状況確認書(告知書)");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().form).toBe(DISCLOSURE_FORM);
    expect(doc().applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("物件状況確認書(告知書)");
  });

  it("初めの値: 種類は物件の元の種別から・説明のページは付ける", () => {
    expect(doc().defaults(ctx()).values).toMatchObject({ kind: "house", withGuide: "付ける" });
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "land" })).values.kind).toBe("house");
    expect(doc().options.safeParse(doc().defaults(ctx()).values).success).toBe(true);
  });

  it("空欄の確認: 物件名(物件名も所在地も無いとき)", () => {
    expect(doc().missing(ctx())).toEqual([]);
    expect(doc().missing(ctx({ ...deal, propertySnapshot: EMPTY_SNAPSHOT }))).toEqual(["物件名"]);
  });

  it("全部空欄(手書き用): 題名・物件名・書式の文・□ だけ・署名の欄は空欄・説明のページなし", () => {
    const h = doc().build(ctx(), blank("house")).html;
    expect(h).toContain("物件状況確認書（告知書／土地建物・土地用）");
    expect(h).toContain("試験ハウス&lt;b&gt;");
    expect(h).toContain("売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。");
    expect(h).toContain("□ 現在まで雨漏りを発見していない。");
    expect(h).toContain("㉕その他売主から買主に引き継ぐ事項");
    expect(h).not.toContain("■");
    expect(h).toContain("本物件の状況が上記のとおりであることを売主は、買主に告知しました。");
    expect(h).toContain("上記のとおり、売主より告知を受けました。");
    expect(h).not.toContain("架空 一郎");
    expect(h).not.toContain("ご記入にあたって");
    expect(h).not.toContain("表２");
    expect(h).not.toContain("c2VhbA==");
  });

  it("選んだものは ■・書き込みはエスケープ・Excel の行", () => {
    const o = { ...blank("house"), h01b: ["過去に雨漏りがあった。"], h01bPlace: "<北側>", h01c: "済", h01cY: "2020", h01cM: "5" };
    const out = doc().build(ctx(), o);
    expect(out.html).toContain("■ 過去に雨漏りがあった。");
    expect(out.html).toContain("&lt;北側&gt;");
    expect(out.html).toContain("■ 済");
    expect(out.rows).toContainEqual({ label: "①雨漏り 修理工事：", value: "済" });
  });

  it("区分所有建物用: 表１・表２・区分の項目だけ", () => {
    const h = doc().build(ctx(), blank("unit")).html;
    expect(h).toContain("物件状況確認書（告知書／区分所有建物用）");
    expect(h).toContain("表２ 管理費・修繕積立金の変更予定");
    expect(h).toContain("④管理組合集会における討議事項");
    expect(h).not.toContain("⑫境界について");
  });

  it("説明のページを付ける: 表紙と「ご記入にあたって」(人の死の告知のガイドラインを含む)を後ろに", () => {
    const h = doc().build(ctx(), blank("house", "付ける")).html;
    expect(h).toContain(DISCLOSURE_HOUSE_SOURCE.coverTitle);
    expect(h).toContain("物件状況確認書（告知書／土地建物・土地用）ご記入にあたって");
    expect(squeeze(h)).toContain(squeeze("宅地建物取引業者による人の死の告知に関するガイドライン"));
    expect(h.indexOf("上記のとおり、売主より告知を受けました。")).toBeLessThan(h.indexOf(DISCLOSURE_HOUSE_SOURCE.coverTitle));
  });

  it("書式の頭の文と署名の文は、全宅連の書式のセルの文字と一字も違わない", async () => {
    const { DISCLOSURE_HEAD_TEXTS } = await import("../business/disclosure");
    for (const [kind, texts] of Object.entries(DISCLOSURE_HEAD_TEXTS)) {
      const src = kind === "house" ? DISCLOSURE_HOUSE_SOURCE : (await import("../texts/disclosure-unit")).DISCLOSURE_UNIT_SOURCE;
      for (const t of texts) expect(squeeze(src.formCells.join("")), t).toContain(squeeze(t));
    }
  });
});
```

`EMPTY_SNAPSHOT` は fixture の import にすでにある(`../../schemas`)。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-disclosure.test.ts`
Expected: FAIL(`disclosure` が一覧表に無い)

- [ ] **Step 3: 組み立てを書く**

`src/lib/deals/documents/business/disclosure.ts`:

```ts
import { html, raw } from "../html";
import { documentHtml } from "../layout";
import { DISCLOSURE_FORM, DISCLOSURE_KIND_LABELS, type DisclosureKind } from "../forms/disclosure";
import { emptyFormValues } from "../forms/values";
import { formValueRows, renderFormHtml } from "../forms/render";
import type { FormValues } from "../forms/types";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";
import type { DisclosureSource } from "../texts/disclosure-types";
import type { BusinessDocContext, ValueRow } from "./common";

const SOURCES: Record<DisclosureKind, DisclosureSource> = { house: DISCLOSURE_HOUSE_SOURCE, unit: DISCLOSURE_UNIT_SOURCE };

/** 書式の頭の文と署名の文(全宅連の書式のセルの文字のまま・テストで突き合わせる)。 */
export const DISCLOSURE_HEAD_TEXTS: Record<DisclosureKind, string[]> = {
  house: [
    "売買物件の状況(現況更地は①～⑪の記入不要、建物解体後の更地渡しは①～③、⑦～⑪の記入不要",
    "売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。",
    "物件の状況　本物件は通常の経年変化があるほか、下記のとおりの状況であります。",
    "本物件の状況が上記のとおりであることを売主は、買主に告知しました。",
    "上記のとおり、売主より告知を受けました。",
  ],
  unit: [
    "売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。",
    "本物件の状況が上記のとおりであることを売主は、買主に告知しました。",
    "上記のとおり、売主より告知を受けました。",
  ],
};

const CSS = `.sign td{height:12mm;vertical-align:bottom}
.guide p{white-space:pre-wrap;margin:1.5mm 0}
.page{page-break-before:always}`;

const kindOf = (o: FormValues): DisclosureKind => (o.kind === "unit" ? "unit" : "house");

/** 書式の頭の「物件名」(物件名・号室。無ければ所在地)。 */
function propertyName(c: BusinessDocContext): string | null {
  const s = c.deal.propertySnapshot;
  return [s.buildingName, s.roomNo && `${s.roomNo}号室`].filter(Boolean).join(" ") || s.address || null;
}

export function disclosureDefaults(c: BusinessDocContext): FormValues {
  const base = c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  return { ...emptyFormValues(DISCLOSURE_FORM), kind: base === "unit" ? "unit" : "house", withGuide: "付ける" };
}

export function disclosureMissing(c: BusinessDocContext): string[] {
  return propertyName(c) ? [] : ["物件名"];
}

/** 物件状況確認書(告知書・設計 第2段階 §4.7)。売主・買主の名前は署名の欄なので空欄。 */
export function buildDisclosure(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const kind = kindOf(o);
  const src = SOURCES[kind];
  const texts = DISCLOSURE_HEAD_TEXTS[kind];
  const title = `物件状況確認書（告知書／${DISCLOSURE_KIND_LABELS[kind]}）`;
  const [notify, received] = texts.slice(-2);
  const intro = texts.slice(0, -2);
  const name = propertyName(c);
  const guide = o.withGuide === "付ける" ? html`
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.coverTitle}</h1>${src.cover.map((p) => html`<p>${p}</p>`)}</div>
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.guideTitle}</h1>
${src.guide.map((b) => (b.kind === "note" ? html`<p>${b.text}</p>` : html`<table><tr><th style="width:30%">${b.item}</th><td style="white-space:pre-wrap">${b.text}</td></tr></table>`))}</div>` : null;
  const body = html`<style>${raw(CSS)}</style>
<h1 style="font-size:14pt;letter-spacing:0">${title}</h1>
<div class="right">（物件名：${name ?? ""}）</div>
${intro.map((p) => html`<p>${p}</p>`)}
${renderFormHtml(DISCLOSURE_FORM, o)}
<p class="right" style="margin-top:4mm">年　　　月　　　日</p>
<p>${notify}</p>
<table class="sign"><tr><th style="width:18%">＜売主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
<p>${received}</p>
<table class="sign"><tr><th style="width:18%">＜買主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
${guide}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [{ label: "書類", value: title }, { label: "物件名", value: name }, ...formValueRows(DISCLOSURE_FORM, o)],
  };
}
```

`registry.ts`:
1. import:
```ts
import { DISCLOSURE_FORM } from "./forms/disclosure";
import { buildDisclosure, disclosureDefaults, disclosureMissing } from "./business/disclosure";
```
2. ファイルの上のほうに `const disclosureOptionsSchema = formValuesSchema(DISCLOSURE_FORM);`
3. `sale_guide` の行の次に:
```ts
  {
    key: "disclosure",
    label: "物件状況確認書(告知書)",
    group: "contract",
    remember: true,
    form: DISCLOSURE_FORM,
    applies: () => true,
    missing: (c) => disclosureMissing(c),
    blocking: () => [],
    options: disclosureOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: disclosureDefaults(c) }),
    build: (c, o) => buildDisclosure(c, disclosureOptionsSchema.parse(o)),
  },
```

`issue.ts` の `sale_guide` の行の次に:
```ts
  disclosure: { label: "物件状況確認書(告知書)", variants: { default: "" } },
```

- [ ] **Step 4: 通ることを確かめる・並びの期待値を直す**

Run: `npx vitest run src/lib/deals src/app`
Expected:
- 新しいテストは PASS(8 tests)。
- 並びの期待値(5b・出せる書類・前回の入力の読み込み対象 `docType: { in: [...] }`)にだけ `"disclosure"` を足す。足す場所は、5b と出せる書類は `sale_guide` の次、`in` は `mediation` の次。直したことは台帳に書く。

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals
git commit -m "feat(deals): 物件状況確認書(告知書)(第2段階 段E)"
```

---

### Task 5: 走査・使い方ガイドとマニュアル・全部のゲート

- [ ] **Step 1: 走査に足す**

`business-docs-contract.test.ts` の走査の一覧に `"disclosure.ts"` を足す(`business/` の下)。

`forms/disclosure.ts` も見る。走査の `join(…, "business", f)` は `business` 固定なので、`forms/disclosure.ts` 用に1行の `it` を足す:
```ts
  it("告知書の項目の表に前の会社の語が無い", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/deals/documents/forms/disclosure.ts"), "utf8");
    for (const w of ["インテリックス", "リースバック"]) expect(src).not.toContain(w);
  });
```

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS

- [ ] **Step 2: ガイドとマニュアル**

`public/docs/guide.html`:
- 「媒介契約の前の説明書）」を「媒介契約の前の説明書・物件状況確認書［告知書］）」にする。
- 媒介契約書の `<li>` の後ろに1行足す:
```html
        <li><b>物件状況確認書（告知書）</b>は、発行の小窓の上のタブで土地建物・土地用と区分所有建物用を選びます（初めは物件の種別から）。全宅連の書式の項目のとおりに選んだり書いたりでき、何も入れずに出せば手書き用になります。「説明のページ」を付けると、売主様向けの「ご記入にあたって」も一緒に出ます</li>
```

`public/docs/manual.html`:
- 「媒介契約の前の説明書・決済の書類」を「媒介契約の前の説明書・物件状況確認書（告知書）・決済の書類」にする。
- 説明書の `<li>` の後ろに1行足す:
```html
              <li><b>物件状況確認書（告知書）</b>：どの取引でも出せます。発行の小窓の上のタブで、土地建物・土地用（①〜㉕）と区分所有建物用（表１の①〜⑳と表２の管理費・修繕積立金の変更予定）を選びます（初めは物件の種別から）。全宅連の書式の項目・番号・並びのとおりで、選ばなかった選択肢は □、選んだものは ■、書き込みが空なら下線で出ます。何も入れずに出せば手書き用になります。物件名だけが自動で入り、売主・買主の名前は署名の欄なので空欄です。「説明のページ」を「付ける」にすると、表紙と「ご記入にあたって」（人の死の告知のガイドラインの説明を含む）を後ろに付けます。</li>
```

- [ ] **Step 3: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals src/components/deals; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0 / eslint=0 / build=0。

PC の負荷で時間切れになったテストは、落ちたファイルだけを `--maxWorkers=1 --testTimeout=120000` で回し直す。

PDF の見た目(告知書の表が何ページになるか・説明のページ)は、発注者の実機確認に回す。

- [ ] **Step 4: Commit**

```bash
git add src/lib/deals/documents/__tests__/business-docs-contract.test.ts public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 物件状況確認書(告知書)をガイドとマニュアルに"
```
