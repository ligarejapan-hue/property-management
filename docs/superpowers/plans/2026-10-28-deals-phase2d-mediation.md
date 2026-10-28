# 取引・帳票 第2段階 段D(媒介契約書3種類・媒介契約の前の説明書)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全宅連の書式どおりの媒介契約書(一般・専任・専属専任)と「不動産の売却を検討される皆様へ」(媒介契約の前の説明書)を、取引の値を入れて発行できるようにする。

**Architecture:**
- 全宅連の Word(.docx)から文面を取り出す小さなスクリプトを1本置く。取り出した文面は、書類ごとに TS ファイルにする。
  - 行をそろえるためだけの全角スペースは外し、書き込み欄(半角幅の空白)は「＿」にする。
  - 文の途中で切れた段落はつなぐ。
- 約款は、そのファイルから全文をそのまま出す。
- 契約書の頁も、同じファイルの段落を上から順に出す。空欄には、決めた目印(「（注１）」「締結後」など)のすぐ後ろに値を差し込む。値が無ければ下線の空欄にする。
  - こうすると、写した文面と出す文面が同じことをテストで確かめられる(手で写し直さない)。
- 依頼者・宅建業者の欄と別表は、組み立てで作る。
- 発行のときに入れる値は、段B の「項目の表」(`FormDef`)で持つ。入力欄も、その共通の部品で描く。

**Tech Stack:** Next.js 16 / React 19 / zod 4.6 / vitest(env=node)/ Python 3(取り出しのスクリプトだけ・手元で1回動かす・依存なし)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§2 の 6・7、§3.4、§4.5、§4.6)

## Global Constraints

- 表・列は足さない(migration なし)。npm の依存も足さない。
- 約款と書式の文面は、全宅連の書式から**一字も変えずに**写す。ただし、行をそろえるためだけの全角スペースと、書き込み欄の空白は文面に含めない(この計画の「決めたこと」1)。写した文面は書類ごとに1つのファイルにまとめ、ファイルの先頭に、どこから写したか(ファイル名と作成日・更新日)を書く。
- 写した文面が元と同じかをテストで守る(文面の指紋をテストに持ち、変えたら落ちる)。
- 社名・代表者・所在地・免許番号は、今の会社情報(`CompanyProfile`)と取引の設定(`representativeTitle`・`representativeName`)から入れる。
- 署名・押印の欄は空欄で出す。角印は付けない。
- 前の会社の名前・リースバックの語を使わない(走査テスト)。テストに実在の人の名前・住所を使わない。
- 画面の文言は平易な日本語にする。

## Review Focus

1. 値を何も入れずに発行する(手書き用)。期待する動き: 文面は元のまま全部出る。空欄は下線になる。Task 2 で「出した文面から下線を除くと、写した文面と一字も違わない」を固定する。
2. 依頼者(売却=売主・購入=買主)がいない取引。期待する動き: 依頼者の欄は空けて出し、出す前の確認に「依頼者」が出る。Task 2 で固定する。
3. 専任・専属専任の報告の頻度、指定流通機構への登録の日数に、法の決まりを超える値を入れる。期待する動き: 選べない(選択肢が法の範囲だけ)。サーバーも 422 で止める。Task 2 で固定する。
4. 名前・住所・特約に `<` などが入っている。期待する動き: エスケープされて出る。Task 2 で固定する。
5. 前回の入力(remember)が別の型の書類の値を持つ。期待する動き: 型ごとに別の書類なので混ざらない。形が合わなければ捨てる(段A の仕組み)。Task 2 で、型ごとに鍵が違うことを固定する。

## 決めたこと(この計画での読み替え)

1. **行をそろえるための全角スペースは写さない**。全宅連の Word には、行の折り返しをそろえるために、文の途中に全角スペースが入っている(例:「当事者　が契約の」)。PDF では行の折り返しが変わるので、そのまま写すと文の途中に変な空きが出る。
   - 外すのは、段落の先頭の番号(「第１条」「一」「２」「イ」「注１」「＊」)の後ろの1つを除く、全角・半角のスペース。書き込み欄の半角幅の空白(U+2002)は「＿」にしてから、差し込みの目印に使う。
   - 外した後で、3つの型の共通の段落が一字も違わないことをテストで確かめる。
   - コスト: 外すべきでない空きを外していた場合、その1か所を直して指紋を取り直す。
2. **媒介契約書は、型ごとに別の書類にする**(一覧に「媒介契約書(一般)」「媒介契約書(専任)」「媒介契約書(専属専任)」の3つを出す)。設計は「発行のときに契約の型を選ぶ」だが、型によって入力欄が違うため、書類を分けたほうが入力欄が単純になり、前回の入力も型ごとに残せる。コスト: 一覧のボタンが2つ増える。
3. **報告の頻度・登録の日数・有効期間は、法の範囲だけを選択肢にする**。
   - 頻度: 専任は「２週間に１」「１週間に１」、専属専任は「１週間に１」。
   - 登録の日数: 専任は１〜７日、専属専任は１〜５日。
   - 有効期間: １〜３ヶ月。
   - 初めの値は、それぞれいちばん長い(緩い)もの。こうすると、法の決まりより少ない頻度などは入れられない(設計 §4.5)。
4. **「売却・購入・交換」と「有・無」は、選んだほうを丸で囲んで出す**(文面の文字は変えない)。選んでいなければ丸なしで、手で丸を付けられる。
5. **別表**の値は、取引の物件の写しから入れる。
   - 所在地: 住所(地番があれば添える)
   - 土地の公簿面積: 写しの土地面積(実測は空欄)
   - 権利内容: 土地の権利
   - 構造・延面積(区分は専有面積)・間取り(区分はタイプ)、名称・号室
   - 媒介価額: 総額=売買価格・消費税=建物の消費税・本体=その差
   - 地目・種類・建築面積・共有持分は写しに無いので空欄
   - 「購入」の依頼でも同じ別表を使う(書式の注のとおり、別の別表は使わなくてよい)。
6. **約定報酬額の初めの値**は、取引の計算の仲介手数料(税抜き)と、その消費税(税込−税抜)にする。発行のときに直せる(文字で持つ)。
7. **説明書の文面**は、Word の段落の切れ目(「当事者／の間に立って」「権利調／査等」など)をつないで1つのファイルに書く。文面の文字は変えない。会社名と担当者を下に添える。

---

### Task 1: 全宅連の Word から文面を取り出す(スクリプト+生成ファイル+指紋)

**Files:**
- Create: `scripts/deals/extract-zentaku-mediation.py`
- Create(スクリプトが生成): `src/lib/deals/documents/texts/mediation-general.ts`、`mediation-exclusive.ts`、`mediation-dedicated.ts`
- Create: `src/lib/deals/documents/texts/mediation-types.ts`
- Test: `src/lib/deals/documents/__tests__/mediation-texts.test.ts`(新規)

**Interfaces:**
- Produces: `MediationText`(`{ source; created; modified; title; contract: string[]; clausesTitle; clauses: string[] }`)、`MEDIATION_GENERAL`・`MEDIATION_EXCLUSIVE`・`MEDIATION_DEDICATED`

- [ ] **Step 1: 型を書く**

`src/lib/deals/documents/texts/mediation-types.ts`:

```ts
/** 全宅連の媒介契約書から写した文面(設計 第2段階 §3.4)。scripts/deals/extract-zentaku-mediation.py が作る。 */
export interface MediationText {
  /** 元の Word のファイル名と、その作成日・更新日。 */
  source: string;
  created: string;
  modified: string;
  /** 題名(例: 専任媒介契約書)。 */
  title: string;
  /** 契約書の頁の段落(依頼者・宅建業者の欄と日付の行は除く・書き込み欄は「＿」)。 */
  contract: string[];
  /** 約款の題名と段落。 */
  clausesTitle: string;
  clauses: string[];
}
```

