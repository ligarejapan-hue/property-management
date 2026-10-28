# 取引・帳票 第2段階 段F(付帯設備表)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全宅連の「付帯設備表」の土地建物用と区分所有建物用を、空欄で印刷して手で書くことも、画面で入れて印字することもできるようにする。

**Architecture:**
- 段E の取り出しのスクリプトに、設備表の2つの Excel を足す。これで表紙・「ご記入にあたって」・付帯設備表の頁のセルの文字を、書類ごとの TS ファイルにする。
- 設備の一覧(表１主要設備・表２その他設備)は「設備の行の表」(`EQUIPMENT_ROWS`)として手で書く。行の種類は次の5つ。
  - 表の見出し
  - 部門(給湯関係など)
  - 設備
  - 空欄の行
  - 備考
- 設備の行の表から、次の2つを作る。
  - 入力欄と形の検査に使う項目の表(`EQUIPMENT_FORM`・段B〜E の部品をそのまま使う)
  - PDF の4列の表(名称|設置箇所・設備の内容|設備の有無|判明している故障・不具合)
- 種類は小窓の上のタブで選ぶ(段D・E と同じ)。初めの値は物件の元の種別から決める。土地だけの物件には出さない(設計 §4.8)。
- 設備の内容の「（電気・ガス・石油）」などは、書式の「該当する箇所に〇を記入」のとおり、選んだものを丸で囲む。
- 説明のページ(表紙と「ご記入にあたって」)は、段E と同じく「付ける」(初め)で後ろに付ける。

**Tech Stack:** Next.js 16 / React 19 / zod 4.6 / vitest(env=node)/ Python 3 + openpyxl(取り出しのスクリプトだけ・手元のパソコン)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§2 の 9、§3.3、§3.4、§4.8)

## Global Constraints

- 表・列は足さない(migration なし)。npm の依存も足さない。
- 書式の説明文と設備の文言は、全宅連の書式から一字も変えずに写す。行をそろえるためだけの空白は写さない。書式にない設備は足さない。写した文面は書類ごとに1つのファイルにまとめ、ファイルの先頭に、どこから写したか(ファイル名と作成日・更新日)を書く。
- 写した文面が元と同じかをテストで守る(指紋)。
- 何も選ばなかった設備は「有・無」に丸を付けずに出す(手で丸を付けられる)。書き込み欄が空なら下線で出す。入力画面の一番上に「すべて空欄に戻す」を置く(段B の部品のまま。説明のページの設定は残る=段E)。
- 自動で入れるのは物件名だけ。売主・買主の名前は署名の欄なので空欄。
- 前の会社の名前・リースバックの語を使わない(走査テスト)。テストに実在の人の名前・住所を使わない。画面の文言は平易な日本語にする。

## Review Focus

1. 書式の設備の行が抜ける・増える。期待する動き: 書式の「設備の有無」の欄(「有・無」だけのセル)の数と、設備の行と空欄の行の数が同じになる。「特定保守製品の表示」のセルの数とも合う。Task 2 で固定する。
2. 全部空欄で発行する(手書き用)。期待する動き: 丸は1つも付かず、故障・不具合の欄は下線になる。Task 3 で固定する。
3. 設備の内容の選択肢を選ぶ(例: 給湯器の「ガス」)。期待する動き: その文字だけが丸で囲まれる。同じ字がほかの所にあっても囲まない(例: 「鏡（有・無）」と設備の有無の「有・無」)。Task 3 で固定する。
4. 土地だけの物件。期待する動き: 書類タブに出さない。Task 3 で固定する。
5. 書き込みに `<` などが入っている。期待する動き: エスケープされて出る。Task 3 で固定する。

## 決めたこと(この計画での読み替え)

1. **1つの書類にし、種類は小窓の上のタブで選ぶ**(段D・E と同じ)。
   - 初めの値は物件の元の種別から決める(区分=区分所有建物用・それ以外=土地建物用)。
   - 元の種別が土地の取引では出さない(設計 §4.8)。種別が決まらない取引では出す(手で選ぶ)。
2. **PDF は書式と同じ4列の表で組み立てる**(段E の2列の共通の表は使わない)。入力欄と形の検査・Excel の行は、共通の部品を使う。
3. **設備の内容の選択肢は、書式の括弧の中の言葉を手で書く**(例: 給湯器=電気・ガス・石油・太陽熱)。丸を付けるのは、その内容の文字の最後の「（」から後ろだけ(段D の「有・無」と同じ考え方)。
   - 括弧の中の空き(「　　　）」=書式の手書きの欄)は、選択肢にしない。
4. **書式の空欄の行**(名称の無い「有・無」だけの行)は、名称を書き込める行にする。名称の欄の名前は、表の見出し(「主要設備の名称」「その他設備の名称」)を使う。
5. **書式の頭の説明文・注２の説明・署名の文**は、取り出したセルの文字をそのまま使う(手で写さない)。

---

### Task 1: 設備表の Excel から文面を取り出す(段E のスクリプトに足す)

**Files:**
- Modify: `scripts/deals/extract-zentaku-disclosure.py`(設備表の2つを足す・題名を引数にする)
- Create(スクリプトが生成): `src/lib/deals/documents/texts/equipment-house.ts`、`equipment-unit.ts`
- Test: `src/lib/deals/documents/__tests__/equipment-texts.test.ts`(新規)

- [ ] **Step 1: スクリプトを直す**

`scripts/deals/extract-zentaku-disclosure.py`:

1. 先頭の説明の1行目を次にする: `全宅連の物件状況確認書(告知書)と付帯設備表(Excel)から文面を取り出して TS にする(設計 第2段階 §3.4・段E/段F の計画 Task 1)。`
2. 出力の行を次にする: `出力: src/lib/deals/documents/texts/{disclosure,equipment}-{house,unit}.ts(手で直さない)`
3. `FILES` を次にする(4つ目は書類の題名。告知書の2つは今までと同じ字になる):
```python
FILES = [
    ("kokuchisyo_kodate.2205.xlsx", "disclosure-house.ts", "DISCLOSURE_HOUSE_SOURCE", "物件状況確認書（告知書／土地建物・土地用）"),
    ("kokuchisyo_kubun.2205 (1).xlsx", "disclosure-unit.ts", "DISCLOSURE_UNIT_SOURCE", "物件状況確認書（告知書／区分所有建物用）"),
    ("futaisetubi_kodate.2205.xlsx", "equipment-house.ts", "EQUIPMENT_HOUSE_SOURCE", "付帯設備表（土地建物用）"),
    ("futaisetubi_kubun.2205 (1).xlsx", "equipment-unit.ts", "EQUIPMENT_UNIT_SOURCE", "付帯設備表（区分所有建物用）"),
]
```
4. `write` の中の `f" * 全宅連の書式「物件状況確認書（告知書／{kind}）」から写した文面(設計 第2段階 §3.4)。",` を `f" * 全宅連の書式「{kind}」から写した文面(設計 第2段階 §3.4)。",` にする。

- [ ] **Step 2: 動かして、生成されたファイルを読む**

```bash
python -X utf8 -I scripts/deals/extract-zentaku-disclosure.py "C:/Users/issin/Desktop/Ligare Japan/不動産関係/営業ツール/全宅書式"
git diff --stat src/lib/deals/documents/texts/disclosure-house.ts src/lib/deals/documents/texts/disclosure-unit.ts
```

Expected:
- 4行出る。
- 告知書の2つのファイルは差分なし(題名を引数にしただけ)。
- 設備表の2つのファイルを開いて、次を確かめる。
  - 表紙の題名が「『付帯設備表』（…）のご記入にあたって」になっている。
  - formCells に「主要設備の名称」「給湯器」「判明している\n故障・不具合の具体的内容」「※注２の表示が…」がある。

- [ ] **Step 3: 指紋のテストを書く**

`src/lib/deals/documents/__tests__/equipment-texts.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";

const ALL = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、全宅連の書式と見比べてから値を直す。値は生成したファイルから取って書いた。 */
const FINGERPRINTS: Record<keyof typeof ALL, string> = { house: "", unit: "" };

describe("全宅連の付帯設備表から写した文面", () => {
  it("どこから写したか・指紋", () => {
    for (const t of Object.values(ALL)) {
      expect(t.source).toMatch(/^futaisetubi_/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const fp = (t: (typeof ALL)[keyof typeof ALL]) => hash({ cover: [t.coverTitle, ...t.cover], guide: [t.guideTitle, t.guide], form: t.formCells });
    expect({ house: fp(ALL.house), unit: fp(ALL.unit) }).toEqual(FINGERPRINTS);
  });
  it("表紙・頭の説明文・注２の説明", () => {
    expect(EQUIPMENT_HOUSE_SOURCE.coverTitle).toBe("『付帯設備表』（土地建物用）のご記入にあたって");
    for (const t of Object.values(ALL)) {
      expect(t.formCells.some((c) => c.startsWith("「設備の有無」欄に「有」とした付帯設備等は"))).toBe(true);
      expect(t.formCells.some((c) => c.startsWith("※注２の表示が「有」の設備は"))).toBe(true);
    }
  });
  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
```

- [ ] **Step 4: 指紋を固定して通す**

Run: `npx vitest run src/lib/deals/documents/__tests__/equipment-texts.test.ts`

Expected:
- 1回目: 指紋だけが落ちる。出た2つの値を書く。
- 2回目: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add scripts/deals/extract-zentaku-disclosure.py src/lib/deals/documents/texts src/lib/deals/documents/__tests__/equipment-texts.test.ts
git commit -m "feat(deals): 全宅連の付帯設備表の文面を写す(第2段階 段F)"
```

---

### Task 2: 設備の行の表と、そこから作る項目の表

**Files:**
- Create: `src/lib/deals/documents/forms/equipment.ts`
- Test: `src/lib/deals/documents/__tests__/equipment-form.test.ts`(新規)

**Interfaces:**
- Produces:
  - `EquipmentKind = "house" | "unit"`
  - `EQUIPMENT_KIND_LABELS`
  - `EquipRow`
  - `EQUIPMENT_ROWS: Record<EquipmentKind, EquipRow[]>`
  - `EQUIPMENT_FORM: FormDef`(タブ `kind`・設定 `withGuide`・`h…`/`u…`)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/equipment-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EQUIPMENT_FORM, EQUIPMENT_ROWS } from "../forms/equipment";
import { formItems } from "../forms/values";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";

const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");
const SRC = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE } as const;

describe("付帯設備表の設備の行の表(設計 第2段階 §4.8)", () => {
  it("種類はタブ・説明のページの設定は PDF に出さない", () => {
    expect(EQUIPMENT_FORM.tabs).toEqual({ key: "kind", label: "種類", choices: [{ value: "house", label: "土地建物用" }, { value: "unit", label: "区分所有建物用" }] });
    expect(formItems(EQUIPMENT_FORM).find((i) => i.key === "withGuide")).toMatchObject({ noPrint: true });
  });

  it("書式の文字と一字も違わない(表の見出し・部門・設備の名称・内容・選択肢・書き込み欄の名前・空白は比べない)", () => {
    for (const kind of ["house", "unit"] as const) {
      const cells = SRC[kind].formCells.map(squeeze);
      const has = (t: string) => cells.some((c) => c.includes(squeeze(t)));
      for (const r of EQUIPMENT_ROWS[kind]) {
        if (r.kind === "table") for (const t of [r.title, r.nameHeader, r.detailHeader]) expect(has(t), `${kind}: ${t}`).toBe(true);
        if (r.kind === "group") expect(has(r.title), `${kind}: ${r.title}`).toBe(true);
        if (r.kind === "equip") {
          if (r.name) expect(has(r.name), `${kind}: ${r.name}`).toBe(true);
          for (const d of r.details ?? []) {
            for (const p of d.parts) expect(has(p), `${kind}: ${p}`).toBe(true);
            for (const o of d.options ?? []) expect(d.parts.join(""), `${kind}: ${o}`).toContain(o);
          }
        }
      }
      for (const t of ["設置箇所：", "計", "特定保守製品の表示（注２）", "判明している故障・不具合の具体的内容", "備考"]) expect(has(t), t).toBe(true);
    }
  });

  it("設備の行と空欄の行の数=書式の「有・無」だけのセルの数・特定保守製品の行の数も合う(行の抜け・増えを見る)", () => {
    for (const kind of ["house", "unit"] as const) {
      const cells = SRC[kind].formCells.map(squeeze);
      const rows = EQUIPMENT_ROWS[kind];
      expect(rows.filter((r) => r.kind === "equip" || r.kind === "blank").length, kind).toBe(cells.filter((c) => c === "有・無").length);
      expect(rows.filter((r) => r.kind === "equip" && r.safety).length, kind).toBe(cells.filter((c) => c.includes("特定保守製品の表示")).length);
    }
  });

  it("鍵が重ならず、土地建物は h・区分は u で始まる", () => {
    const keys = formItems(EQUIPMENT_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of formItems(EQUIPMENT_FORM).filter((i) => !i.noPrint)) expect(i.key, i.key).toMatch(i.only?.[0] === "unit" ? /^u/ : /^h/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/equipment-form.test.ts`