- [ ] **Step 2: スクリプトを書く**

`scripts/deals/extract-zentaku-mediation.py`:

```python
"""
全宅連の媒介契約書(Word)から文面を取り出して TS にする(設計 第2段階 §3.4・段D の計画 Task 1)。
手元で1回動かす: python -X utf8 -I scripts/deals/extract-zentaku-mediation.py <全宅書式のフォルダ>
出力: src/lib/deals/documents/texts/mediation-{general,exclusive,dedicated}.ts(手で直さない)

整え方(計画「決めたこと」1):
- 段落の先頭の番号(第１条・一・２・イ・注１・＊)の後ろの全角スペース1つは残し、それ以外の全角・半角スペースは外す
- 書き込み欄の半角幅の空白(U+2002)は「＿」1つにする
- 文の途中で切れた段落はつなぐ
- 依頼者・宅建業者の欄と日付の行(7段落)は入れない(組み立てで作る)。別表は入れない
⚠ 読むのは自分の手元の全宅連の書式だけ(信頼できるファイル)。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DC = "{http://purl.org/dc/terms/}"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src/lib/deals/documents/texts"
FILES = [
    ("182_ippan.docx", "mediation-general.ts", "MEDIATION_GENERAL", "一般"),
    ("180_sennin.docx", "mediation-exclusive.ts", "MEDIATION_EXCLUSIVE", "専任"),
    ("181_senzoku.docx", "mediation-dedicated.ts", "MEDIATION_DEDICATED", "専属専任"),
]
MARK = re.compile(r"^(第[０-９0-9]+条|[０-９0-9]{1,2}|[一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)\u3000")
PARTY = re.compile(r"^(＿?年＿月＿日|甲・依頼者住所|氏名㊞|乙・宅地建物取引業者商号（名称）|代表者㊞|主たる事務所の所在地|免許証番号＿（＿）第＿号)$")
NO_JOIN = {"依頼の内容", "売却・購入・交換", "備考"}
WORD_END = re.compile(r"[ぁ-んァ-ヶ一-龠]$")


def raw_paragraphs(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
        core = ET.fromstring(z.read("docProps/core.xml"))
    paras = ["".join(e.text or "" for e in p.iter(W + "t")) for p in root.iter(W + "p")]
    created = core.find(DC + "created").text[:10]
    modified = core.find(DC + "modified").text[:10]
    return paras, created, modified


def squeeze(t):
    return re.sub(r"[\u3000 \u2002]", "", t)


def clean(t):
    body = t.strip(" \u3000\u2002\n")
    if not body:
        return None
    m = MARK.match(body)
    head, rest = (m.group(1), body[m.end():]) if m else ("", body)
    rest = re.sub("\u2002+", "＿", rest)
    rest = re.sub("[\u3000 ]+", "", rest)
    return f"{head}\u3000{rest}" if head else rest


def join_broken(lines):
    out = []
    for t in lines:
        prev = out[-1] if out else None
        if (prev is not None and WORD_END.search(prev) and prev not in NO_JOIN and not MARK.match(prev)
                and not prev.startswith("・") and not MARK.match(t) and not t.startswith("・")):
            out[-1] = prev + t
        else:
            out.append(t)
    return out


def extract(path, kind):
    paras, created, modified = raw_paragraphs(path)
    title = f"{kind}媒介契約書"
    clauses_title = f"{kind}媒介契約約款"
    i_title = next(i for i, p in enumerate(paras) if squeeze(p) == title)
    i_table = next(i for i, p in enumerate(paras) if squeeze(p) == "別表")
    i_clauses = next(i for i, p in enumerate(paras) if squeeze(p) == clauses_title)
    head = [c for c in (clean(p) for p in paras[:i_title]) if c]
    body = [c for c in (clean(p) for p in paras[i_title + 1:i_table]) if c]
    dropped = [c for c in body if PARTY.match(c)]
    assert len(dropped) == 7, (path, dropped)
    contract = join_broken(head + [c for c in body if not PARTY.match(c)])
    clauses = join_broken([c for c in (clean(p) for p in paras[i_clauses + 1:]) if c])
    return {"created": created, "modified": modified, "title": title, "contract": contract, "clausesTitle": clauses_title, "clauses": clauses}


def write(src_name, out_name, const, kind, d):
    j = lambda v: json.dumps(v, ensure_ascii=False)
    lines = [
        "// 生成: scripts/deals/extract-zentaku-mediation.py(手で直さない)",
        "/**",
        f" * 全宅連の書式「{kind}媒介契約書」から写した文面(設計 第2段階 §3.4)。",
        f" * 元: 全宅書式/{src_name}(作成 {d['created']}・更新 {d['modified']})。",
        " * 行をそろえるための全角スペースは外し、書き込み欄(半角幅の空白)は「＿」にした。文の途中で切れた段落はつないだ。そのほかは元のまま。",
        " * 依頼者・宅建業者の欄と日付の行、別表は、組み立てで作るので入れていない。",
        " */",
        'import type { MediationText } from "./mediation-types";',
        "",
        f"export const {const}: MediationText = {{",
        f"  source: {j(src_name)},",
        f"  created: {j(d['created'])},",
        f"  modified: {j(d['modified'])},",
        f"  title: {j(d['title'])},",
        "  contract: [",
        *[f"    {j(t)}," for t in d["contract"]],
        "  ],",
        f"  clausesTitle: {j(d['clausesTitle'])},",
        "  clauses: [",
        *[f"    {j(t)}," for t in d["clauses"]],
        "  ],",
        "};",
        "",
    ]
    (OUT / out_name).write_text("\n".join(lines), encoding="utf8", newline="\n")


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for src_name, out_name, const, kind in FILES:
        d = extract(folder / src_name, kind)
        write(src_name, out_name, const, kind, d)
        print(out_name, len(d["contract"]), len(d["clauses"]))
```

- [ ] **Step 3: 動かして、生成されたファイルを読む**

```bash
python -X utf8 -I scripts/deals/extract-zentaku-mediation.py "C:/Users/issin/Desktop/Ligare Japan/不動産関係/営業ツール/全宅書式"
```
Expected:
- 3行出る。約款の段落数は、一般・専任・専属専任で 70 前後。
- 生成された3つのファイルを開いて読み、次を確かめる。
  - 先頭の段落は「この媒介契約は、国土交通省が定めた標準媒介契約約款に基づく契約です。」になっている。
  - 「・専属専任媒介契約型式」から「依頼者甲は」の前までが、3つで同じになっている。
  - 約款の最後は「２　この約款の各条項の定めに反する特約で甲に不利なものは無効とします。」になっている。
- 変なつなぎ・切れが見つかったら、スクリプトの `NO_JOIN` か `join_broken` を直して動かし直す。直したことは台帳にルーリングとして書く。

- [ ] **Step 4: 指紋のテストを書く(生成の後に値を固定する)**

`src/lib/deals/documents/__tests__/mediation-texts.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_DEDICATED } from "../texts/mediation-dedicated";

const ALL = { general: MEDIATION_GENERAL, exclusive: MEDIATION_EXCLUSIVE, dedicated: MEDIATION_DEDICATED };
const hash = (xs: readonly string[]) => createHash("sha256").update(xs.join("\n")).digest("hex");
/** 型の名前を伏せる(3つの型で同じはずの段落を比べるため)。 */
const anon = (s: string) => s.replace(/専属専任媒介契約|専任媒介契約|一般媒介契約/g, "X媒介契約");
const block = (xs: readonly string[]) => xs.slice(xs.indexOf("・専属専任媒介契約型式"), xs.findIndex((p) => p.startsWith("依頼者甲は")));

/**
 * 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、文面が変わった=全宅連の書式と見比べてから値を直す。
 * ⚠値は Task 1 Step 5 で、生成したファイルから取って書く。
 */
const FINGERPRINTS: Record<keyof typeof ALL, { contract: string; clauses: string }> = {
  general: { contract: "", clauses: "" },
  exclusive: { contract: "", clauses: "" },
  dedicated: { contract: "", clauses: "" },
};

describe("全宅連の媒介契約書から写した文面", () => {
  it("どこから写したかを持つ(作成日・更新日)", () => {
    for (const t of Object.values(ALL)) {
      expect(t.source).toMatch(/^18[012]_\w+\.docx$/);
      expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(MEDIATION_GENERAL.title).toBe("一般媒介契約書");
    expect(MEDIATION_EXCLUSIVE.clausesTitle).toBe("専任媒介契約約款");
    expect(MEDIATION_DEDICATED.title).toBe("専属専任媒介契約書");
  });

  it("文面の指紋が変わっていない", () => {
    for (const [k, t] of Object.entries(ALL) as [keyof typeof ALL, (typeof ALL)[keyof typeof ALL]][]) {
      expect({ contract: hash(t.contract), clauses: hash(t.clauses) }, k).toEqual(FINGERPRINTS[k]);
    }
  });

  it("行をそろえる空き・書き込み欄の空白が残っていない(番号の後ろの1つだけ)", () => {
    for (const t of Object.values(ALL)) {
      for (const p of [...t.contract, ...t.clauses]) {
        expect(p, p).not.toMatch(/[ \u2002]/);
        expect(p.replace(/^(第[０-９0-9]+条|[０-９0-9]{1,2}|[一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)\u3000/, ""), p).not.toContain("\u3000");
      }
    }
  });

  it("3つの型で同じはずの段落が一字も違わない(整え方の確かめ)", () => {
    const b = block(MEDIATION_EXCLUSIVE.contract);
    expect(b.length).toBe(10);
    expect(block(MEDIATION_GENERAL.contract)).toEqual(b);
    expect(block(MEDIATION_DEDICATED.contract)).toEqual(b);
    const first = (t: (typeof ALL)[keyof typeof ALL]) => anon(t.clauses.find((p) => p.startsWith("第１条"))!);
    expect(first(MEDIATION_GENERAL)).toBe(first(MEDIATION_EXCLUSIVE));
    expect(first(MEDIATION_DEDICATED)).toBe(first(MEDIATION_EXCLUSIVE));
    expect(first(MEDIATION_EXCLUSIVE)).toBe(
      "第１条　この約款は、宅地又は建物の売買又は交換のX媒介契約について、当事者が契約の締結に際して定めるべき事項及び当事者が契約の履行に関して互いに遵守すべき事項を明らかにすることを目的とします。",
    );
  });

  it("最初と最後の段落", () => {
    for (const t of Object.values(ALL)) {
      expect(t.contract[0]).toBe("この媒介契約は、国土交通省が定めた標準媒介契約約款に基づく契約です。");
      expect(t.clauses.at(-1)).toBe("２　この約款の各条項の定めに反する特約で甲に不利なものは無効とします。");
    }
  });

  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
```