Expected: FAIL(`../forms/equipment` が無い)

- [ ] **Step 3: 設備の行の表を書く**

`src/lib/deals/documents/forms/equipment.ts`:

```ts
import type { FormChoice, FormDef, FormEntry, FormField, FormItem } from "./types";

/** 付帯設備表の種類(設計 第2段階 §4.8)。同じ書類の中でタブで選ぶ(段F の決めたこと 1)。 */
export type EquipmentKind = "house" | "unit";
export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = { house: "土地建物用", unit: "区分所有建物用" };

/** 設備の内容(書式のセルごとの文字 parts と、丸を付けられる言葉 options)。 */
export interface EquipDetail { parts: string[]; options?: string[] }
/**
 * 設備の行の表(段F の決めたこと 2〜4)。文字は全宅連の書式のセルのまま(テストで突き合わせる)。
 * table=表１/表２の見出し・group=部門・equip=設備・blank=書式の空欄の行・note=備考。
 */
export type EquipRow =
  | { kind: "table"; key: string; title: string; nameHeader: string; detailHeader: string }
  | { kind: "group"; title: string }
  | { kind: "equip"; key: string; name: string; details?: EquipDetail[]; place?: boolean; count?: "台" | "ヶ所"; safety?: boolean }
  | { kind: "blank"; key: string }
  | { kind: "note"; key: string };

export const EQUIP_FAULT = "判明している故障・不具合の具体的内容";
export const EQUIP_SAFETY = "特定保守製品の表示（注２）";
const DETAIL_HEADER = "設置箇所・設備の内容・付帯設備等";
const d = (parts: string | string[], options?: string[]): EquipDetail => ({ parts: Array.isArray(parts) ? parts : [parts], ...(options ? { options } : {}) });
const EGS = ["電気", "ガス", "石油"];

const HOUSE: EquipRow[] = [
  { kind: "table", key: "t1", title: "表１．主要設備", nameHeader: "主要設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入してください。）` },
  { kind: "group", title: "給湯関係" },
  { kind: "equip", key: "01", name: "給湯器", details: [d("（電気・ガス・石油・太陽熱）", [...EGS, "太陽熱"]), d("給湯箇所：（キッチン・浴室・洗面所）", ["キッチン", "浴室", "洗面所"])], safety: true },
  { kind: "equip", key: "02", name: "屋内式ガス湯沸かし器《個別》", safety: true },
  { kind: "blank", key: "03" },
  { kind: "group", title: "水廻り関係" },
  { kind: "equip", key: "04", name: "流し台" },
  { kind: "equip", key: "05", name: "混合水栓" },
  { kind: "equip", key: "06", name: "レンジフード《換気扇》" },
  { kind: "equip", key: "07", name: "コンロ", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "08", name: "グリル", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "09", name: "", details: [d("ビルトインオーブンレンジ（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "10", name: "", details: [d("ビルトイン食器洗浄乾燥機（電気・ガス）", ["電気", "ガス"])], safety: true },
  { kind: "equip", key: "11", name: "浄水器" },
  { kind: "equip", key: "12", name: "ディスポーザー" },
  { kind: "blank", key: "13" },
  { kind: "equip", key: "14", name: "シャワー" },
  { kind: "equip", key: "15", name: "混合水栓" },
  { kind: "equip", key: "16", name: "", details: [d("浴槽（追炊き・足し湯・保温・湯張り）", ["追炊き", "足し湯", "保温", "湯張り"])] },
  { kind: "equip", key: "17", name: "", details: [d("浴室洗面台　鏡（有・無）", ["有", "無"])] },
  { kind: "equip", key: "18", name: "屋内式風呂がま《バランス釜》", safety: true },
  { kind: "equip", key: "19", name: "浴室内乾燥《浴室内乾燥（暖房）機》", safety: true },
  { kind: "equip", key: "20", name: "", details: [d(["１階（洗面台・照明・シャワー・コンセント", "・鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "equip", key: "21", name: "", details: [d(["２階（洗面台・照明・シャワー・コンセント", "・鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "blank", key: "22" },
  { kind: "equip", key: "23", name: "", details: [d(["１階（便器・温水洗浄・保温・乾燥・", "ロータンク・手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "24", name: "", details: [d(["２階（便器・温水洗浄・保温・乾燥・", "ロータンク・手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "25", name: "防水パン" },
  { kind: "equip", key: "26", name: "洗濯用水栓" },
  { kind: "blank", key: "27" },
  { kind: "group", title: "空調関係" },
  { kind: "equip", key: "28", name: "冷暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "29", name: "冷房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "30", name: "暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台", safety: true },
  { kind: "equip", key: "31", name: "床暖房設備", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "ヶ所" },
  { kind: "equip", key: "32", name: "", details: [d("換気扇（設置箇所：浴室・洗面所・トイレ・　　　　）", ["浴室", "洗面所", "トイレ"])] },
  { kind: "equip", key: "33", name: "２４時間換気システム" },
  { kind: "group", title: "その他" },
  { kind: "equip", key: "34", name: "インターホン", details: [d("（モニター：有・無）", ["有", "無"])] },
  { kind: "blank", key: "35" },
  { kind: "note", key: "36" },
  { kind: "table", key: "t2", title: "表２．その他設備", nameHeader: "その他設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入ください。）` },
  { kind: "group", title: "照明関係" },
  { kind: "equip", key: "37", name: "屋内照明器具", count: "台" },
  { kind: "equip", key: "38", name: "屋外照明器具", place: true },
  { kind: "group", title: "収納関係" },
  { kind: "equip", key: "39", name: "収納棚", details: [d("（食器棚（造付）・電動昇降戸棚・つり戸棚）", ["食器棚（造付）", "電動昇降戸棚", "つり戸棚"])] },
  { kind: "equip", key: "40", name: "収納スペース", details: [d("（床下収納・小屋裏収納・　　　）", ["床下収納", "小屋裏収納"])] },
  { kind: "equip", key: "41", name: "下駄箱" },
  { kind: "blank", key: "42" },
  { kind: "group", title: "建具関係" },
  ...["網戸", "雨戸", "畳・ふすま", "戸・扉", "障子"].map((name, i): EquipRow => ({ kind: "equip", key: String(43 + i), name })),
  { kind: "group", title: "テレビ視聴" },
  { kind: "equip", key: "48", name: "地上波用ＴＶアンテナ" },
  { kind: "equip", key: "49", name: "衛星アンテナ" },
  { kind: "blank", key: "50" },
  { kind: "group", title: "その他" },
  ...["カーペット（敷込）", "カーテン", "カーテンレール", "物置", "物干し", "スロップシンク(屋外）", "屋外水栓", "庭木・庭石", "門・塀", "車庫・カーポート", "インターネット回線"]
    .map((name, i): EquipRow => ({ kind: "equip", key: String(51 + i), name })),
  { kind: "equip", key: "62", name: "住宅用火災警報器", place: true },
  { kind: "equip", key: "63", name: "太陽光発電システム" },
  { kind: "note", key: "64" },
];

const UNIT: EquipRow[] = [
  { kind: "table", key: "t1", title: "表１．主要設備", nameHeader: "主要設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇をご記入ください。）` },
  { kind: "group", title: "給湯関係" },
  { kind: "equip", key: "01", name: "給湯器", details: [d("（電気・ガス・石油・太陽熱）", [...EGS, "太陽熱"]), d("給湯箇所：（キッチン・浴室・洗面所）", ["キッチン", "浴室", "洗面所"])], safety: true },
  { kind: "blank", key: "02" },
  { kind: "equip", key: "03", name: "屋内式ガス湯沸かし器（個別）", safety: true },
  { kind: "blank", key: "04" },
  { kind: "group", title: "水廻り関係" },
  { kind: "equip", key: "05", name: "流し台" },
  { kind: "equip", key: "06", name: "混合水栓" },
  { kind: "equip", key: "07", name: "レンジフード《換気扇》" },
  { kind: "equip", key: "08", name: "コンロ", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "09", name: "グリル", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "10", name: "", details: [d("ビルトインオーブンレンジ（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "11", name: "", details: [d("ビルトイン食器洗浄乾燥機（電気・ガス）", ["電気", "ガス"])], safety: true },
  { kind: "equip", key: "12", name: "浄水器" },
  { kind: "equip", key: "13", name: "ディスポーザー" },
  { kind: "blank", key: "14" },
  { kind: "equip", key: "15", name: "シャワー" },
  { kind: "equip", key: "16", name: "混合水栓" },
  { kind: "equip", key: "17", name: "", details: [d("浴槽（追炊き・足し湯・保温・湯張り）", ["追炊き", "足し湯", "保温", "湯張り"])] },
  { kind: "equip", key: "18", name: "", details: [d("浴室洗面台　鏡（有・無）", ["有", "無"])] },
  { kind: "equip", key: "19", name: "屋内式風呂がま《バランス釜》", safety: true },
  { kind: "equip", key: "20", name: "浴室内乾燥（浴室内乾燥（暖房）機）", safety: true },
  { kind: "equip", key: "21", name: "", details: [d(["（洗面台・照明・シャワー・コンセント", "鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "blank", key: "22" },
  { kind: "equip", key: "23", name: "", details: [d(["（便器・温水洗浄・保温・乾燥・ロータンク", "手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "24", name: "防水パン" },
  { kind: "equip", key: "25", name: "洗濯用水栓" },
  { kind: "blank", key: "26" },
  { kind: "group", title: "空調関係" },
  { kind: "equip", key: "27", name: "冷暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "28", name: "冷房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "29", name: "暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台", safety: true },
  { kind: "equip", key: "30", name: "床暖房設備", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "ヶ所" },
  { kind: "equip", key: "31", name: "", details: [d("換気扇（設置箇所：浴室・洗面所・トイレ・　　　　）", ["浴室", "洗面所", "トイレ"])] },
  { kind: "equip", key: "32", name: "２４時間換気システム" },
  { kind: "group", title: "その他" },
  { kind: "equip", key: "33", name: "インターホン", details: [d("（モニター：有・無）", ["有", "無"])] },
  { kind: "blank", key: "34" },
  { kind: "note", key: "35" },
  { kind: "table", key: "t2", title: "表２．その他設備", nameHeader: "その他設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入ください。）` },
  { kind: "group", title: "照明" },
  { kind: "equip", key: "36", name: "室内照明器具", count: "台" },
  { kind: "group", title: "収納関係" },
  { kind: "equip", key: "37", name: "収納棚", details: [d("（食器棚（造付）・電動昇降戸棚・つり戸棚）", ["食器棚（造付）", "電動昇降戸棚", "つり戸棚"])] },
  { kind: "equip", key: "38", name: "収納スペース", details: [d("（床下収納・小屋裏収納・　　　）", ["床下収納", "小屋裏収納"])] },
  { kind: "equip", key: "39", name: "下駄箱" },
  { kind: "group", title: "建具関係" },
  ...["網戸", "畳・ふすま", "戸・扉", "障子"].map((name, i): EquipRow => ({ kind: "equip", key: String(40 + i), name })),
  { kind: "group", title: "テレビ視聴" },
  { kind: "equip", key: "44", name: "ＴＶ共視聴設備" },
  { kind: "blank", key: "45" },
  { kind: "group", title: "その他" },
  ...["カーペット（敷込）", "カーテン", "カーテンレール", "物干し", "スロップシンク（屋外）", "屋外水栓", "インターネット回線"]
    .map((name, i): EquipRow => ({ kind: "equip", key: String(46 + i), name })),
  { kind: "equip", key: "53", name: "住宅用火災警報器", place: true },
  { kind: "blank", key: "54" },
  { kind: "note", key: "55" },
];

export const EQUIPMENT_ROWS: Record<EquipmentKind, EquipRow[]> = { house: HOUSE, unit: UNIT };

/** 設備の名前(名称が無い行は内容の文字・Excel と入力欄の見出しに使う)。 */
export const equipLabel = (r: Extract<EquipRow, { kind: "equip" }>): string => r.name || (r.details?.[0]?.parts.join("") ?? "");
const YN: FormChoice[] = [{ value: "有", label: "有" }, { value: "無", label: "無" }];
const cs = (xs: string[]): FormChoice[] => xs.map((x) => ({ value: x, label: x }));

/** 設備の行の表から、入力欄と形の検査に使う項目の表を作る(PDF は business/equipment.ts が同じ行の表から4列で組み立てる)。 */
function entriesOf(kind: EquipmentKind): FormEntry[] {
  const p = kind === "house" ? "h" : "u";
  const only = [kind];
  let nameHeader = "";
  const out: FormEntry[] = [];
  for (const r of EQUIPMENT_ROWS[kind]) {
    if (r.kind === "table") {
      nameHeader = r.nameHeader;
      out.push({ kind: "section", title: r.title, only });
    } else if (r.kind === "group") {
      out.push({ kind: "item", key: `${p}g${out.length}`, label: r.title, only });
    } else if (r.kind === "note") {
      out.push({ kind: "item", key: p + r.key, label: "備考", only, fields: [{ key: `${p}${r.key}Text`, label: "", max: 1000, lines: 3 }] });
    } else if (r.kind === "blank") {
      out.push({
        kind: "item", key: p + r.key, label: "", sub: true, only, choices: YN,
        fields: [{ key: `${p}${r.key}Name`, label: nameHeader, max: 100 }, { key: `${p}${r.key}Fault`, label: EQUIP_FAULT, max: 300 }],
      });
    } else {
      const fields: FormField[] = [
        ...(r.place ? [{ key: `${p}${r.key}Place`, label: "設置箇所：", max: 100 }] : []),
        ...(r.count ? [{ key: `${p}${r.key}Count`, label: r.count, pre: "計", max: 10, after: true }] : []),
        { key: `${p}${r.key}Fault`, label: EQUIP_FAULT, max: 300 },
      ];
      const item: FormItem = { kind: "item", key: p + r.key, label: equipLabel(r), sub: true, only, choices: YN, fields };
      out.push(item);
      (r.details ?? []).forEach((dt, i) => {
        if (dt.options?.length) out.push({ kind: "item", key: `${p}${r.key}D${i}`, label: dt.parts.join(""), sub: true, only, multiple: true, choices: cs(dt.options) });
      });
      if (r.safety) out.push({ kind: "item", key: `${p}${r.key}S`, label: EQUIP_SAFETY, sub: true, only, choices: YN });
    }
  }
  return out;
}

export const EQUIPMENT_FORM: FormDef = {
  key: "equipment",
  tabs: { key: "kind", label: "種類", choices: (Object.keys(EQUIPMENT_KIND_LABELS) as EquipmentKind[]).map((k) => ({ value: k, label: EQUIPMENT_KIND_LABELS[k] })) },
  entries: [
    { kind: "item", key: "withGuide", label: "説明のページ（表紙と「ご記入にあたって」）", noPrint: true, choices: cs(["付ける", "付けない"]) },
    ...entriesOf("house"),
    ...entriesOf("unit"),
  ],
};
```

⚠注意点:
- 書き写しは、Task 1 で生成した `texts/equipment-*.ts` の formCells を見ながら行う。突き合わせのテストが落ちたら、行の表の文字のほうを直す(台帳に書く)。
- 「有・無」だけのセルの数のテストが落ちたら、書式の空欄の行(`blank`)の数・位置を見直す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/equipment-form.test.ts && npx tsc --noEmit`
Expected: PASS(4 tests)・型エラー 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/documents/forms/equipment.ts src/lib/deals/documents/__tests__/equipment-form.test.ts
git commit -m "feat(deals): 付帯設備表の設備の行の表(土地建物用/区分所有建物用)"
```

---

### Task 3: 付帯設備表の組み立てと一覧表

**Files:**
- Create: `src/lib/deals/documents/business/equipment.ts`
- Modify: `registry.ts`(`disclosure` の次に1行)・`issue.ts`
- Test: `src/lib/deals/documents/__tests__/business-docs-equipment.test.ts`(新規)、既存の一覧の並びの期待値

**Interfaces:**
- Consumes: Task 1・2、`clearFormValues`(段E)
- Produces: `equipmentDefaults(c)`・`equipmentMissing(c)`・`equipmentApplies(c)`・`buildEquipment(c, o)`・一覧表のキー `equipment`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-equipment.test.ts` の先頭の fixture は、`business-docs-disclosure.test.ts` の先頭(import と rateRows〜ctx)を、そのまま写す。告知書だけの import は外す。そのうえで、次を足す:

```ts
import { emptyFormValues } from "../forms/values";
import { EQUIPMENT_FORM } from "../forms/equipment";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";

const K = "equipment";
const doc = () => businessDocOf(K)!;
const blank = (kind: string, withGuide = "付けない") => ({ ...emptyFormValues(EQUIPMENT_FORM), kind, withGuide });
const count = (h: string) => (h.match(/class="circle"/g) ?? []).length;

describe("付帯設備表(第2段階 §4.8)", () => {
  it("「契約・媒介の書類」の告知書の次・土地だけの物件には出さない・前回の入力を引き継ぐ・種類はタブ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("disclosure") + 1);
    expect(doc().label).toBe("付帯設備表");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().form).toBe(EQUIPMENT_FORM);
    expect(doc().applies(ctx())).toBe(true);
    expect(doc().applies(ctx({ ...deal, propertyKind: "land" }))).toBe(false);
    expect(doc().applies(ctx({ ...deal, propertyKind: "custom_kind" }))).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("付帯設備表");
  });

  it("初めの値: 種類は物件の元の種別から・説明のページは付ける", () => {
    expect(doc().defaults(ctx()).values).toMatchObject({ kind: "house", withGuide: "付ける" });
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().options.safeParse(doc().defaults(ctx()).values).success).toBe(true);
  });

  it("全部空欄(手書き用): 題名・物件名・頭の説明文・4列の表・丸は付かない・署名の欄は空欄", () => {
    const h = doc().build(ctx(), blank("house")).html;
    expect(h).toContain("付帯設備表（土地建物用）");
    expect(h).toContain("試験ハウス&lt;b&gt;");
    expect(h).toContain("「設備の有無」欄に「有」とした付帯設備等は");
    expect(h).toContain("<th>主要設備の名称</th>");
    expect(h).toContain("<th>設備の有無</th>");
    expect(h).toContain("給湯器");
    expect(h).toContain("太陽光発電システム");
    expect(h).toContain("※注２の表示が「有」の設備は");
    expect(h).toContain("本物件の付帯設備が上記のとおりであることを売主は、買主に告知しました。");
    expect(count(h)).toBe(0);
    expect(h).not.toContain("架空 一郎");
    expect(h).not.toContain("ご記入にあたって");
  });

  it("選んだ設備の有無・内容の言葉だけを丸で囲む(同じ字がほかにあっても囲まない)・故障の書き込みはエスケープ", () => {
    const o = { ...blank("house"), h01: "有", h01D0: ["ガス"], h01S: "無", h01Fault: "<異音>", h17D0: ["有"], h28Place: "居間", h28Count: "2" };
    const h = doc().build(ctx(), o).html;
    expect(h).toContain('<span class="circle">ガス</span>');
    expect(h).toContain("&lt;異音&gt;");
    expect(h).toContain("居間");
    expect(h).toMatch(/計<span class="form-text">2<\/span>台|計2台/);
    // 給湯器の有・特定保守製品の無・鏡（有・無）の有・ガス = 4つ
    expect(count(h)).toBe(4);
  });

  it("区分所有建物用: 区分の設備だけ", () => {
    const h = doc().build(ctx(), blank("unit")).html;
    expect(h).toContain("付帯設備表（区分所有建物用）");
    expect(h).toContain("ＴＶ共視聴設備");
    expect(h).not.toContain("庭木・庭石");
  });

  it("説明のページを付ける: 表紙と「ご記入にあたって」を後ろに", () => {
    const h = doc().build(ctx(), blank("house", "付ける")).html;
    expect(h).toContain(EQUIPMENT_HOUSE_SOURCE.coverTitle);
    expect(h.indexOf("上記のとおり、売主より告知を受けました")).toBeLessThan(h.indexOf(EQUIPMENT_HOUSE_SOURCE.coverTitle));
  });

  it("Excel の行は選んだ種類の設備だけ", () => {
    const rows = doc().build(ctx(), { ...blank("house"), h01: "有" }).rows;
    expect(rows).toContainEqual({ label: "給湯器", value: "有" });
    expect(rows.map((r) => r.label)).not.toContain("ＴＶ共視聴設備");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-equipment.test.ts`
Expected: FAIL(`equipment` が一覧表に無い)

- [ ] **Step 3: 組み立てを書く**

`src/lib/deals/documents/business/equipment.ts`:

```ts
import { html, raw, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { EQUIP_FAULT, EQUIP_SAFETY, EQUIPMENT_FORM, EQUIPMENT_KIND_LABELS, EQUIPMENT_ROWS, equipLabel, type EquipmentKind, type EquipRow } from "../forms/equipment";
import { emptyFormValues } from "../forms/values";
import { formValueRows } from "../forms/render";
import type { FormValues } from "../forms/types";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";
import type { DisclosureSource } from "../texts/disclosure-types";
import type { BusinessDocContext, ValueRow } from "./common";

const SOURCES: Record<EquipmentKind, DisclosureSource> = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE };
const CSS = `.equip th,.equip td{font-size:8.5pt;padding:.8mm 1.5mm}
.equip .group{background:#f3f4f6;text-align:left}
.equip .yn{width:16mm;text-align:center;white-space:nowrap}
.circle{border:1px solid #111;border-radius:50%;padding:0 .2em}
.blank{display:inline-block;min-width:18mm;border-bottom:1px solid #333;height:1em;vertical-align:bottom}
.blank.long{min-width:40mm}
.notes p,.guide p{white-space:pre-wrap;margin:1.5mm 0}
.sign td{height:12mm;vertical-align:bottom}
.page{page-break-before:always}`;

const kindOf = (o: FormValues): EquipmentKind => (o.kind === "unit" ? "unit" : "house");
const str = (x: FormValues[string] | undefined) => (typeof x === "string" && x.trim() ? x : null);
const list = (x: FormValues[string] | undefined) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []);
const val = (x: string | null, long = false): SafeHtml => (x ? html`${x}` : html`<span class="blank${long ? " long" : ""}"></span>`);

/** 最後の「（」から後ろだけで、選んだ言葉を丸で囲む(同じ字がほかにあっても囲まない・段F の決めたこと 3)。 */
function circledTail(text: string, words: readonly string[], chosen: readonly string[]): SafeHtml {
  const i = text.lastIndexOf("（");
  const head = i < 0 ? "" : text.slice(0, i);
  const tail = i < 0 ? text : text.slice(i);
  const sorted = [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[()（）]/g, "\\$&"));
  const parts = sorted.length ? tail.split(new RegExp(`(${sorted.join("|")})`, "g")) : [tail];
  return html`${head}${parts.map((p) => (chosen.includes(p) && words.includes(p) ? html`<span class="circle">${p}</span>` : html`${p}`))}`;
}

const yn = (x: FormValues[string] | undefined) => circledTail("有・無", ["有", "無"], list(x));

function rowHtml(r: EquipRow, kind: EquipmentKind, o: FormValues, nameHeader: string): SafeHtml {
  const p = kind === "house" ? "h" : "u";
  if (r.kind === "group") return html`<tr><th colspan="4" class="group">${r.title}</th></tr>`;
  if (r.kind === "note") return html`<tr><th>備考</th><td colspan="3" style="height:14mm;white-space:pre-wrap">${str(o[`${p}${r.key}Text`]) ?? ""}</td></tr>`;
  if (r.kind === "blank") {
    return html`<tr><td>${val(str(o[`${p}${r.key}Name`]))}</td><td></td><td class="yn">${yn(o[p + r.key])}</td><td>${str(o[`${p}${r.key}Fault`]) ?? ""}</td></tr>`;
  }
  if (r.kind !== "equip") return html``;
  const details = (r.details ?? []).map((dt, i) => html`<div>${circledTail(dt.parts.join(""), dt.options ?? [], list(o[`${p}${r.key}D${i}`]))}</div>`);
  void nameHeader;
  return html`<tr><td>${r.name}</td><td>${details}
${r.place ? html`<div>設置箇所：${val(str(o[`${p}${r.key}Place`]), true)}</div>` : null}
${r.count ? html`<div>計${val(str(o[`${p}${r.key}Count`]))}${r.count}</div>` : null}
${r.safety ? html`<div>${EQUIP_SAFETY}　${yn(o[`${p}${r.key}S`])}</div>` : null}</td>
<td class="yn">${yn(o[p + r.key])}</td><td>${str(o[`${p}${r.key}Fault`]) ?? ""}</td></tr>`;
}

function tablesHtml(kind: EquipmentKind, o: FormValues): SafeHtml {
  const groups: { head: Extract<EquipRow, { kind: "table" }>; rows: EquipRow[] }[] = [];
  for (const r of EQUIPMENT_ROWS[kind]) {
    if (r.kind === "table") groups.push({ head: r, rows: [] });
    else groups[groups.length - 1].rows.push(r);
  }
  return html`${groups.map((g) => html`<h2>${g.head.title}</h2>
<table class="equip"><tr><th>${g.head.nameHeader}</th><th>${g.head.detailHeader}</th><th>設備の有無</th><th>${EQUIP_FAULT}</th></tr>
${g.rows.map((r) => rowHtml(r, kind, o, g.head.nameHeader))}</table>`)}`;
}

function propertyName(c: BusinessDocContext): string | null {
  const s = c.deal.propertySnapshot;
  return [s.buildingName, s.roomNo && `${s.roomNo}号室`].filter(Boolean).join(" ") || s.address || null;
}

const baseOf = (c: BusinessDocContext) => c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;

/** 土地だけの物件には出さない(設計 §4.8)。種別が決まらない取引では出す。 */
export const equipmentApplies = (c: BusinessDocContext) => baseOf(c) !== "land";

export function equipmentDefaults(c: BusinessDocContext): FormValues {
  return { ...emptyFormValues(EQUIPMENT_FORM), kind: baseOf(c) === "unit" ? "unit" : "house", withGuide: "付ける" };
}

export function equipmentMissing(c: BusinessDocContext): string[] {
  return propertyName(c) ? [] : ["物件名"];
}

/** 付帯設備表(設計 第2段階 §4.8)。頭の説明文・注２・署名の文は取り出したセルの文字をそのまま使う(段F の決めたこと 5)。 */
export function buildEquipment(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const kind = kindOf(o);
  const src = SOURCES[kind];
  const title = `付帯設備表（${EQUIPMENT_KIND_LABELS[kind]}）`;
  const cell = (prefix: string) => src.formCells.find((x) => x.startsWith(prefix)) ?? "";
  const name = propertyName(c);
  const guide = o.withGuide !== "付けない" ? html`
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.coverTitle}</h1>${src.cover.map((p) => html`<p>${p}</p>`)}</div>
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.guideTitle}</h1>
${src.guide.map((b) => (b.kind === "note" ? html`<p>${b.text}</p>` : html`<table><tr><th style="width:30%">${b.item}</th><td style="white-space:pre-wrap">${b.text}</td></tr></table>`))}</div>` : null;
  const body = html`<style>${raw(CSS)}</style>
<h1 style="font-size:14pt;letter-spacing:0">${title}</h1>
<div class="right">（物件名：${name ?? ""}）</div>
<div class="notes"><p>${cell("「設備の有無」欄に")}</p></div>
${tablesHtml(kind, o)}
<div class="notes"><p style="font-size:8pt">${cell("※注２")}</p></div>
<p class="right" style="margin-top:4mm">年　　　月　　　日</p>
<p>${cell("本物件の付帯設備が上記のとおりであることを")}</p>
<table class="sign"><tr><th style="width:18%">＜売主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
<p>${cell("上記のとおり、売主より告知を受けました")}</p>
<table class="sign"><tr><th style="width:18%">＜買主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
${guide}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [{ label: "書類", value: title }, { label: "物件名", value: name }, ...formValueRows(EQUIPMENT_FORM, o)],
  };
}

export { equipLabel };
```

⚠注意点:
- テストの「Excel の行」の期待値 `{ label: "給湯器", value: "有" }` は、設備の項目が `sub: true` で、その上に部門の行(「給湯関係」)があることを前提にしている。そのため、段E の `formValueRows` では「給湯関係 給湯器」になる。期待値は、実際の値(「給湯関係 給湯器」)に合わせて直してよい(台帳に書く)。
- 丸の数のテストは、設備の有無・特定保守製品・内容の言葉の丸だけを数える。別表など、ほかに丸を付ける所は無い。
- `void nameHeader` は使わない引数を lint が拒むときだけ置く。拒まなければ引数ごと外してよい。

`registry.ts`:
1. import:
```ts
import { EQUIPMENT_FORM } from "./forms/equipment";
import { buildEquipment, equipmentApplies, equipmentDefaults, equipmentMissing } from "./business/equipment";
```
2. `const equipmentOptionsSchema = formValuesSchema(EQUIPMENT_FORM);`
3. `disclosure` の行の次に:
```ts
  {
    key: "equipment",
    label: "付帯設備表",
    group: "contract",
    remember: true,
    form: EQUIPMENT_FORM,
    applies: (c) => equipmentApplies(c),
    missing: (c) => equipmentMissing(c),
    blocking: () => [],
    options: equipmentOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: equipmentDefaults(c) }),
    build: (c, o) => buildEquipment(c, equipmentOptionsSchema.parse(o)),
  },
```
`issue.ts` の `disclosure` の行の次に:
```ts
  equipment: { label: "付帯設備表", variants: { default: "" } },
```

- [ ] **Step 4: 通ることを確かめる・並びの期待値を直す**

Run: `npx vitest run src/lib/deals src/app`
Expected:
- 新しいテストは PASS(7 tests)。
- 並びの期待値(5b・出せる書類・前回の入力の読み込み対象)にだけ `"equipment"` を `"disclosure"` の次に足す。出せる書類の fixture の物件の種別が土地なら、出せる書類には足さない。台帳に書く。

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals
git commit -m "feat(deals): 付帯設備表(第2段階 段F)"
```

---

### Task 4: 走査・使い方ガイドとマニュアル・全部のゲート

- [ ] **Step 1: 走査に足す**

`business-docs-contract.test.ts`:
- 走査の一覧に `"equipment.ts"` を足す(`business/`)。
- 「告知書の項目の表に前の会社の語が無い」の it の中のファイルを、`forms/disclosure.ts` と `forms/equipment.ts` の2つにする(配列で回す)。

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS

- [ ] **Step 2: ガイドとマニュアル**

`public/docs/guide.html`:
- 「物件状況確認書［告知書］）」を「物件状況確認書［告知書］・付帯設備表）」にする。
- 告知書の `<li>` の後ろに1行足す:
```html
        <li><b>付帯設備表</b>は、発行の小窓の上のタブで土地建物用と区分所有建物用を選びます（初めは物件の種別から。土地だけの物件には出ません）。設備ごとに有・無、設備の内容（電気・ガスなど）、故障・不具合を入れられ、選んだものに丸が付きます。何も入れずに出せば手書き用になります</li>
```

`public/docs/manual.html`:
- 「物件状況確認書（告知書）・決済の書類」を「物件状況確認書（告知書）・付帯設備表・決済の書類」にする。
- 告知書の `<li>` の後ろに1行足す:
```html
              <li><b>付帯設備表</b>：土地だけの物件以外で出せます。発行の小窓の上のタブで、土地建物用と区分所有建物用を選びます（初めは物件の種別から）。全宅連の書式の表１（主要設備）と表２（その他設備）の設備の並びのとおりで、設備ごとに「設備の有無」・設備の内容（電気・ガス・石油など。選んだ言葉に丸が付きます）・設置箇所・台数・特定保守製品の表示・判明している故障・不具合を入れられます。書式の空欄の行には設備の名称を書けます。何も入れずに出せば手書き用になります。物件名だけが自動で入り、売主・買主の名前は署名の欄なので空欄です。「説明のページ」を「付ける」にすると、表紙と「ご記入にあたって」を後ろに付けます。</li>
```

- [ ] **Step 3: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals src/components/deals; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0 / eslint=0 / build=0。

時間切れのテストは、落ちたファイルだけを `--maxWorkers=1 --testTimeout=120000` で回し直す。

PDF の見た目(4列の表が何ページになるか)は、発注者の実機確認に回す。

- [ ] **Step 4: Commit**

```bash
git add src/lib/deals/documents/__tests__/business-docs-contract.test.ts public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 付帯設備表をガイドとマニュアルに"
```