- [ ] **Step 5: 指紋を固定して、通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/mediation-texts.test.ts`
Expected:
- 1回目: 「文面の指紋が変わっていない」だけが落ち、実際の値が出る。ほかは PASS。
- 出た値を `FINGERPRINTS` に書き写す。
- 2回目: 全部 PASS(6 tests)。

⚠指紋は「固定する」ためのテストなので、生成の後で値を入れる(台帳に書く)。

- [ ] **Step 6: Commit**

```bash
git add scripts/deals/extract-zentaku-mediation.py src/lib/deals/documents/texts src/lib/deals/documents/__tests__/mediation-texts.test.ts
git commit -m "feat(deals): 全宅連の媒介契約書の文面を写す(第2段階 段D)"
```

---

### Task 2: 媒介契約書(一般・専任・専属専任)

**Files:**
- Create: `src/lib/deals/documents/forms/mediation.ts`(入力欄の項目の表・型ごと)
- Create: `src/lib/deals/documents/business/mediation.ts`(組み立て)
- Modify: `src/lib/deals/documents/registry.ts`(`seller_survey` の次に3行)
- Modify: `src/lib/deals/documents/issue.ts`(`DEAL_DOC_TYPES` に3行)
- Test: `src/lib/deals/documents/__tests__/business-docs-mediation.test.ts`(新規)、既存の一覧の並びの期待値

**Interfaces:**
- Consumes: Task 1 の `MEDIATION_*`。段B の `FormDef`・`formValuesSchema`・`emptyFormValues`。`ymdJa` は段A。
- Produces:
  - `MediationKind = "general" | "exclusive" | "dedicated"`
  - `MEDIATION_FORMS: Record<MediationKind, FormDef>`
  - `mediationDefaults(kind, c)`・`mediationMissing(kind, c)`
  - `fillSlots(text, slots): SafeHtml`
  - `buildMediation(kind, c, o)`
  - 一覧表のキー `mediation_general`・`mediation_exclusive`・`mediation_dedicated`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-mediation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { emptyFormValues } from "../forms/values";
import { MEDIATION_FORMS } from "../forms/mediation";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "s", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1" });
const BUYER = party({ id: "b", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const deal: DealView = {
  id: "d", dealNo: "2026-0051", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "house", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null,
  price: 30_000_000, buildingTax: 1_000_000, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハウス<b>", address: "架空県架空市2-2", lotNumber: "2番2", landArea: 120.5, floorArea: 95.2, structure: "木造2階建", layout: "4LDK", landRight: "ownership" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const settings = { ...resolveDealSettings(null), representativeTitle: "代表取締役", representativeName: "架空 太郎" };
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings, company, rateRows, today: "2026-10-28", logo: null, seal: "data:image/png;base64,c2VhbA==",
  staff: { sales: "架空 営業", ops: null },
});
const KEYS = ["mediation_general", "mediation_exclusive", "mediation_dedicated"] as const;
const doc = (k: string) => businessDocOf(k)!;
/** タグを外して、HTML の文字参照を戻す。 */
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

describe("媒介契約書(第2段階 §4.5)", () => {
  it("「契約・媒介の書類」の売主属性調査書の次に3つ・仲介の取引だけ・前回の入力を型ごとに引き継ぐ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    const at = keys.indexOf("seller_survey");
    expect(keys.slice(at + 1, at + 4)).toEqual([...KEYS]);
    expect(KEYS.map((k) => doc(k).label)).toEqual(["媒介契約書(一般)", "媒介契約書(専任)", "媒介契約書(専属専任)"]);
    for (const k of KEYS) {
      expect(doc(k).group).toBe("contract");
      expect(doc(k).remember).toBe(true);
      expect(doc(k).form).toBe(MEDIATION_FORMS[k.replace("mediation_", "") as keyof typeof MEDIATION_FORMS]);
      expect(doc(k).applies(ctx())).toBe(true);
      expect(doc(k).applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(false);
    }
    expect(dealDocumentTitle("mediation_exclusive", "default")).toBe("媒介契約書(専任)");
  });

  it("初めの値: 依頼の内容は取引の側から・報告と登録と有効期間は法の範囲でいちばん長いもの・報酬は計算の仲介手数料", () => {
    const v = doc("mediation_exclusive").defaults(ctx()).values;
    expect(v.requestKind).toBe("sale");
    expect(v.reportMethod).toBe("document");
    expect(v.reportFrequency).toBe("２週間に１");
    expect(v.registerDays).toBe("7");
    expect(v.months).toBe("3");
    expect(v.feeExcl).toMatch(/^[\d,]+$/);
    expect(v.feeTax).toMatch(/^[\d,]+$/);
    expect(doc("mediation_dedicated").defaults(ctx()).values).toMatchObject({ reportFrequency: "１週間に１", registerDays: "5" });
    expect(doc("mediation_general").defaults(ctx({ ...deal, tradeSide: "buyer" })).values.requestKind).toBe("purchase");
  });

  it("法の範囲を超える頻度・日数・月数は選べない(サーバーも断る)", () => {
    const base = { ...emptyFormValues(MEDIATION_FORMS.dedicated) };
    expect(doc("mediation_dedicated").options.safeParse({ ...base, reportFrequency: "２週間に１" }).success).toBe(false);
    expect(doc("mediation_dedicated").options.safeParse({ ...base, registerDays: "7" }).success).toBe(false);
    expect(doc("mediation_exclusive").options.safeParse({ ...base, months: "4" }).success).toBe(false);
    expect(doc("mediation_exclusive").options.safeParse({ ...emptyFormValues(MEDIATION_FORMS.exclusive), registerDays: "8" }).success).toBe(false);
  });

  it("空欄の確認: 依頼者・物件の所在地・売買価格", () => {
    expect(doc("mediation_exclusive").missing(ctx())).toEqual([]);
    expect(doc("mediation_exclusive").missing(ctx({ ...deal, parties: [BUYER], price: null, propertySnapshot: EMPTY_SNAPSHOT }))).toEqual(["依頼者", "物件の所在地", "売買価格"]);
  });

  it("全部空欄で出しても、契約書の頁と約款の文面は写した文面と一字も違わない(下線を除く)", () => {
    const h = doc("mediation_exclusive").build(ctx(), emptyFormValues(MEDIATION_FORMS.exclusive)).html;
    const t = text(h);
    for (const p of MEDIATION_EXCLUSIVE.contract) expect(t, p).toContain(p.replace(/＿/g, ""));
    for (const p of MEDIATION_EXCLUSIVE.clauses) expect(t, p).toContain(p);
    expect(t).toContain("専任媒介契約約款");
    expect(h).not.toContain("c2VhbA==");
  });

  it("入れた値は目印のすぐ後ろに差し込む・選んだものは丸で囲む", () => {
    const o = {
      ...emptyFormValues(MEDIATION_FORMS.exclusive), requestKind: "sale", reportMethod: "email", reportFrequency: "１週間に１", registryName: "架空流通機構",
      registerDays: "5", inspection: "no", inspectionReason: "<築古>", months: "3", expiry: "2027年1月31日", feeExcl: "1,056,000", feeTax: "105,600",
      feeTiming: "売買契約の締結時に半額、決済時に残額", specialTerms: "特になし",
    };
    const h = doc("mediation_exclusive").build(ctx(), o).html;
    const t = text(h);
    expect(t).toContain("（注１）電子メールにより、（注２）１週間に１回以上");
    expect(t).toContain("（注３）架空流通機構に");
    expect(t).toContain("（注４）5日以内");
    expect(t).toContain("＊　<築古>");
    expect(h).toContain("&lt;築古&gt;");
    expect(t).toContain("この媒介契約締結後3ヶ月（2027年1月31日まで）");
    expect(t).toContain("（消費税及び地方消費税抜き報酬額）1,056,000円と（消費税額及び地方消費税額の合計額）105,600円");
    expect(t).toContain("売買契約の締結時に半額、決済時に残額とします。");
    expect(h).toMatch(/<span class="circle">売却<\/span>/);
    expect(h).toMatch(/<span class="circle">無<\/span>/);
  });

  it("依頼者・宅建業者の欄・別表(自動で入る値・エスケープ)", () => {
    const h = doc("mediation_exclusive").build(ctx(), emptyFormValues(MEDIATION_FORMS.exclusive)).html;
    expect(h).toContain("架空 一郎&lt;i&gt;");
    expect(h).toContain("架空県架空市1-1");
    expect(h).toContain("架空不動産株式会社");
    expect(h).toContain("代表取締役 架空 太郎");
    expect(h).toContain("架空県架空市3-3");
    expect(h).toContain("架空県知事(1)第00000号");
    expect(h).toContain("架空県架空市2-2 2番2");
    expect(h).toContain("120.5");
    expect(h).toContain("95.2");
    expect(h).toContain("30,000,000円");
    expect(h).toContain("29,000,000円");
    expect(h).toContain("1,000,000円");
    // 購入の依頼なら依頼者は買主
    const p = doc("mediation_exclusive").build(ctx(), { ...emptyFormValues(MEDIATION_FORMS.exclusive), requestKind: "purchase" }).html;
    expect(p).toContain("架空 花子");
  });

  it("一般: 依頼する乙以外の業者を行ごとに・指定流通機構への登録の有無", () => {
    const o = { ...emptyFormValues(MEDIATION_FORMS.general), otherAgents: "架空住宅 / 架空県架空市5-5\n架空商事 / 架空県架空市6-6", listing: "yes", listingName: "架空流通機構" };
    const h = doc("mediation_general").build(ctx(), o).html;
    expect(h).toContain("架空住宅");
    expect(h).toContain("架空県架空市6-6");
    expect(text(h)).toContain("架空流通機構");
    const blank = text(doc("mediation_general").build(ctx(), emptyFormValues(MEDIATION_FORMS.general)).html);
    for (const p of MEDIATION_GENERAL.contract) expect(blank, p).toContain(p.replace(/＿/g, ""));
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-mediation.test.ts`
Expected: FAIL(`../forms/mediation` が無い)

- [ ] **Step 3: 入力欄の項目の表を書く**

`src/lib/deals/documents/forms/mediation.ts`:

```ts
import type { FormChoice, FormDef, FormEntry } from "./types";

/** 媒介契約書の型(設計 第2段階 §4.5・計画 段D の決めたこと 2)。 */
export type MediationKind = "general" | "exclusive" | "dedicated";
export const MEDIATION_KIND_LABELS: Record<MediationKind, string> = { general: "一般", exclusive: "専任", dedicated: "専属専任" };

const range = (from: number, to: number): FormChoice[] => Array.from({ length: to - from + 1 }, (_, i) => ({ value: String(to - i), label: `${to - i}` }));
const YN: FormChoice[] = [{ value: "yes", label: "有" }, { value: "no", label: "無" }];

/** 法の範囲(宅建業法 34条の2): 報告の頻度・登録の日数(計画 段D の決めたこと 3)。 */
export const REPORT_FREQUENCIES: Record<"exclusive" | "dedicated", FormChoice[]> = {
  exclusive: [{ value: "２週間に１", label: "２週間に１回以上" }, { value: "１週間に１", label: "１週間に１回以上" }],
  dedicated: [{ value: "１週間に１", label: "１週間に１回以上" }],
};
export const REGISTER_DAYS: Record<"exclusive" | "dedicated", number> = { exclusive: 7, dedicated: 5 };

const common = (kind: MediationKind): FormEntry[] => [
  { kind: "section", title: "契約" },
  { kind: "item", key: "requestKind", label: "依頼の内容", choices: [{ value: "sale", label: "売却" }, { value: "purchase", label: "購入" }, { value: "exchange", label: "交換" }] },
  { kind: "item", key: "contractDate", label: "契約の日付", fields: [{ key: "contractDateText", label: "日付(例: 2026年11月1日)", max: 30 }] },
  { kind: "item", key: "months", label: "有効期間(月)", choices: range(1, 3), fields: [{ key: "expiry", label: "満了日(例: 2027年1月31日)", max: 30 }] },
  ...(kind === "general" ? [
    { kind: "item", key: "otherAgentsItem", label: "依頼する乙以外の宅地建物取引業者(1行に1社「商号 / 所在地」)", fields: [{ key: "otherAgents", label: "業者", max: 1000, lines: 3 }] },
    { kind: "item", key: "listing", label: "指定流通機構への登録の有無", choices: YN, fields: [{ key: "listingName", label: "指定流通機構の名称", max: 100 }] },
  ] satisfies FormEntry[] : [
    { kind: "item", key: "reportMethod", label: "業務の処理状況の報告の方法", choices: [{ value: "document", label: "文書" }, { value: "email", label: "電子メール" }] },
    { kind: "item", key: "reportFrequency", label: "報告の頻度", choices: REPORT_FREQUENCIES[kind] },
    { kind: "item", key: "registryItem", label: "登録する指定流通機構", fields: [{ key: "registryName", label: "名称", max: 100 }] },
    { kind: "item", key: "registerDays", label: "登録までの日数(契約の翌日から・休業日を除く)", choices: range(1, REGISTER_DAYS[kind]) },
  ] satisfies FormEntry[]),
  { kind: "item", key: "otherDutyItem", label: "そのほかの業務", fields: [{ key: "otherDuty", label: "内容", max: 200 }] },
  { kind: "item", key: "inspection", label: "建物状況調査を実施する者のあっせん", choices: YN, fields: [{ key: "inspectionReason", label: "「無」の理由(既存の住宅のとき)", max: 200 }] },
  { kind: "section", title: "報酬・特約" },
  { kind: "item", key: "feeItem", label: "約定報酬額", fields: [{ key: "feeExcl", label: "税抜き(円)", max: 20 }, { key: "feeTax", label: "消費税(円)", max: 20 }] },
  { kind: "item", key: "feeTimingItem", label: "約定報酬の受領の時期", fields: [{ key: "feeTiming", label: "時期", max: 200 }] },
  { kind: "item", key: "specialTermsItem", label: "特約事項", fields: [{ key: "specialTerms", label: "内容", max: 2000, lines: 4 }] },
];

export const MEDIATION_FORMS: Record<MediationKind, FormDef> = {
  general: { key: "mediation_general", entries: common("general") },
  exclusive: { key: "mediation_exclusive", entries: common("exclusive") },
  dedicated: { key: "mediation_dedicated", entries: common("dedicated") },
};
```

⚠「契約の日付」は選ぶものの無い項目で、書き込み欄 `contractDateText` だけを持つ(段B の部品は、項目の鍵と書き込み欄の鍵を別にする決まり)。

- [ ] **Step 4: 組み立てを書く**

`src/lib/deals/documents/business/mediation.ts`:

```ts
import { yen } from "../../calc/format";
import { html, raw, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { MEDIATION_FORMS, MEDIATION_KIND_LABELS, REGISTER_DAYS, REPORT_FREQUENCIES, type MediationKind } from "../forms/mediation";
import { emptyFormValues } from "../forms/values";
import type { FormValues } from "../forms/types";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_DEDICATED } from "../texts/mediation-dedicated";
import type { MediationText } from "../texts/mediation-types";
import { DASH, partiesOf, type BusinessDocContext, type ValueRow } from "./common";

const TEXTS: Record<MediationKind, MediationText> = { general: MEDIATION_GENERAL, exclusive: MEDIATION_EXCLUSIVE, dedicated: MEDIATION_DEDICATED };
const REQUEST_LABELS = { sale: "売却", purchase: "購入", exchange: "交換" } as const;
const BLANK = html`<span class="blank"></span>`;
const CSS = `.blank{display:inline-block;min-width:24mm;border-bottom:1px solid #333;height:1em;vertical-align:bottom}
.circle{border:1px solid #111;border-radius:50%;padding:0 .2em}
.contract p{margin:1mm 0}
.contract .item{padding-left:1em;text-indent:-1em}
.clauses{font-size:8.5pt;line-height:1.45;column-count:2;column-gap:6mm}
.clauses p{margin:0 0 1mm;text-indent:-1em;padding-left:1em}
.clauses .heading{text-indent:0;padding-left:0;font-weight:bold;margin-top:2mm}
.page{page-break-before:always}`;

const str = (v: FormValues[string] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
const val = (v: string | null): SafeHtml => (v ? html`${v}` : BLANK);

/** 依頼者の役割: 売却・交換=売主・購入=買主。 */
const clientRole = (o: FormValues) => (o.requestKind === "purchase" ? "buyer" : "seller");

export function mediationDefaults(kind: MediationKind, c: BusinessDocContext): FormValues {
  const b = c.calc.brokerage;
  return {
    ...emptyFormValues(MEDIATION_FORMS[kind]),
    requestKind: c.deal.tradeSide === "buyer" ? "purchase" : "sale",
    months: "3",
    ...(kind === "general" ? {} : {
      reportMethod: "document",
      reportFrequency: REPORT_FREQUENCIES[kind][0].value,
      registerDays: String(REGISTER_DAYS[kind]),
    }),
    feeExcl: b ? yen(b.excl) : null,
    feeTax: b ? yen(b.incl - b.excl) : null,
  };
}

export function mediationMissing(kind: MediationKind, c: BusinessDocContext, values?: Record<string, unknown>): string[] {
  const role = values?.requestKind === "purchase" || (!values && c.deal.tradeSide === "buyer") ? "buyer" : "seller";
  const out: string[] = [];
  if (!partiesOf(c.deal, role).length) out.push("依頼者");
  if (!c.deal.propertySnapshot.address) out.push("物件の所在地");
  if (c.deal.price === null) out.push("売買価格");
  void kind;
  return out;
}

/**
 * 段落の中の目印のすぐ後ろに値を差し込む(計画 段D の決めたこと 1)。
 * slot.after = 目印(空文字なら段落の頭)・slot.drop = 目印の後ろから外す書き込み欄(「＿」など)。
 * 目印が無い段落はそのまま(エスケープして)出す。
 */
export function fillSlots(text: string, slots: { after: string; drop?: string; value: SafeHtml }[]): SafeHtml {
  const parts: (string | SafeHtml)[] = [];
  let rest = text;
  for (const s of slots) {
    const i = s.after === "" ? 0 : rest.indexOf(s.after);
    if (i < 0) continue;
    const end = i + s.after.length;
    parts.push(rest.slice(0, end), s.value);
    rest = rest.slice(end);
    if (s.drop && rest.startsWith(s.drop)) rest = rest.slice(s.drop.length);
  }
  parts.push(rest.replace(/＿/g, ""));
  return html`${parts.map((p) => (typeof p === "string" ? html`${p}` : p))}`;
}

/** 「売却・購入・交換」「（有・無）」の選んだほうを丸で囲む(文字は変えない)。 */
function circled(text: string, words: string[], chosen: string | null): SafeHtml {
  const re = new RegExp(`(${words.join("|")})`, "g");
  return html`${text.split(re).map((p) => (words.includes(p) && p === chosen ? html`<span class="circle">${p}</span>` : html`${p}`))}`;
}

const isItem = (p: string) => /^([一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)\u3000/.test(p);

function contractParagraph(kind: MediationKind, p: string, o: FormValues, next: string | undefined): SafeHtml | null {
  const yn = (k: string) => (o[k] === "yes" ? "有" : o[k] === "no" ? "無" : null);
  if (p === "売却・購入・交換") return circled(p, ["売却", "購入", "交換"], typeof o.requestKind === "string" ? REQUEST_LABELS[o.requestKind as keyof typeof REQUEST_LABELS] ?? null : null);
  if (p.includes("建物状況調査を実施する者のあっせんの有無")) return circled(p, ["有", "無"], yn("inspection"));
  if (p === "＊") return html`＊　${val(str(o.inspectionReason))}`;
  if (p.includes("指定流通機構への登録の有無")) return html`${circled(p.replace(/＊$/, ""), ["有", "無"], yn("listing"))}　＊ ${val(str(o.listingName))}`;
  if (p.includes("（注１）")) {
    return fillSlots(p, [
      { after: "（注１）", drop: "＿", value: val(o.reportMethod === "email" ? "電子メール" : o.reportMethod === "document" ? "文書" : null) },
      { after: "（注２）", drop: "＿", value: val(str(o.reportFrequency)) },
    ]);
  }
  if (p.includes("（注３）")) {
    return fillSlots(p, [
      { after: "（注３）", drop: "＿", value: val(str(o.registryName)) },
      { after: "（注４）", drop: "＿", value: val(str(o.registerDays)) },
    ]);
  }
  if (p.includes("その他（")) return fillSlots(p, [{ after: "その他（", drop: "＿", value: val(str(o.otherDuty)) }]);
  if (p.includes("この媒介契約締結後")) {
    return fillSlots(p, [
      { after: "この媒介契約締結後", drop: "＿", value: val(str(o.months)) },
      { after: "ヶ月（", drop: "＿年＿月＿日", value: val(str(o.expiry)) },
    ]);
  }
  if (p.includes("（消費税及び地方消費税抜き報酬額）")) {
    return fillSlots(p, [
      { after: "（消費税及び地方消費税抜き報酬額）", drop: "＿", value: val(str(o.feeExcl)) },
      { after: "（消費税額及び地方消費税額の合計額）", drop: "＿", value: val(str(o.feeTax)) },
    ]);
  }
  if (p === "とします。") return fillSlots(p, [{ after: "", value: val(str(o.feeTiming)) }]);
  if (p === "（商号又は名称）（主たる事務所の所在地）") {
    const rows = (str(o.otherAgents) ?? "").split("\n").map((l) => l.split("/").map((x) => x.trim())).filter((r) => r[0]);
    return html`<table><tr><th>（商号又は名称）</th><th>（主たる事務所の所在地）</th></tr>
${rows.length ? rows.map((r) => html`<tr><td>${r[0]}</td><td>${r[1] ?? ""}</td></tr>`) : html`<tr><td style="height:8mm"></td><td></td></tr>`}</table>`;
  }
  if (/特約事項$/.test(p) && next === undefined) return html`${p}<div class="remarks" style="min-height:14mm;border:1px solid #999;padding:1.5mm 2mm">${str(o.specialTerms) ?? ""}</div>`;
  void kind;
  return null;
}

/** 依頼者・宅建業者の欄(書式の7行の代わり・署名押印は空欄)。 */
function partiesBlock(c: BusinessDocContext, o: FormValues): SafeHtml {
  const clients = partiesOf(c.deal, clientRole(o));
  const rep = [c.settings.representativeTitle, c.settings.representativeName].filter(Boolean).join(" ") || null;
  return html`<div class="right">${val(str(o.contractDateText))}</div>
<table>
<tr><th style="width:24%">甲・依頼者</th><td>${clients.length ? clients.map((p) => html`<div>住所 ${p.address ?? ""}<br>氏名 ${p.name}</div>`) : html`<div>住所<br>氏名</div>`}</td><td style="width:16mm;text-align:center">㊞</td></tr>
<tr><th>乙・宅地建物取引業者</th><td>商号（名称） ${c.company.nameJa}<br>代表者 ${rep ?? ""}<br>主たる事務所の所在地 ${c.company.address ?? ""}<br>免許証番号 ${c.company.license ?? ""}</td><td style="text-align:center">㊞</td></tr>
</table>`;
}

const area = (n: number | null) => (n === null ? "" : `${n}`);

/** 別表(計画 段D の決めたこと 5)。 */
function propertyTable(c: BusinessDocContext, o: FormValues): SafeHtml {
  const d = c.deal;
  const s = d.propertySnapshot;
  const unit = c.settings.propertyKinds.find((k) => k.key === d.propertyKind)?.base === "unit";
  const owners = partiesOf(d, "seller");
  const tax = d.buildingTax;
  const body = d.price !== null && tax !== null ? d.price - tax : null;
  const money = (n: number | null) => (n === null ? "" : `${yen(n)}円`);
  void o;
  return html`<h2>別表</h2>
<table>
<tr><th style="width:18%">所有者</th><td>${owners.map((p) => html`<div>住所 ${p.address ?? ""}　氏名 ${p.name}</div>`)}</td></tr>
<tr><th>登記名義人</th><td>住所　　　氏名</td></tr>
<tr><th>所在地</th><td>${[s.address, s.lotNumber].filter(Boolean).join(" ")}</td></tr>
${unit ? html`<tr><th>マンション</th><td>名称 ${s.buildingName ?? ""}　${s.roomNo ?? ""}号室<br>構造 ${s.structure ?? ""}<br>タイプ ${s.layout ?? ""}　専有面積 ${area(s.floorArea)}㎡<br>共有持分</td></tr>` : html`
<tr><th>土地</th><td>実測　　㎡　公簿 ${area(s.landArea)}㎡<br>地目 宅地・田・畑・山林・雑種地・その他（　　）<br>権利内容 ${circled("所有権・借地権", ["所有権", "借地権"], s.landRight === "ownership" ? "所有権" : s.landRight ? "借地権" : null)}</td></tr>
<tr><th>建物</th><td>建築面積　　㎡　種類<br>構造 ${s.structure ?? ""}　延面積 ${area(s.floorArea)}㎡<br>間取り ${s.layout ?? ""}</td></tr>`}
<tr><th>媒介価額</th><td>本体価額 ${money(body)}<br>消費税額及び地方消費税額の合計額 ${money(tax)}<br>総額 ${money(d.price)}</td></tr>
<tr><th>備考</th><td style="height:10mm"></td></tr>
</table>`;
}

/** 媒介契約書(設計 第2段階 §4.5)。契約書の頁と約款は写した文面をそのまま出す。署名・押印は空欄。 */
export function buildMediation(kind: MediationKind, c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const t = TEXTS[kind];
  const at = t.contract.findIndex((p) => p.startsWith("依頼者甲は"));
  const contract = t.contract.map((p, i) => {
    const filled = contractParagraph(kind, p, o, t.contract[i + 1]);
    const content = filled ?? html`${p.replace(/＿/g, "")}`;
    const para = html`<p class="${isItem(p) ? "item" : ""}">${content}</p>`;
    return i === at ? html`${para}${partiesBlock(c, o)}` : para;
  });
  const body = html`<style>${raw(CSS)}</style>
<h1>${t.title}</h1>
<div class="contract">${contract}</div>
${propertyTable(c, o)}
<div class="page"><h1>${t.clausesTitle}</h1>
<div class="clauses">${t.clauses.map((p) => html`<p class="${/^（.+）$/.test(p) ? "heading" : ""}">${p}</p>`)}</div></div>`;
  const clients = partiesOf(c.deal, clientRole(o));
  return {
    html: documentHtml({ title: t.title, font: "mincho", body }),
    rows: [
      { label: "書類", value: `${t.title}(${MEDIATION_KIND_LABELS[kind]})` },
      { label: "依頼の内容", value: typeof o.requestKind === "string" ? REQUEST_LABELS[o.requestKind as keyof typeof REQUEST_LABELS] ?? null : null },
      { label: "依頼者", value: clients.map((p) => p.name).join("・") || DASH },
      { label: "所在地", value: c.deal.propertySnapshot.address },
      { label: "媒介価額", value: c.deal.price },
      ...Object.entries(o).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => ({ label: k, value: v as string })),
    ],
  };
}
```

⚠注意点:
- 書式によって、目印のすぐ後ろが「＿」でない所がある(全角スペースだった空欄は外れている)。`drop` は、あれば外す。
- テストの「全部空欄で出しても、写した文面と一字も違わない」は、`fillSlots` が目印や文を落としていないことを確かめる。
- `yen` は `src/lib/deals/calc/format.ts` の、3桁区切りの数(円は付けない・`common.ts` と同じ import)。

- [ ] **Step 5: 一覧表と書類の名前**

`registry.ts`:
1. import:
```ts
import { MEDIATION_FORMS, MEDIATION_KIND_LABELS, type MediationKind } from "./forms/mediation";
import { buildMediation, mediationDefaults, mediationMissing } from "./business/mediation";
import { formValuesSchema } from "./forms/schema";
```
2. ファイルの関数として:
```ts
/** 媒介契約書(型ごとに1つ・仲介の取引だけ・設計 第2段階 §4.5)。 */
function mediationDef(kind: MediationKind): BusinessDocDef {
  const schema = formValuesSchema(MEDIATION_FORMS[kind]);
  return {
    key: `mediation_${kind}`,
    label: `媒介契約書(${MEDIATION_KIND_LABELS[kind]})`,
    group: "contract",
    remember: true,
    form: MEDIATION_FORMS[kind],
    applies: (c) => c.deal.businessType === "brokerage",
    missing: (c, v) => mediationMissing(kind, c, v),
    blocking: () => [],
    options: schema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: mediationDefaults(kind, c) }),
    build: (c, o) => buildMediation(kind, c, schema.parse(o)),
  };
}
```
3. `BUSINESS_DOCS` の `seller_survey` の行の次に:
```ts
  mediationDef("general"),
  mediationDef("exclusive"),
  mediationDef("dedicated"),
```

`issue.ts` の `DEAL_DOC_TYPES` の `seller_survey` の行の次に:
```ts
  mediation_general: { label: "媒介契約書(一般)", variants: { default: "" } },
  mediation_exclusive: { label: "媒介契約書(専任)", variants: { default: "" } },
  mediation_dedicated: { label: "媒介契約書(専属専任)", variants: { default: "" } },
```

- [ ] **Step 6: 通ることを確かめる・一覧の並びの期待値を直す**

Run: `npx vitest run src/lib/deals src/app`
Expected:
- 新しいテストは PASS(8 tests)。
- 一覧の並びを固定している既存のテストが落ちたら、並びの期待値にだけ3つのキーを `seller_survey` の次に足す。対象は 5b、出せる書類(仲介の取引の fixture)、前回の入力の読み込み対象(`docType: { in: [...] }`)。直したものは台帳に書く。
- 「写した文面と一字も違わない」が落ちたら、`contractParagraph` が文を落としていないかを見て、組み立てのほうを直す(文面のファイルは直さない)。

- [ ] **Step 7: Commit**

```bash
git add src/lib/deals
git commit -m "feat(deals): 媒介契約書(一般・専任・専属専任)(第2段階 段D)"
```

---

### Task 3: 媒介契約の前の説明書(売却用)

**Files:**
- Create: `src/lib/deals/documents/texts/sale-guide.ts`
- Create: `src/lib/deals/documents/business/sale-guide.ts`
- Modify: `registry.ts`(媒介契約書の3行の次に1行)・`issue.ts`
- Test: `src/lib/deals/documents/__tests__/business-docs-sale-guide.test.ts`(新規)

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SALE_GUIDE } from "../texts/sale-guide";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";
// fixture(deal・ctx)は business-docs-mediation.test.ts と同じものをこのファイルにも書く(tradeSide: "seller"・businessType: "brokerage")。

describe("媒介契約の前の説明書(売却用・第2段階 §4.6)", () => {
  it("写した文面の指紋とどこから写したか", () => {
    expect(SALE_GUIDE.source).toBe("178_baikaijizen_baikyaku-1.docx");
    expect(SALE_GUIDE.title).toBe("不動産の売却を検討される皆様へ（売却の媒介委託者用）");
    expect(SALE_GUIDE.intro[0]).toContain("当事者の間に立って");
    expect(SALE_GUIDE.related).toContain("ⅳ　表示に関する登記に関する権利調査等");
    const h = createHash("sha256").update(JSON.stringify([SALE_GUIDE.title, SALE_GUIDE.intro, SALE_GUIDE.flowTitle, SALE_GUIDE.sale, SALE_GUIDE.related])).digest("hex");
    expect(h).toBe("");  // ⚠ Task 3 Step 4 で値を入れる
  });
  it("媒介契約書の次・売主側か両手の仲介だけ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf("sale_guide")).toBe(keys.indexOf("mediation_dedicated") + 1);
    expect(businessDocOf("sale_guide")!.label).toBe("媒介契約の前の説明書(売却用)");
    expect(businessDocOf("sale_guide")!.group).toBe("contract");
    expect(businessDocOf("sale_guide")!.applies(ctx())).toBe(true);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, tradeSide: "both" }))).toBe(true);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, tradeSide: "buyer" }))).toBe(false);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(false);
    expect(dealDocumentTitle("sale_guide", "default")).toBe("媒介契約の前の説明書(売却用)");
  });
  it("1ページで文面をそのまま・会社名と担当者を添える", () => {
    const h = businessDocOf("sale_guide")!.build(ctx(), {}).html;
    for (const p of [...SALE_GUIDE.intro, ...SALE_GUIDE.sale, ...SALE_GUIDE.related]) expect(h, p).toContain(p);
    expect(h).toContain("架空不動産株式会社");
    expect(h).toContain("担当 架空 営業");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-sale-guide.test.ts`
Expected: FAIL(`../texts/sale-guide` が無い)

- [ ] **Step 3: 文面と組み立てを書く**

`src/lib/deals/documents/texts/sale-guide.ts`(Word の段落を、切れ目だけつないで写す。文字は変えない):

```ts
/**
 * 全宅連の書式「不動産の売却を検討される皆様へ（売却の媒介委託者用）」から写した文面(設計 第2段階 §3.4・§4.6)。
 * 元: 全宅書式/178_baikaijizen_baikyaku-1.docx。段落の途中の切れ目(「当事者／の間に立って」「具体的／な内容」「権利調／査等」)はつないだ。
 * 番号の後ろの空き(半角2つ)は全角1つにした。そのほかは元のまま。
 */
export const SALE_GUIDE = {
  source: "178_baikaijizen_baikyaku-1.docx",
  title: "不動産の売却を検討される皆様へ（売却の媒介委託者用）",
  intro: [
    "不動産の売却の媒介契約とは、宅地建物取引業者が不動産を売却しようとする者又は売買の当事者の双方との間で締結する契約で、宅地建物取引業者が不動産売買契約の当事者の間に立って、売買契約の成立に向けてあっせんすることを内容とします。",
    "不動産の売却は、おおむね１の手順を踏んで行われます。また、状況に応じて２のような手続も必要になります。",
    "以下の手続のうち、媒介契約により宅地建物取引業者が受託する範囲は通常１の部分ですが、各業者又は媒介契約の内容によって異なる場合がありますので、媒介業務の具体的な内容については、媒介契約に先立って担当に御確認ください。",
    "なお、宅地建物取引業者の媒介により不動産の売買契約が成立した場合には、宅地建物取引業法が定める上限の範囲内で報酬を申し受けます。",
  ],
  flowTitle: "＜不動産売却の流れ＞",
  saleTitle: "１　不動産の売却",
  sale: ["ⅰ　物件調査（基礎的調査）", "ⅱ　価格査定", "ⅲ　媒介契約の締結と書面の交付", "ⅳ　売買の相手方の探索", "ⅴ　売買の相手方との交渉", "ⅵ　売買契約の締結と書面の交付", "ⅶ　決済、引渡し　等"],
  relatedTitle: "２　不動産の売却に関連する行為",
  related: ["ⅰ　税務相談", "ⅱ　法律相談", "ⅲ　不動産鑑定評価", "ⅳ　表示に関する登記に関する権利調査等", "ⅴ　登記", "ⅵ　建物状況調査", "ⅶ　住宅性能評価", "ⅷ　土壌汚染調査", "ⅸ　リフォーム相談　等"],
} as const;
```

⚠ 書く前に、手元で Word の段落をもう一度取り出す(Task 1 の `raw_paragraphs` と同じ読み方)。そのうえで、上の文と1文ずつ見比べる。違いがあれば Word のほうに合わせ、台帳に書く。

`src/lib/deals/documents/business/sale-guide.ts`:

```ts
import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { SALE_GUIDE } from "../texts/sale-guide";
import type { BusinessDocContext, ValueRow } from "./common";

/** 媒介契約の前の説明書(売却用・設計 第2段階 §4.6)。全宅連の文面をそのまま1ページで出し、会社名と担当者を添える。 */
export function buildSaleGuide(c: BusinessDocContext): { html: string; rows: ValueRow[] } {
  const g = SALE_GUIDE;
  const staff = c.staff?.sales ?? null;
  const list = (title: string, xs: readonly string[]) => html`<div style="flex:1;border:1px solid #999;padding:2mm 3mm"><p style="margin:0 0 1mm;font-weight:bold">${title}</p>${xs.map((x) => html`<div>${x}</div>`)}</div>`;
  const body = html`
<h1 style="font-size:13pt;letter-spacing:0">${g.title}</h1>
${g.intro.map((p) => html`<p class="greeting">${p}</p>`)}
<h2>${g.flowTitle}</h2>
<div style="display:flex;gap:4mm">${list(g.saleTitle, g.sale)}${list(g.relatedTitle, g.related)}</div>
${companyBlock(c.company, c.logo)}
${staff ? html`<div class="right">担当 ${staff}</div>` : null}`;
  return {
    html: documentHtml({ title: g.title, font: "mincho", body }),
    rows: [{ label: "書類", value: g.title }, { label: "担当", value: staff }],
  };
}
```

`registry.ts`: import `buildSaleGuide`。媒介契約書の3行の次に:
```ts
  {
    key: "sale_guide",
    label: "媒介契約の前の説明書(売却用)",
    group: "contract",
    applies: (c) => c.deal.businessType === "brokerage" && (c.deal.tradeSide === "seller" || c.deal.tradeSide === "both"),
    missing: () => [],
    blocking: () => [],
    options: emptyOptions,
    defaults: () => ({ values: {} }),
    build: (c) => buildSaleGuide(c),
  },
```
`issue.ts`: `sale_guide: { label: "媒介契約の前の説明書(売却用)", variants: { default: "" } },`

- [ ] **Step 4: 指紋を固定して通す**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-sale-guide.test.ts`
Expected:
- 1回目: 指紋だけが落ちる。出た値を `toBe("")` に書き写す。
- 2回目: PASS(3 tests)。
- そのあと `npx vitest run src/lib/deals src/app` を回し、並びの期待値にだけ `sale_guide` を足す(Task 2 と同じ扱い)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals
git commit -m "feat(deals): 媒介契約の前の説明書(売却用)(第2段階 段D)"
```

---

### Task 4: 前の会社の語の走査・使い方ガイドとマニュアル・全部のゲート

- [ ] **Step 1: 走査に足す**

`business-docs-contract.test.ts` の走査の一覧(`["contract-guide.ts", "completion.ts", "prep-checklist.ts"]`)に、`"mediation.ts"` と `"sale-guide.ts"` を足す(どちらも `business/` の下)。

文面のファイル(`texts/`)は、Task 1・3 のテストで見ている。

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS

- [ ] **Step 2: ガイドとマニュアル**

`public/docs/guide.html`:
- 「契約の書類（契約のご案内・売主属性調査書［社内用］）」を「契約の書類（契約のご案内・売主属性調査書［社内用］・媒介契約書［一般・専任・専属専任］・媒介契約の前の説明書）」にする。
- 準備チェックリストの `<li>` の後ろに1行足す:
```html
        <li><b>媒介契約書</b>（一般・専任・専属専任）は、全宅連の書式の文面と約款をそのまま出し、依頼者・会社・物件・媒介価額・約定報酬額（初めは取引の仲介手数料）が入ります。報告の頻度や登録の日数は法の範囲から選びます。何も入れずに出せば手書き用になります</li>
```

`public/docs/manual.html`:
- 「売主属性調査書（社内用）・決済の書類」を「売主属性調査書（社内用）・媒介契約書（一般・専任・専属専任）・媒介契約の前の説明書・決済の書類」にする。
- 準備チェックリストの `<li>` の後ろに2行足す:
```html
              <li><b>媒介契約書（一般・専任・専属専任）</b>：仲介の取引で出せます。全宅連の書式（標準媒介契約約款）の文面と約款を一字も変えずに出し、依頼者（売却なら売主・購入なら買主）の住所と名前、会社の商号・代表者・所在地・免許証番号、別表（所在地・面積・構造・間取り・媒介価額）が入ります。発行のときに、依頼の内容・契約の日付・有効期間（１〜３ヶ月）・報告の方法と頻度（専任は２週間に１回以上、専属専任は１週間に１回以上の範囲）・指定流通機構と登録の日数（専任は７日以内、専属専任は５日以内）・建物状況調査のあっせんの有無・約定報酬額（初めは取引の仲介手数料）・受領の時期・特約事項を入れます。入れなかった欄は下線の空欄で出ます。署名・押印の欄は空欄です。</li>
              <li><b>媒介契約の前の説明書（売却用）</b>：売主側・両手の仲介で出せます。全宅連の「不動産の売却を検討される皆様へ」をそのまま1ページで出し、会社名と担当者を添えます。</li>
```

- [ ] **Step 3: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals src/components/deals; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0 / eslint=0 / build=0。

PC の負荷で時間切れになったテストは、落ちたファイルだけを `--maxWorkers=2 --testTimeout=120000` で回し直す。

PDF の見た目(2段組みの約款が何ページになるか)は、発注者の実機確認に回す。

- [ ] **Step 4: Commit**

```bash
git add src/lib/deals/documents/__tests__/business-docs-contract.test.ts public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 媒介契約書・説明書をガイドとマニュアルに"
```
