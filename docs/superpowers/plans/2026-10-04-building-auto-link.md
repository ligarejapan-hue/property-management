# 区分マンションの棟を自動で作ってつなぐ・物件名の候補 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件名を入れた区分マンションを、保存時に必ずどれか1つの棟へつなぐ(無ければ棟を作る)。入力時は既存の棟を候補に出し、表記の揺れで棟が分かれないようにする。

**Architecture:** 名前・町丁目の「比べる形」を純関数(`building-identity.ts`)にし、つなぐ先の判断も純関数(`decideBuildingLink`)にする。DB への適用は `applyBuildingLink(tx, …)` の1か所に集め、全部の保存の入口(新規・編集・貼り付け・Excel・CSV・取込行の確定・部屋を追加)が同じトランザクションの中でこれを呼ぶ。同時保存はアドバイザリロックで順番待ちにし、ロック後に読み直して判断する。

**Tech Stack:** Next.js App Router / Prisma(driver adapter=PrismaPg) / PostgreSQL / zod / vitest(env=node・SSR は renderToStaticMarkup)

**Spec:** `docs/superpowers/specs/2026-10-04-building-auto-link-design.md`(決定 D1〜D12 は発注者承認済み=再提案しない)

## Global Constraints

- 対象は **区分マンション(`apartment_unit`)だけ**(D5)。旧値 `unit`(区分(旧))は**今つながっている棟をそのまま残す**(外さない・作らない)。その他の種別は棟から外す。
- 正式名称は書き換えない。比べる形は**比べるときだけ**使う。棟の名前は最初に登録した表記のまま(D6)。
- つないだら物件名を**棟の正式な表記**にそろえる(D3)。
- 同じ棟とみなす範囲=**同じ町丁目**(D2)。丁目違いの同名棟は自動ではつながない。
- 同じ町丁目・同じ比べる形の棟が2件以上 → 部屋数最多(同数なら作成が古い方)へ link + 注意 `duplicate_names`(D9)。
- DB の一意制約は付けない(D10)。同時保存はアドバイザリロック `pg_advisory_xact_lock(hashtext('building-link:' || area_key || ':' || name_key)::bigint)`。**必ず `$executeRaw` + `::bigint`**(`$queryRaw` は void 列の型変換で落ちる=paste commit の前例コメント参照)。
- migration は ADD のみ: `buildings.name_key TEXT`・`buildings.area_key TEXT`・index `(area_key, name_key)`(D12)。
- 権限: 棟の作成・名前の変更・物件保存=`property:write`、候補 API=`property:read`。
- 監査ログの detail には件数・id・種別だけ。**物件の住所を入れない**。監査ログの action 名: `building.auto_create` / `property.building_link` / `property.building_relink` / `property.building_unlink` / `building.rename_propagate`。
- 生 SQL の uuid は小文字で比べる(入口の zod で `.toLowerCase()`)。
- UI 文言は平易な日本語。返答・PR本文も日本語。PR 番号で説明しない。
- テストは env の有無に依存させない。走査型テストは LF 正規化済み。
- 各 PR の前に全ゲート: `npx tsc --noEmit`=0 / `npx vitest run`(フルスイート) / `npx eslint <変更ファイル>`=0 / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。push ごとに CI の結論も見る。
- 新規依存は足さない。

## Review Focus

1. **編集で住所だけ直した旧値 `unit` の部屋** — 棟から外れてはいけない(`decideBuildingLink` が `keep` を返す)。→ Task 2 のテストに入れる。
2. **今つながっている棟と比べる形が同じ名前に打ち直した**(例 `第一`→`第１`)— 付け替えにならず、同じ棟のまま物件名だけ正式表記へ戻る。住所の丁目が棟と違っていても同じ。→ Task 2 のテストに入れる。
3. **ロック中に別の保存が同じ部屋を待っている**(物件の編集 × 棟の名前の反映)— 待ちの輪ができない。apply は棟の行を**ロックしない**(key の補完は `FOR UPDATE SKIP LOCKED`)。→ Task 3 のテスト(補完 SQL が SKIP LOCKED を含む)と Task 14 のテスト(棟の名前の反映は棟の行 → 部屋の行の順)に入れる。⚠段3の実装で順番を 部屋 → 棟 に変えた(販売図面の書き戻しと同じ向き・待ちの輪を防ぐ)。
4. **CSV で同じ新しい建物が続けて出てくる**(1行目で作った棟に2行目がつながる)— 「作る」の結果をキャッシュしない。→ Task 7 のテストに入れる。
5. **保存の応答が来る前に別の画面へ移る/候補の古い応答が後から届く** — 古い応答は捨てる(連番)。→ Task 10 のテスト(`isLatestRequest`)に入れる。

---

# 段 1(PR 1): 比べる形・判断・DB 適用・全入口・不具合 2 件・migration

画面は変えない(`buildingChoice` は送らない=常に auto)。

### Task 0: worktree の準備

worktree は作成済み: `C:\Users\issin\Desktop\Claude\property-management-worktrees\building-auto-link`(branch `feat/building-auto-link`・設計書 commit `e46fd890`)。

- [ ] **Step 1: 依存と生成型を入れる**

```bash
cd C:/Users/issin/Desktop/Claude/property-management-worktrees/building-auto-link
git fetch origin main && git rebase origin/main
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
```

- [ ] **Step 2: 基準のテストが緑であることを確かめる**

Run: `npx vitest run > /tmp/base.txt 2>&1; echo exit=$?`
Expected: `exit=0`。赤なら既存の問題として発注者に報告し、黙って進めない。

---

### Task 1: 比べる形と町丁目(`building-identity.ts`)

**Files:**
- Create: `src/lib/building-identity.ts`
- Test: `src/lib/__tests__/building-identity.test.ts`

**Interfaces:**
- Consumes: `normalizeBuildingName(input)`(`src/lib/normalize.ts`=NFKC・空白除去・小文字化)
- Produces:
  - `buildingNameKey(name: string | null | undefined): string | null`
  - `areaKey(address: string | null | undefined): string | null`
  - `buildingAddressFromUnit(address: string, buildingNumber: string | null | undefined): string`
  - `parseKanjiNumber(run: string): number | null`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/__tests__/building-identity.test.ts
import { describe, it, expect } from "vitest";
import {
  buildingNameKey,
  areaKey,
  buildingAddressFromUnit,
  parseKanjiNumber,
} from "@/lib/building-identity";

describe("parseKanjiNumber", () => {
  it.each([
    ["一", 1], ["十", 10], ["十二", 12], ["二十", 20], ["二十一", 21],
    ["百", 100], ["百二", 102], ["一〇", 10],
  ])("%s → %d", (run, n) => expect(parseKanjiNumber(run)).toBe(n));
  it("漢数字以外が混ざれば null", () => expect(parseKanjiNumber("一a")).toBeNull());
});

describe("buildingNameKey", () => {
  // 同じ棟とみなす組(比べる形が一致する)
  it.each([
    ["パークハウス第一", "パークハウス第１"],
    ["パークハウス第一", "パークハウス第1"],
    ["パークハウス第十二", "パークハウス第12"],
    ["ライオンズマンションⅡ", "ライオンズマンション2"],
    ["ライオンズマンションⅡ", "ライオンズマンション２"],
    ["グランドメゾン二番館", "グランドメゾン2番館"],
    ["シティ三号棟", "シティ3号棟"],
    ["霞ヶ関ハイツ", "霞ケ関ハイツ"],
    ["霞ヶ関ハイツ", "霞が関ハイツ"],
    ["杜の街", "杜ノ街"],
    ["メゾン・ド・ルミエール", "メゾン・ド・ルミエール"],
    ["サンライズ－２", "サンライズ-2"],
    ["コーポ ＡＢＣ", "コーポabc"],
    ["ⅶ番街", "7番街"],
  ])("%s と %s は同じ", (a, b) => {
    expect(buildingNameKey(a)).toBe(buildingNameKey(b));
  });

  // 別の棟のまま(変えてはいけない)
  it.each([
    ["一番町ハイツ", "1番町ハイツ"], // 地名の一は変えない
    ["ライオンズマンションII", "ライオンズマンション2"], // 英字の II は変えない
    ["第一ビル", "第二ビル"],
    ["一碧荘", "1碧荘"], // 固有名の一は変えない
  ])("%s と %s は別", (a, b) => {
    expect(buildingNameKey(a)).not.toBe(buildingNameKey(b));
  });

  it("末尾の『マンション』を外さない", () => {
    expect(buildingNameKey("リガーレマンション")).not.toBe(buildingNameKey("リガーレ"));
  });

  it.each([[null], [undefined], [""], ["  　"]])("空(%s)は null", (v) => {
    expect(buildingNameKey(v as string | null | undefined)).toBeNull();
  });
});

describe("areaKey", () => {
  it.each([
    ["東京都大田区南雪谷１丁目１６４－２－４５", "東京都大田区南雪谷1丁目"],
    ["東京都大田区南雪谷一丁目5番3号", "東京都大田区南雪谷1丁目"],
    ["東京都港区六本木六丁目10-1", "東京都港区六本木6丁目"],
    ["東京都北区東十条四丁目1", "東京都北区東十条4丁目"],
    ["東京都 大田区 南雪谷 1丁目 5", "東京都大田区南雪谷1丁目"],
    ["千葉県○○市大字△△１２３", "千葉県○○市大字△△"],
    ["大田区南雪谷1丁目", "大田区南雪谷1丁目"], // 都道府県なしはそのまま
  ])("%s → %s", (addr, key) => expect(areaKey(addr)).toBe(key));

  it.each([
    [null], [""], ["南雪谷1丁目"], // 市区町村を含まない
    ["123-4"],
  ])("取り出せない(%s)は null", (v) => {
    expect(areaKey(v as string | null)).toBeNull();
  });
});

describe("buildingAddressFromUnit", () => {
  it("住所の末尾が家屋番号と一致するときだけ、最後の部分を除く", () => {
    expect(
      buildingAddressFromUnit("東京都大田区南雪谷１丁目１６４－２－４５", "１６４－２－４５"),
    ).toBe("東京都大田区南雪谷１丁目１６４－２");
  });
  it("全角/半角が違っても一致とみなす", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164-2-45", "１６４－２－４５")).toBe(
      "東京都大田区南雪谷1丁目164-2",
    );
  });
  it("一致しない(手入力の住居表示)ときは住所のまま", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目5番3号", "164-2-45")).toBe(
      "東京都大田区南雪谷1丁目5番3号",
    );
  });
  it("家屋番号が無い・区切りが無いときは住所のまま", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164", null)).toBe("東京都大田区南雪谷1丁目164");
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164", "164")).toBe("東京都大田区南雪谷1丁目164");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/building-identity.test.ts`
Expected: FAIL(`Cannot find module '@/lib/building-identity'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-identity.ts
/**
 * 棟の「比べる形」と「町丁目」(設計 2026-10-04 §3)。
 *
 * ⚠**比べるときだけ使う**(D6)。棟の名前・物件名をこの形で書き換えてはいけない。
 *   正式名称が漢数字やローマ数字の建物があるため。
 * DB にも React にも依存しない純関数だけを置く。
 */
import { normalizeBuildingName } from "@/lib/normalize";

const ROMAN_UPPER_START = 0x2160; // Ⅰ
const ROMAN_LOWER_START = 0x2170; // ⅰ

/** ローマ数字の記号(Ⅰ〜Ⅻ/ⅰ〜ⅻ)を数字にする。⚠NFKC より前に呼ぶ(NFKC は Ⅱ→ii にする)。 */
function romanSymbolsToDigits(s: string): string {
  return s.replace(/[\u2160-\u216B\u2170-\u217B]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= ROMAN_LOWER_START ? ROMAN_LOWER_START : ROMAN_UPPER_START;
    return String(code - base + 1);
  });
}

const KANJI_DIGITS: Record<string, number> = {
  "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};
const KANJI_RUN = "[〇一二三四五六七八九十百]+";
const COUNTER_SUFFIX = "(番館|号館|号棟|番街|期)";

/** 漢数字の並びを位取りで読む(十=10・二十一=21・百=100)。読めなければ null。 */
export function parseKanjiNumber(run: string): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (const ch of run) {
    if (ch === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch === "十") {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch in KANJI_DIGITS) {
      cur = cur * 10 + KANJI_DIGITS[ch];
    } else {
      return null;
    }
    any = true;
  }
  return any ? total + cur : null;
}

/** 漢数字を**数として使われる位置だけ**数字にする(第〜・〜番館/号館/号棟/番街/期)。 */
function kanjiNumeralsInNumberPositions(s: string): string {
  return s
    .replace(new RegExp(`第(${KANJI_RUN})`, "g"), (_m, run: string) => `第${parseKanjiNumber(run) ?? run}`)
    .replace(
      new RegExp(`(${KANJI_RUN})${COUNTER_SUFFIX}`, "g"),
      (_m, run: string, suffix: string) => `${parseKanjiNumber(run) ?? run}${suffix}`,
    );
}

/** 表記の揺れ: ヶ/ケ/が→ケ、ノ/の/之→ノ、長音とハイフン類→- */
function unifyVariants(s: string): string {
  return s
    .replace(/[ヶヵケが]/g, "ケ")
    .replace(/[ノの之]/g, "ノ")
    .replace(/[ー－‐‑‒–—―−-]/g, "-");
}

/** 棟の名前の比べる形。空・空白だけなら null。 */
export function buildingNameKey(name: string | null | undefined): string | null {
  if (name == null) return null;
  const base = normalizeBuildingName(romanSymbolsToDigits(String(name)));
  if (base === "") return null;
  return unifyVariants(kanjiNumeralsInNumberPositions(base));
}

const CHOME = new RegExp(`^(.*?)(\\d+|[〇一二三四五六七八九十]+)丁目`);

/**
 * 住所から町丁目を取り出す(D2)。丁目が無ければ最初の算用数字(番地)の手前まで。
 * 市区町村(市・区・町・村・郡)を含まないものは短すぎるので null。
 */
export function areaKey(address: string | null | undefined): string | null {
  if (address == null) return null;
  const s = String(address).normalize("NFKC").replace(/[\s\u3000]+/g, "");
  if (s === "") return null;
  let key: string;
  const m = s.match(CHOME);
  if (m) {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : parseKanjiNumber(m[2]);
    if (n == null) return null;
    key = `${m[1]}${n}丁目`;
  } else {
    const d = s.search(/\d/);
    key = d === -1 ? s : s.slice(0, d);
  }
  if (!/[市区町村郡]/.test(key)) return null;
  return key;
}

function normForTail(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[ー‐‑‒–—―−]/g, "-");
}

/**
 * 自動で作る棟の住所(§4.3)。受付帳由来の区分は住所の末尾が家屋番号なので、
 * そのときだけ家屋番号の最後の「－」以降(部屋の部分)を除く。
 * 一致しない(手入力の住居表示など)ときは住所のまま=番地の一部を欠かさない。
 */
export function buildingAddressFromUnit(
  address: string,
  buildingNumber: string | null | undefined,
): string {
  const addr = address.trim();
  const nBn = normForTail(buildingNumber ?? "");
  const lastHyphen = nBn.lastIndexOf("-");
  if (lastHyphen <= 0 || !normForTail(addr).endsWith(nBn)) return addr;
  const tailLen = nBn.length - lastHyphen; // 例「-45」=3
  let consumed = 0;
  let i = addr.length;
  while (i > 0 && consumed < tailLen) {
    i -= 1;
    consumed += normForTail(addr[i]).length;
  }
  if (consumed !== tailLen) return addr;
  return addr.slice(0, i).trimEnd();
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/building-identity.test.ts`
Expected: PASS。外れた例があれば**実装を直す**(例の表は設計の約束なので、テストを緩めない)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/building-identity.ts src/lib/__tests__/building-identity.test.ts
git commit -m "feat(building): 棟の名前の比べる形と町丁目の取り出し"
```

---

### Task 2: つなぐ先の判断(純関数 `decideBuildingLink`)

**Files:**
- Create: `src/lib/building-link/resolve.ts`
- Test: `src/lib/building-link/__tests__/resolve.test.ts`

**Interfaces:**
- Produces:

```ts
export type BuildingChoice =
  | { kind: "auto" }
  | { kind: "existing"; buildingId: string }
  | { kind: "new" };
export const AUTO_CHOICE: BuildingChoice;
export type BuildingLinkWarning = "duplicate_names" | "area_unknown";
export interface LinkCandidate { id: string; name: string; unitCount: number; createdAt: Date }
export interface DecideInput {
  propertyType: string;
  buildingName: string | null;   // 保存する物件名(整えたあと)
  nameKey: string | null;
  areaKey: string | null;
  choice: BuildingChoice;
  current: { id: string; name: string; nameKey: string | null } | null;
  chosen: { id: string; name: string } | null;
  candidates: LinkCandidate[];   // 同じ area_key かつ同じ name_key の棟
}
export type BuildingLinkDecision =
  | { kind: "keep" }
  | { kind: "unlink" }
  | { kind: "link"; buildingId: string; buildingName: string; warnings: BuildingLinkWarning[] }
  | { kind: "create"; warnings: BuildingLinkWarning[] }
  | { kind: "chosen_missing" };
export function decideBuildingLink(input: DecideInput): BuildingLinkDecision;
export function buildingLinkLockKey(areaKey: string | null, nameKey: string): string;
export const BUILDING_LINK_TARGET_TYPE = "apartment_unit";
```

- [ ] **Step 1: 失敗するテストを書く(§4.2 の表を全行+Review Focus 1・2)**

```ts
// src/lib/building-link/__tests__/resolve.test.ts
import { describe, it, expect } from "vitest";
import {
  decideBuildingLink,
  buildingLinkLockKey,
  AUTO_CHOICE,
  type DecideInput,
} from "@/lib/building-link/resolve";

const base: DecideInput = {
  propertyType: "apartment_unit",
  buildingName: "パークハウス第一",
  nameKey: "パークハウス第1",
  areaKey: "東京都大田区南雪谷1丁目",
  choice: AUTO_CHOICE,
  current: null,
  chosen: null,
  candidates: [],
};
const cand = (id: string, unitCount: number, iso: string) => ({
  id, name: `棟${id}`, unitCount, createdAt: new Date(iso),
});

describe("decideBuildingLink", () => {
  it("区分マンション以外は unlink", () => {
    expect(decideBuildingLink({ ...base, propertyType: "apartment_building" })).toEqual({ kind: "unlink" });
  });
  it("旧値 unit は今の棟を残す(keep)", () => {
    expect(
      decideBuildingLink({ ...base, propertyType: "unit", current: { id: "b0", name: "旧棟", nameKey: "旧棟" } }),
    ).toEqual({ kind: "keep" });
  });
  it("物件名が空は unlink", () => {
    expect(decideBuildingLink({ ...base, buildingName: null, nameKey: null })).toEqual({ kind: "unlink" });
  });
  it("choice=existing はその棟へ link", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "existing", buildingId: "b9" }, chosen: { id: "b9", name: "正式名" } }),
    ).toEqual({ kind: "link", buildingId: "b9", buildingName: "正式名", warnings: [] });
  });
  it("choice=existing で棟が無いなら chosen_missing", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "existing", buildingId: "b9" }, chosen: null }),
    ).toEqual({ kind: "chosen_missing" });
  });
  it("choice=new は create(候補があっても)", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "new" }, candidates: [cand("a", 3, "2026-01-01")] }),
    ).toEqual({ kind: "create", warnings: [] });
  });
  it("auto・候補1件はその棟へ link", () => {
    expect(decideBuildingLink({ ...base, candidates: [cand("a", 3, "2026-01-01")] })).toEqual({
      kind: "link", buildingId: "a", buildingName: "棟a", warnings: [],
    });
  });
  it("auto・候補0件は create", () => {
    expect(decideBuildingLink(base)).toEqual({ kind: "create", warnings: [] });
  });
  it("auto・候補2件以上は部屋数最多へ+duplicate_names", () => {
    const d = decideBuildingLink({
      ...base,
      candidates: [cand("a", 2, "2026-01-01"), cand("b", 5, "2026-02-01")],
    });
    expect(d).toEqual({ kind: "link", buildingId: "b", buildingName: "棟b", warnings: ["duplicate_names"] });
  });
  it("部屋数が同じなら作成が古い方", () => {
    const d = decideBuildingLink({
      ...base,
      candidates: [cand("new", 3, "2026-03-01"), cand("old", 3, "2026-01-01")],
    });
    expect(d).toMatchObject({ kind: "link", buildingId: "old" });
  });
  it("auto・町丁目が取れないなら create+area_unknown", () => {
    expect(decideBuildingLink({ ...base, areaKey: null })).toEqual({ kind: "create", warnings: ["area_unknown"] });
  });
  it("今の棟と比べる形が同じ名前なら、丁目が違っても今の棟のまま(付け替えない)", () => {
    const d = decideBuildingLink({
      ...base,
      areaKey: "東京都大田区南雪谷2丁目",
      current: { id: "cur", name: "パークハウス第１", nameKey: "パークハウス第1" },
      candidates: [cand("other", 9, "2020-01-01")],
    });
    expect(d).toEqual({ kind: "link", buildingId: "cur", buildingName: "パークハウス第１", warnings: [] });
  });
  it("今の棟と比べる形が違えば付け替えの判断をする", () => {
    const d = decideBuildingLink({
      ...base,
      current: { id: "cur", name: "別の棟", nameKey: "別の棟" },
      candidates: [],
    });
    expect(d).toEqual({ kind: "create", warnings: [] });
  });
});

describe("buildingLinkLockKey", () => {
  it("町丁目と比べる形をつなぐ", () => {
    expect(buildingLinkLockKey("東京都大田区南雪谷1丁目", "x")).toBe("building-link:東京都大田区南雪谷1丁目:x");
  });
  it("町丁目が無いときは名前だけ", () => {
    expect(buildingLinkLockKey(null, "x")).toBe("building-link::x");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/resolve.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/resolve.ts
/**
 * 物件をどの棟へつなぐかの判断(設計 2026-10-04 §4.2)。DB を触らない純関数。
 * DB への適用は apply.ts。全部の保存の入口が apply.ts を通る。
 */

export const BUILDING_LINK_TARGET_TYPE = "apartment_unit";

export type BuildingChoice =
  | { kind: "auto" }
  | { kind: "existing"; buildingId: string }
  | { kind: "new" };

export const AUTO_CHOICE: BuildingChoice = { kind: "auto" };

export type BuildingLinkWarning = "duplicate_names" | "area_unknown";

export interface LinkCandidate {
  id: string;
  name: string;
  unitCount: number;
  createdAt: Date;
}

export interface DecideInput {
  propertyType: string;
  buildingName: string | null;
  nameKey: string | null;
  areaKey: string | null;
  choice: BuildingChoice;
  current: { id: string; name: string; nameKey: string | null } | null;
  chosen: { id: string; name: string } | null;
  candidates: LinkCandidate[];
}

export type BuildingLinkDecision =
  | { kind: "keep" }
  | { kind: "unlink" }
  | { kind: "link"; buildingId: string; buildingName: string; warnings: BuildingLinkWarning[] }
  | { kind: "create"; warnings: BuildingLinkWarning[] }
  | { kind: "chosen_missing" };

export function decideBuildingLink(i: DecideInput): BuildingLinkDecision {
  if (i.propertyType !== BUILDING_LINK_TARGET_TYPE) {
    // ⚠旧値「区分(旧)」は**今の棟を残す**。住所だけ直した保存で棟から外れないように。
    return i.propertyType === "unit" ? { kind: "keep" } : { kind: "unlink" };
  }
  if (!i.buildingName || !i.nameKey) return { kind: "unlink" };
  if (i.choice.kind === "existing") {
    return i.chosen
      ? { kind: "link", buildingId: i.chosen.id, buildingName: i.chosen.name, warnings: [] }
      : { kind: "chosen_missing" };
  }
  if (i.choice.kind === "new") return { kind: "create", warnings: [] };
  // 今の棟と比べる形が同じ=同じ建物の打ち直し。付け替えない(D4 の「名前を変える」に当たらない)。
  if (i.current && i.current.nameKey === i.nameKey) {
    return { kind: "link", buildingId: i.current.id, buildingName: i.current.name, warnings: [] };
  }
  if (i.areaKey === null) return { kind: "create", warnings: ["area_unknown"] };
  if (i.candidates.length === 0) return { kind: "create", warnings: [] };
  const [best] = [...i.candidates].sort(
    (a, b) =>
      b.unitCount - a.unitCount ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : 1),
  );
  return {
    kind: "link",
    buildingId: best.id,
    buildingName: best.name,
    warnings: i.candidates.length > 1 ? ["duplicate_names"] : [],
  };
}

/** 同時保存の順番待ちに使う鍵。町丁目が無いときは名前だけ(§4.3)。 */
export function buildingLinkLockKey(areaKey: string | null, nameKey: string): string {
  return `building-link:${areaKey ?? ""}:${nameKey}`;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/building-link/resolve.ts src/lib/building-link/__tests__/resolve.test.ts
git commit -m "feat(building): 物件をつなぐ棟の判断(純関数)"
```

---

### Task 3: migration と DB への適用(`applyBuildingLink`)

**Files:**
- Modify: `prisma/schema.prisma`(model Building)
- Create: `prisma/migrations/20261005090000_add_building_identity_keys/migration.sql`
- Create: `src/lib/building-link/apply.ts`
- Test: `src/lib/building-link/__tests__/apply.test.ts`
- Test: `src/lib/building-link/__tests__/apply-concurrency.test.ts`

**Interfaces:**
- Consumes: Task 1 の `buildingNameKey`・`areaKey`・`buildingAddressFromUnit`、Task 2 の全部
- Produces:

```ts
export interface ApplyBuildingLinkInput {
  propertyId: string;
  propertyType: string;
  buildingName: string | null;     // いま物件に保存されている(=保存した)物件名
  address: string;
  buildingNumber: string | null;
  choice: BuildingChoice;
  currentBuildingId: string | null;
  userId: string;
}
export interface BuildingLinkOutcome {
  action: "none" | "kept" | "linked" | "created" | "unlinked";
  building: { id: string; name: string } | null;  // kept/linked/created のとき
  previousBuildingId: string | null;
  renamedFrom: string | null;                     // 物件名を棟の表記にそろえたときの入力
  warnings: BuildingLinkWarning[];
}
export async function applyBuildingLink(tx: BuildingLinkTx, input: ApplyBuildingLinkInput): Promise<BuildingLinkOutcome>;
export async function writeBuildingLinkAudit(userId: string, propertyId: string, outcome: BuildingLinkOutcome): Promise<void>;
export function finalBuildingFields(outcome: BuildingLinkOutcome, savedName: string | null): { buildingId: string | null | undefined; buildingName: string | null };
  // buildingId: undefined=変えていない(action none)
export function buildingIdentityKeys(name: string, address: string): { nameKey: string | null; areaKey: string | null };
```

- [ ] **Step 1: schema と migration を足す**

`prisma/schema.prisma` の `model Building` の `gpsLng` の下に足す:

```prisma
  // 比べる形(名前)と町丁目。棟を作る・名前や住所を変えるたびにアプリが計算して入れる
  // (src/lib/building-identity.ts)。null の古い行は、比べるときにその場で計算して埋める。
  nameKey             String?   @map("name_key")
  areaKey             String?   @map("area_key")
```

同じ model の `@@index([address])` の下に `@@index([areaKey, nameKey])` を足す。

```sql
-- prisma/migrations/20261005090000_add_building_identity_keys/migration.sql
-- 棟の比べる形と町丁目(設計 2026-10-04 §7・D12)。ADD のみ。値はアプリが入れる。
ALTER TABLE "buildings" ADD COLUMN "name_key" TEXT;
ALTER TABLE "buildings" ADD COLUMN "area_key" TEXT;
CREATE INDEX "buildings_area_key_name_key_idx" ON "buildings"("area_key", "name_key");
```

Run: `npx prisma generate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script`
Expected: 空(差分なし)。シャドウDBが無い環境では `npx prisma validate` と `npx tsc --noEmit` が通ることで代える。

- [ ] **Step 2: 失敗するテストを書く(偽の tx で DB の動きを写す)**

```ts
// src/lib/building-link/__tests__/apply.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ writeAuditLog: (...a: unknown[]) => auditMock(...a) }));

import { applyBuildingLink, writeBuildingLinkAudit, finalBuildingFields } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

const ADDR = "東京都大田区南雪谷１丁目１６４－２－４５";
let db: FakeDb;
beforeEach(() => {
  db = { buildings: [], properties: [{ id: "p1", buildingId: null, buildingName: "パークハウス第１" }], executed: [] };
  auditMock.mockReset();
});
const input = (over: Partial<Parameters<typeof applyBuildingLink>[1]> = {}) => ({
  propertyId: "p1",
  propertyType: "apartment_unit",
  buildingName: "パークハウス第１",
  address: ADDR,
  buildingNumber: "１６４－２－４５",
  choice: AUTO_CHOICE,
  currentBuildingId: null,
  userId: "u1",
  ...over,
});

describe("applyBuildingLink", () => {
  it("候補が無ければ棟を作り、住所は部屋の部分を除き、key を入れてつなぐ", async () => {
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out.action).toBe("created");
    expect(db.buildings).toHaveLength(1);
    expect(db.buildings[0]).toMatchObject({
      name: "パークハウス第１",
      address: "東京都大田区南雪谷１丁目１６４－２",
      nameKey: "パークハウス第1",
      areaKey: "東京都大田区南雪谷1丁目",
      createdBy: "u1",
    });
    expect(db.properties[0].buildingId).toBe(db.buildings[0].id);
  });

  it("同じ町丁目の表記違いの棟があればつなぎ、物件名を棟の表記にそろえる", async () => {
    db.buildings.push({ id: "b1", name: "パークハウス第一", address: "x", nameKey: "パークハウス第1", areaKey: "東京都大田区南雪谷1丁目", createdAt: new Date("2026-01-01"), createdBy: "u0" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out).toMatchObject({ action: "linked", building: { id: "b1", name: "パークハウス第一" }, renamedFrom: "パークハウス第１" });
    expect(db.properties[0]).toMatchObject({ buildingId: "b1", buildingName: "パークハウス第一" });
  });

  it("key が null の古い棟も、その場で計算して見つけ、key を埋める(SKIP LOCKED)", async () => {
    db.buildings.push({ id: "old", name: "パークハウス第一", address: "東京都大田区南雪谷1丁目164-2", nameKey: null, areaKey: null, createdAt: new Date("2025-01-01"), createdBy: "u0" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(out).toMatchObject({ action: "linked", building: { id: "old" } });
    expect(db.executed.some((sql) => /FOR UPDATE SKIP LOCKED/.test(sql))).toBe(true);
    expect(db.buildings[0]).toMatchObject({ nameKey: "パークハウス第1", areaKey: "東京都大田区南雪谷1丁目" });
  });

  it("順番待ちのロックを $executeRaw で取る", async () => {
    await applyBuildingLink(createFakeBuildingTx(db), input());
    expect(db.executed.some((sql) => /pg_advisory_xact_lock\(hashtext\(.*\)::bigint\)/.test(sql))).toBe(true);
  });

  it("物件名を空にしたら棟から外す", async () => {
    db.properties[0] = { id: "p1", buildingId: "b1", buildingName: null };
    const out = await applyBuildingLink(createFakeBuildingTx(db), input({ buildingName: null, currentBuildingId: "b1" }));
    expect(out).toMatchObject({ action: "unlinked", previousBuildingId: "b1" });
    expect(db.properties[0].buildingId).toBeNull();
  });

  it("棟につながっていない土地は何もしない(DB を触らない)", async () => {
    const tx = createFakeBuildingTx(db);
    const out = await applyBuildingLink(tx, input({ propertyType: "land", buildingName: null }));
    expect(out.action).toBe("none");
    expect(db.executed).toHaveLength(0);
  });

  it("選んだ棟が消えていたら 409", async () => {
    await expect(
      applyBuildingLink(createFakeBuildingTx(db), input({ choice: { kind: "existing", buildingId: "gone" } })),
    ).rejects.toMatchObject({ status: 409, code: "BUILDING_NOT_FOUND" });
  });

  it("同じ棟のまま・名前も同じなら kept で物件を更新しない", async () => {
    db.buildings.push({ id: "b1", name: "パークハウス第１", address: "x", nameKey: "パークハウス第1", areaKey: "東京都大田区南雪谷1丁目", createdAt: new Date(), createdBy: "u0" });
    db.properties[0] = { id: "p1", buildingId: "b1", buildingName: "パークハウス第１" };
    const tx = createFakeBuildingTx(db);
    const out = await applyBuildingLink(tx, input({ currentBuildingId: "b1" }));
    expect(out).toMatchObject({ action: "kept", renamedFrom: null });
    expect(tx.property.update).not.toHaveBeenCalled();
  });
});

describe("writeBuildingLinkAudit", () => {
  it("作ったときは棟の作成とつないだことの2本。住所を入れない", async () => {
    await writeBuildingLinkAudit("u1", "p1", {
      action: "created", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    expect(auditMock.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      "building.auto_create",
      "property.building_link",
    ]);
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("南雪谷");
  });
  it("前の棟があれば relink", async () => {
    await writeBuildingLinkAudit("u1", "p1", {
      action: "linked", building: { id: "b2", name: "n" }, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    expect(auditMock.mock.calls[0][0]).toMatchObject({ action: "property.building_relink" });
  });
  it("none と kept は書かない", async () => {
    await writeBuildingLinkAudit("u1", "p1", { action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [] });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("finalBuildingFields", () => {
  it("つないだら棟の名前、外したら保存した名前と null、none は buildingId を変えない", () => {
    expect(finalBuildingFields({ action: "linked", building: { id: "b", name: "正" }, previousBuildingId: null, renamedFrom: "入", warnings: [] }, "入"))
      .toEqual({ buildingId: "b", buildingName: "正" });
    expect(finalBuildingFields({ action: "unlinked", building: null, previousBuildingId: "b", renamedFrom: null, warnings: [] }, null))
      .toEqual({ buildingId: null, buildingName: null });
    expect(finalBuildingFields({ action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [] }, "x"))
      .toEqual({ buildingId: undefined, buildingName: "x" });
  });
});
```

偽の tx(テスト専用の補助ファイル):

```ts
// src/lib/building-link/__tests__/fake-building-tx.ts
import { vi } from "vitest";
import type { BuildingLinkTx } from "@/lib/building-link/apply";

export interface FakeBuilding {
  id: string; name: string; address: string;
  nameKey: string | null; areaKey: string | null;
  createdAt: Date; createdBy: string;
}
export interface FakeProperty { id: string; buildingId: string | null; buildingName: string | null }
export interface FakeDb { buildings: FakeBuilding[]; properties: FakeProperty[]; executed: string[] }

/** テンプレート文字列の SQL を、値を埋めた1本の文字列にする(検査用)。 */
function sqlText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
}

/**
 * applyBuildingLink が使う tx の口だけを、配列の上で写す。
 * ⚠apply.ts が新しい口を使ったら、ここにも足す(足さないとテストが TypeError で落ちて気づける)。
 * lock: 渡すと $executeRaw の advisory lock で順番待ちを写す(同時保存のテスト用)。
 */
export function createFakeBuildingTx(db: FakeDb, lock?: (key: string) => Promise<void>) {
  const fake = buildFake(db, lock);
  // ⚠Prisma の型を全部は満たさないので、apply に渡せる形へ寄せる(テストからは vi.fn も触れる)。
  return fake as unknown as typeof fake & BuildingLinkTx;
}

function buildFake(db: FakeDb, lock?: (key: string) => Promise<void>) {
  let seq = db.buildings.length;
  const count = (id: string) => db.properties.filter((p) => p.buildingId === id).length;
  const view = (b: FakeBuilding) => ({ ...b, _count: { properties: count(b.id) } });
  return {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings, values);
      db.executed.push(text);
      if (/pg_advisory_xact_lock/.test(text) && lock) await lock(String(values[0]));
      const skip = /UPDATE "buildings" SET "name_key" = (.*), "area_key" = (.*) WHERE "id" = \(SELECT/.exec(text);
      if (skip) {
        const id = String(values[2]);
        const b = db.buildings.find((x) => x.id === id && x.nameKey === null);
        if (b) {
          b.nameKey = values[0] as string | null;
          b.areaKey = values[1] as string | null;
          return 1;
        }
        return 0;
      }
      return 0;
    }),
    building: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const b = db.buildings.find((x) => x.id === where.id);
        return b ? view(b) : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const rows = db.buildings.filter((b) =>
          Object.entries(where).every(([k, v]) => (b as unknown as Record<string, unknown>)[k] === v),
        );
        return rows.slice(0, take ?? rows.length).map(view);
      }),
      create: vi.fn(async ({ data }: { data: Omit<FakeBuilding, "id" | "createdAt"> }) => {
        seq += 1;
        const b: FakeBuilding = { id: `new-${seq}`, createdAt: new Date(2026, 9, 5, 0, 0, seq), ...data };
        db.buildings.push(b);
        return { id: b.id, name: b.name };
      }),
    },
    property: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeProperty> }) => {
        const p = db.properties.find((x) => x.id === where.id);
        if (!p) throw new Error("property not found");
        Object.assign(p, data);
        return p;
      }),
    },
  };
}
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/apply.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 4: 実装する**

```ts
// src/lib/building-link/apply.ts
/**
 * 物件と棟をつなぐ処理の DB 側(設計 2026-10-04 §4.3)。全部の保存の入口がここを通る。
 *
 * ⚠**必ず物件を保存するのと同じトランザクションの tx を渡す**。
 * ⚠ロック順: 物件の保存は「物件の行 → (ここ)アドバイザリロック」。棟の名前の反映は
 *   「棟の行 → 部屋の行」。ここは**棟の行をロックしない**(読むだけ・key の補完は
 *   SKIP LOCKED)ので、両者が逆順で待ち合うことはない。
 */
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { areaKey, buildingAddressFromUnit, buildingNameKey } from "@/lib/building-identity";
import {
  BUILDING_LINK_TARGET_TYPE,
  buildingLinkLockKey,
  decideBuildingLink,
  type BuildingChoice,
  type BuildingLinkWarning,
  type LinkCandidate,
} from "./resolve";

/** key が null の古い棟を、1回の判断で見る上限(本番の該当は1件)。 */
const NULL_KEY_SCAN_LIMIT = 500;

export type BuildingLinkTx = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  building: Pick<Prisma.TransactionClient["building"], "findUnique" | "findMany" | "create">;
  property: Pick<Prisma.TransactionClient["property"], "update">;
};

export interface ApplyBuildingLinkInput {
  propertyId: string;
  propertyType: string;
  buildingName: string | null;
  address: string;
  buildingNumber: string | null;
  choice: BuildingChoice;
  currentBuildingId: string | null;
  userId: string;
}

export interface BuildingLinkOutcome {
  action: "none" | "kept" | "linked" | "created" | "unlinked";
  building: { id: string; name: string } | null;
  previousBuildingId: string | null;
  renamedFrom: string | null;
  warnings: BuildingLinkWarning[];
}

export function buildingIdentityKeys(name: string, address: string) {
  return { nameKey: buildingNameKey(name), areaKey: areaKey(address) };
}

async function loadCandidates(tx: BuildingLinkTx, area: string, nameKey: string): Promise<LinkCandidate[]> {
  const select = { id: true, name: true, address: true, createdAt: true, _count: { select: { properties: true } } } as const;
  const keyed = await tx.building.findMany({ where: { areaKey: area, nameKey }, select });
  const unkeyed = await tx.building.findMany({
    where: { nameKey: null },
    select,
    orderBy: { createdAt: "asc" },
    take: NULL_KEY_SCAN_LIMIT,
  });
  const matched: typeof unkeyed = [];
  for (const b of unkeyed) {
    const keys = buildingIdentityKeys(b.name, b.address);
    // ⚠**SKIP LOCKED**: 棟の名前の反映が棟の行を持っている間は待たずに飛ばす(待ちの輪を作らない)。
    //   埋められなかった行は次の機会に埋まる。比べる判断はこの場で計算した key で行う。
    await tx.$executeRaw`UPDATE "buildings" SET "name_key" = ${keys.nameKey}, "area_key" = ${keys.areaKey} WHERE "id" = (SELECT "id" FROM "buildings" WHERE "id" = ${b.id}::uuid AND "name_key" IS NULL FOR UPDATE SKIP LOCKED)`;
    if (keys.nameKey === nameKey && keys.areaKey === area) matched.push(b);
  }
  return [...keyed, ...matched].map((b) => ({
    id: b.id,
    name: b.name,
    unitCount: b._count.properties,
    createdAt: b.createdAt,
  }));
}

export async function applyBuildingLink(
  tx: BuildingLinkTx,
  input: ApplyBuildingLinkInput,
): Promise<BuildingLinkOutcome> {
  const nameKey = buildingNameKey(input.buildingName);
  const area = areaKey(input.address);
  const none: BuildingLinkOutcome = {
    action: "none", building: null, previousBuildingId: input.currentBuildingId, renamedFrom: null, warnings: [],
  };
  const common = {
    propertyType: input.propertyType,
    buildingName: input.buildingName,
    nameKey,
    areaKey: area,
    choice: input.choice,
  };

  // DB を見ずに決まるもの(対象外の種別・物件名が空)
  if (input.propertyType !== BUILDING_LINK_TARGET_TYPE || nameKey === null) {
    const d = decideBuildingLink({ ...common, current: null, chosen: null, candidates: [] });
    if (d.kind === "unlink" && input.currentBuildingId) {
      await tx.property.update({ where: { id: input.propertyId }, data: { buildingId: null } });
      return { ...none, action: "unlinked" };
    }
    return none;
  }

  const currentRow = input.currentBuildingId
    ? await tx.building.findUnique({ where: { id: input.currentBuildingId }, select: { id: true, name: true, nameKey: true } })
    : null;
  const current = currentRow
    ? { id: currentRow.id, name: currentRow.name, nameKey: currentRow.nameKey ?? buildingNameKey(currentRow.name) }
    : null;

  let chosen: { id: string; name: string } | null = null;
  let candidates: LinkCandidate[] = [];
  if (input.choice.kind === "existing") {
    chosen = await tx.building.findUnique({ where: { id: input.choice.buildingId }, select: { id: true, name: true } });
  } else {
    // 順番待ち → **ロックのあとに**読み直す(同時に来た2人目は1人目が作った棟を見つける)。
    // ⚠$executeRaw + ::bigint(paste commit の前例と同じ。$queryRaw は void 列で落ちる)。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildingLinkLockKey(area, nameKey)})::bigint)`;
    if (area !== null) candidates = await loadCandidates(tx, area, nameKey);
  }

  const d = decideBuildingLink({ ...common, current, chosen, candidates });
  if (d.kind === "chosen_missing") {
    throw new ApiError(409, "選んだ棟が見つかりません。棟を選び直してください", "BUILDING_NOT_FOUND");
  }
  if (d.kind === "keep" || d.kind === "unlink") return none; // 上で処理済み(型を閉じるため)

  let building: { id: string; name: string };
  let created = false;
  if (d.kind === "create") {
    building = await tx.building.create({
      data: {
        name: input.buildingName as string,
        address: buildingAddressFromUnit(input.address, input.buildingNumber),
        nameKey,
        areaKey: area,
        createdBy: input.userId,
      },
      select: { id: true, name: true },
    });
    created = true;
  } else {
    building = { id: d.buildingId, name: d.buildingName };
  }

  const renamedFrom = input.buildingName !== building.name ? input.buildingName : null;
  if (input.currentBuildingId !== building.id || renamedFrom !== null) {
    await tx.property.update({
      where: { id: input.propertyId },
      data: { buildingId: building.id, buildingName: building.name },
    });
  }
  return {
    action: created ? "created" : input.currentBuildingId === building.id ? "kept" : "linked",
    building,
    previousBuildingId: input.currentBuildingId,
    renamedFrom,
    warnings: d.warnings,
  };
}

/** 保存後の物件の棟と物件名(変更履歴・応答に使う)。buildingId=undefined は「変えていない」。 */
export function finalBuildingFields(
  outcome: BuildingLinkOutcome,
  savedName: string | null,
): { buildingId: string | null | undefined; buildingName: string | null } {
  if (outcome.action === "none") return { buildingId: undefined, buildingName: savedName };
  if (outcome.action === "unlinked") return { buildingId: null, buildingName: savedName };
  return { buildingId: outcome.building?.id ?? null, buildingName: outcome.building?.name ?? savedName };
}

/** 監査ログ(トランザクションの外で呼ぶ)。⚠detail に住所を入れない。 */
export async function writeBuildingLinkAudit(
  userId: string,
  propertyId: string,
  outcome: BuildingLinkOutcome,
): Promise<void> {
  if (outcome.action === "none" || outcome.action === "kept") return;
  if (outcome.action === "unlinked") {
    await writeAuditLog({
      userId, action: "property.building_unlink", targetTable: "properties", targetId: propertyId,
      detail: { previousBuildingId: outcome.previousBuildingId },
    });
    return;
  }
  const buildingId = outcome.building?.id ?? null;
  if (outcome.action === "created" && buildingId) {
    await writeAuditLog({
      userId, action: "building.auto_create", targetTable: "buildings", targetId: buildingId,
      detail: { propertyId },
    });
  }
  await writeAuditLog({
    userId,
    action: outcome.previousBuildingId ? "property.building_relink" : "property.building_link",
    targetTable: "properties",
    targetId: propertyId,
    detail: {
      buildingId,
      previousBuildingId: outcome.previousBuildingId,
      renamed: outcome.renamedFrom !== null,
      warnings: outcome.warnings,
    },
  });
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/apply.test.ts`
Expected: PASS

- [ ] **Step 6: 同時保存の総当たりテストを書く**

2人が同じ新しい建物を登録する。ロックは本物の順番待ち(Promise の鎖)で写し、**開始の順番・ロックを取る順番の組み合わせ**を全部回す。

```ts
// src/lib/building-link/__tests__/apply-concurrency.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { applyBuildingLink } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

/**
 * キーごとの順番待ち(2人で1つを共有する)。lock を取った人は、自分の apply が終わったとき
 * (=トランザクションの終わり)に release する。
 */
function makeSharedLocks() {
  const tails = new Map<string, Promise<void>>();
  return () => {
    let release: () => void = () => {};
    const lock = async (key: string) => {
      const prev = tails.get(key) ?? Promise.resolve();
      const mine = new Promise<void>((r) => (release = r));
      tails.set(key, prev.then(() => mine));
      await prev;
    };
    return { lock, release: () => release() };
  };
}

const NAMES = [
  ["パークハウス第一", "パークハウス第１"],
  ["パークハウス第１", "パークハウス第一"],
  ["パークハウス第1", "パークハウス第1"],
];

describe("同時に同じ新しい建物を登録しても棟は1つ", () => {
  for (const [a, b] of NAMES) {
    for (const startOrder of [[0, 1], [1, 0]] as const) {
      it(`${a} / ${b}・開始順 ${startOrder.join("→")}`, async () => {
        const db: FakeDb = {
          buildings: [],
          properties: [
            { id: "p0", buildingId: null, buildingName: a },
            { id: "p1", buildingId: null, buildingName: b },
          ],
          executed: [],
        };
        const names = [a, b];
        const newHolder = makeSharedLocks();
        const runs = startOrder.map((idx) => {
          const holder = newHolder();
          const tx = createFakeBuildingTx(db, holder.lock);
          return applyBuildingLink(tx, {
            propertyId: `p${idx}`,
            propertyType: "apartment_unit",
            buildingName: names[idx],
            address: "東京都大田区南雪谷1丁目164-2-45",
            buildingNumber: "164-2-45",
            choice: AUTO_CHOICE,
            currentBuildingId: null,
            userId: "u",
          }).finally(holder.release);
        });
        await Promise.all(runs);
        expect(db.buildings).toHaveLength(1);
        expect(db.properties.every((p) => p.buildingId === db.buildings[0].id)).toBe(true);
        expect(new Set(db.properties.map((p) => p.buildingName)).size).toBe(1);
      });
    }
  }
});
```

- [ ] **Step 7: 通ることを確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/`
Expected: PASS(6件)。試しに apply.ts の advisory lock の行をコメントアウトすると、同時保存のテストが「棟が2つ」で落ちることを確かめてから戻す。

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261005090000_add_building_identity_keys src/lib/building-link
git commit -m "feat(building): 棟の比べる形の列と、物件を棟へつなぐDB処理"
```

---

### Task 4: 新規登録と編集の API に組み込む

**Files:**
- Modify: `src/lib/validators.ts`(`createPropertySchema`・`updatePropertySchema` の近く)
- Modify: `src/app/api/properties/route.ts`(POST)
- Modify: `src/app/api/properties/[id]/route.ts`(PATCH)
- Modify: `src/components/properties/history-tab.tsx`(`FIELD_LABELS`)
- Test: `src/app/api/properties/__tests__/building-link-post.test.ts`(新規)
- Test: `src/app/api/properties/[id]/__tests__/building-link-patch.test.ts`(新規)

**Interfaces:**
- Consumes: Task 3 の `applyBuildingLink`・`writeBuildingLinkAudit`・`finalBuildingFields`、Task 2 の `AUTO_CHOICE`
- Produces:
  - `buildingChoiceSchema`(zod)を `src/lib/validators.ts` から export
  - POST/PATCH の応答に `buildingLink: BuildingLinkOutcome | null` を足す(画面は段2で使う)

- [ ] **Step 1: zod に `buildingChoice` を足す**

`src/lib/validators.ts` の `createPropertySchema` の直前に:

```ts
// 物件名から棟へつなぐときの選び方(設計 2026-10-04 §4.1)。省略=auto。
// ⚠uuid は小文字にそろえる(生SQL・他経路の保存値と一致させる)。
export const buildingChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("existing"), buildingId: z.string().uuid().transform((s) => s.toLowerCase()) }),
  z.object({ kind: z.literal("new") }),
]);
```

`createPropertySchema` と `updatePropertySchema` の両方に `buildingChoice: buildingChoiceSchema.optional(),` を足す。

- [ ] **Step 2: 失敗するテストを書く(POST)**

既存の `src/lib/__tests__/property-building-name.test.ts` が POST をどう mock しているかを読み、同じ mock の形(`@/lib/auth`・`next/server`・`@/lib/api-helpers`・`@/lib/permissions`・`@/lib/audit`・`@/lib/prisma`)で書く。`@/lib/building-link/apply` は mock する:

```ts
// src/app/api/properties/__tests__/building-link-post.test.ts(要点)
const applyMock = vi.fn();
const auditLinkMock = vi.fn();
vi.mock("@/lib/building-link/apply", () => ({
  applyBuildingLink: (...a: unknown[]) => applyMock(...a),
  writeBuildingLinkAudit: (...a: unknown[]) => auditLinkMock(...a),
}));
// prisma mock: $transaction は cb(txMock) を呼ぶ。txMock.property.create は { id: "p1" }、
// txMock.property.findUniqueOrThrow は { id: "p1", buildingName: "正式名" }。

it("作成と同じトランザクションで棟へつなぎ、応答に buildingLink を載せる", async () => {
  applyMock.mockResolvedValue({ action: "created", building: { id: "b1", name: "正式名" }, previousBuildingId: null, renamedFrom: null, warnings: [] });
  const res = await POST(req({ propertyType: "apartment_unit", address: "東京都大田区南雪谷1丁目1", buildingName: " 正式名 " }));
  expect(res.status).toBe(201);
  expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
    propertyId: "p1", propertyType: "apartment_unit", buildingName: "正式名", choice: { kind: "auto" }, currentBuildingId: null,
  }));
  expect((await res.json()).buildingLink).toMatchObject({ action: "created" });
  expect(auditLinkMock).toHaveBeenCalledWith("user-1", "p1", expect.objectContaining({ action: "created" }));
});

it("buildingChoice=existing をそのまま渡す(uuid は小文字)", async () => {
  applyMock.mockResolvedValue({ action: "linked", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [] });
  await POST(req({ propertyType: "apartment_unit", address: "a市b町1", buildingName: "n",
    buildingChoice: { kind: "existing", buildingId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" } }));
  expect(applyMock.mock.calls[0][1].choice).toEqual({ kind: "existing", buildingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
});

it("buildingChoice は物件の列として保存しない", async () => {
  applyMock.mockResolvedValue({ action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [] });
  await POST(req({ propertyType: "land", address: "a市b町1", buildingChoice: { kind: "new" } }));
  expect(txMock.property.create.mock.calls[0][0].data).not.toHaveProperty("buildingChoice");
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/app/api/properties/__tests__/building-link-post.test.ts`
Expected: FAIL(applyMock が呼ばれない)

- [ ] **Step 4: POST を直す**

`src/app/api/properties/route.ts` の POST の `const data = createPropertySchema.parse(body);` 以降を次に置き換える(import に `applyBuildingLink, writeBuildingLinkAudit`(`@/lib/building-link/apply`)と `AUTO_CHOICE`(`@/lib/building-link/resolve`)を足す):

```ts
    const { buildingChoice, ...data } = createPropertySchema.parse(body);
    // ⚠物件名は**種別に合うときだけ**保存する(既存コメントのとおり)。判定は UI と同じ純関数。
    const buildingName = normalizeBuildingName(data.propertyType, data.buildingName);

    // 作成と棟へのつなぎは同じトランザクション(片方だけ残らないように)。
    const { property, buildingLink } = await prisma.$transaction(async (tx) => {
      const created = await tx.property.create({
        data: { ...data, buildingName, createdBy: session.id },
        select: { id: true },
      });
      const buildingLink = await applyBuildingLink(tx, {
        propertyId: created.id,
        propertyType: data.propertyType,
        buildingName,
        address: data.address,
        buildingNumber: data.buildingNumber ?? null,
        choice: buildingChoice ?? AUTO_CHOICE,
        currentBuildingId: null,
        userId: session.id,
      });
      const property = await tx.property.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          assignee: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
        },
      });
      return { property, buildingLink };
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "properties",
      targetId: property.id,
      detail: { propertyType: data.propertyType, address: data.address },
    });
    await writeBuildingLinkAudit(session.id, property.id, buildingLink);

    return apiResponse({ ...property, buildingLink }, 201);
```

- [ ] **Step 5: POST のテストを通し、既存の POST のテストを直す**

Run: `npx vitest run src/app/api/properties/__tests__/building-link-post.test.ts src/lib/__tests__/property-building-name.test.ts src/lib/__tests__/unit-create-postal-code.test.ts`
Expected: 新しいテストは PASS。既存のテストが `prisma.property.create` を直接 mock していて落ちる場合は、その mock に `$transaction: vi.fn(async (cb) => cb(<同じ mock>))` と `property.findUniqueOrThrow` を足し、`@/lib/building-link/apply` を `{ action: "none", … }` を返す mock にする(**期待値は緩めない**)。

- [ ] **Step 6: 失敗するテストを書く(PATCH)**

`src/app/api/properties/[id]/__tests__/route.test.ts` の mock の形をそのまま写す(`$transaction`・`lockPropertyRow`・`assertNotEditLockedByOther` の mock を含む)。

```ts
// src/app/api/properties/[id]/__tests__/building-link-patch.test.ts(要点)
// current(findUnique)= { id:"p1", version:1, propertyType:"apartment_unit", address:"東京都大田区南雪谷1丁目1",
//   buildingName:"パークハウス第一", buildingId:"b1", buildingNumber:null, registryStatus:"unconfirmed", … }

it("物件名・種別・住所が変わらず buildingChoice も無ければ apply を呼ばない", async () => {
  await PATCH(req({ version: 1, note: "メモだけ" }), ctx);
  expect(applyMock).not.toHaveBeenCalled();
});

it("物件名を変えたら、更新と同じ tx で apply を呼ぶ(今の棟を渡す)", async () => {
  applyMock.mockResolvedValue({ action: "linked", building: { id: "b2", name: "別棟" }, previousBuildingId: "b1", renamedFrom: null, warnings: [] });
  const res = await PATCH(req({ version: 1, buildingName: "別棟" }), ctx);
  expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
    propertyId: "p1", buildingName: "別棟", currentBuildingId: "b1", choice: { kind: "auto" },
  }));
  expect((await res.json()).buildingLink).toMatchObject({ action: "linked" });
});

it("棟の表記にそろえたら、変更履歴の物件名は『そろえた後』になり、棟の変更も残る", async () => {
  applyMock.mockResolvedValue({ action: "linked", building: { id: "b2", name: "第一ビル" }, previousBuildingId: "b1", renamedFrom: "第１ビル", warnings: [] });
  await PATCH(req({ version: 1, buildingName: "第１ビル" }), ctx);
  const logs = prismaMock.changeLog.createMany.mock.calls[0][0].data;
  expect(logs).toEqual(expect.arrayContaining([
    expect.objectContaining({ fieldName: "buildingName", oldValue: "パークハウス第一", newValue: "第一ビル" }),
    expect.objectContaining({ fieldName: "buildingId", oldValue: "b1", newValue: "b2" }),
  ]));
});

it("版番号が合わず0件なら apply を呼ばずに 409", async () => {
  txMock.property.updateMany.mockResolvedValue({ count: 0 });
  const res = await PATCH(req({ version: 1, buildingName: "別棟" }), ctx);
  expect(res.status).toBe(409);
  expect(applyMock).not.toHaveBeenCalled();
});

it("buildingChoice は物件の列として保存しない", async () => {
  applyMock.mockResolvedValue({ action: "kept", building: { id: "b1", name: "パークハウス第一" }, previousBuildingId: "b1", renamedFrom: null, warnings: [] });
  await PATCH(req({ version: 1, buildingChoice: { kind: "auto" } }), ctx);
  expect(txMock.property.updateMany.mock.calls[0][0].data).not.toHaveProperty("buildingChoice");
});
```

- [ ] **Step 7: 失敗を確かめる**

Run: `npx vitest run "src/app/api/properties/[id]/__tests__/building-link-patch.test.ts"`
Expected: FAIL

- [ ] **Step 8: PATCH を直す**

`src/app/api/properties/[id]/route.ts`:

1. `const { version, ...updateFields } = data;` → `const { version, buildingChoice, ...updateFields } = data;`
2. `current` の select に `buildingId: true,` を足す(`buildingName: true,` の下)。
3. `persistedFields` を作った直後に足す:

```ts
    // 棟へのつなぎ直しが要るか(設計 §4.4)。物件名・種別・住所のどれかが変わったとき、
    // または画面が棟を選んで送ってきたときだけ。⚠メモだけの保存で棟を触らない。
    const savedBuildingName =
      "buildingName" in persistedFields ? (persistedFields.buildingName ?? null) : current.buildingName;
    const effectiveAddress = updateFields.address ?? current.address;
    const touchesBuildingLink =
      buildingChoice !== undefined ||
      savedBuildingName !== current.buildingName ||
      effectiveType !== current.propertyType ||
      effectiveAddress !== current.address;
```

4. `guardedUpdate = await prisma.$transaction(async (tx) => { … return tx.property.updateMany(…) })` の末尾を次の形にする(ロック・鍵・担当の確認はそのまま):

```ts
      const res = await tx.property.updateMany({
        where: { /* 既存のまま */ },
        data: { ...persistedFields, version: { increment: 1 } },
      });
      // ⚠**書けたときだけ**棟へつなぐ(0件=版番号違い・取得中は下で 409)。
      if (res.count === 0 || !touchesBuildingLink) return { count: res.count, buildingLink: null };
      const buildingLink = await applyBuildingLink(tx, {
        propertyId: id,
        propertyType: effectiveType,
        buildingName: savedBuildingName,
        address: effectiveAddress,
        buildingNumber:
          updateFields.buildingNumber !== undefined ? updateFields.buildingNumber ?? null : current.buildingNumber,
        choice: buildingChoice ?? AUTO_CHOICE,
        currentBuildingId: current.buildingId,
        userId: session.id,
      });
      return { count: res.count, buildingLink };
```

`guardedUpdate.count === 0` の判定はそのまま使える。

5. 変更履歴を書く直前(`if (changeLogs.length > 0)` の前)に足す:

```ts
    const buildingLink = guardedUpdate.buildingLink;
    if (buildingLink) {
      const final = finalBuildingFields(buildingLink, savedBuildingName);
      // 物件名の履歴は「変更前 → 実際に残った名前(棟の正式な表記)」で作り直す。
      const idx = changeLogs.findIndex((c) => c.fieldName === "buildingName");
      if (idx >= 0) changeLogs.splice(idx, 1);
      if ((current.buildingName ?? null) !== final.buildingName) {
        changeLogs.push({
          targetTable: "properties", targetId: id, fieldName: "buildingName",
          oldValue: current.buildingName ?? null, newValue: final.buildingName,
          source: "manual", changedBy: session.id,
        });
      }
      if (final.buildingId !== undefined && final.buildingId !== (current.buildingId ?? null)) {
        changeLogs.push({
          targetTable: "properties", targetId: id, fieldName: "buildingId",
          oldValue: current.buildingId ?? null, newValue: final.buildingId,
          source: "manual", changedBy: session.id,
        });
      }
    }
```

6. 監査ログ `update` の後に `if (buildingLink) await writeBuildingLinkAudit(session.id, id, buildingLink);`
7. 応答: `return apiResponse({ ...updated, propertyOwners: maskedUpdatedPropertyOwners, buildingLink: buildingLink ?? null });`
8. 応答の `updated` の include に `building: { select: { id: true, name: true } }` が無ければ足す(画面が棟の名前を出し直すため)。

- [ ] **Step 9: 変更履歴の表示名を足す**

`src/components/properties/history-tab.tsx` の `FIELD_LABELS` に:

```ts
  buildingName: "物件名",
  buildingId: "棟",
```

- [ ] **Step 10: 通ることを確かめる**

Run: `npx vitest run src/app/api/properties`
Expected: PASS。既存の PATCH のテスト(`route.test.ts`・`edit-lock.test.ts` など)が `$transaction` の戻り値の形(`{count}` → `{count, buildingLink}`)や `@/lib/building-link/apply` の未 mock で落ちたら、mock 側を直す(`updateMany` の戻り値はそのまま・`applyBuildingLink` は `{ action: "none", … }` を返す mock)。

- [ ] **Step 11: Commit**

```bash
git add src/lib/validators.ts src/app/api/properties src/components/properties/history-tab.tsx
git commit -m "feat(building): 物件の新規登録と編集で棟へ自動でつなぐ"
```

---

### Task 5: 棟の作成・編集で key を入れる

**Files:**
- Modify: `src/app/api/buildings/route.ts`(POST)
- Modify: `src/app/api/buildings/[id]/route.ts`(PATCH)
- Test: `src/app/api/buildings/[id]/__tests__/identity-keys.test.ts`(新規)
- Test: `src/lib/__tests__/buildings-route-postal-code.test.ts`(既存・必要なら mock を直す)

**Interfaces:**
- Consumes: Task 3 の `buildingIdentityKeys(name, address)`

- [ ] **Step 1: 失敗するテストを書く**

`route-sales-fields.test.ts` の mock の形をそのまま写す。

```ts
// src/app/api/buildings/[id]/__tests__/identity-keys.test.ts(要点)
it("名前を変えたら name_key と area_key を入れ直す", async () => {
  pm.building.findUnique.mockResolvedValueOnce(EXISTING_BUILDING).mockResolvedValueOnce({ ...EXISTING_BUILDING, _count: { properties: 0 } });
  pm.building.updateMany.mockResolvedValue({ count: 1 });
  await PATCH(req({ version: 1, name: "パークハウス第二" }), ctx);
  expect(pm.building.updateMany.mock.calls[0][0].data).toMatchObject({
    name: "パークハウス第二", nameKey: "パークハウス第2", areaKey: expect.any(String),
  });
});
it("名前も住所も変えない保存では key を触らない", async () => {
  // … note だけ
  expect(pm.building.updateMany.mock.calls[0][0].data).not.toHaveProperty("nameKey");
});
```

POST(`src/app/api/buildings/route.ts`)は `src/lib/__tests__/buildings-route-postal-code.test.ts` に1件足す: `create` の data に `nameKey`・`areaKey` が入ること。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run "src/app/api/buildings/[id]/__tests__/identity-keys.test.ts" src/lib/__tests__/buildings-route-postal-code.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

POST の `prisma.building.create({ data: { name: data.name, address: data.address, …` に `...buildingIdentityKeys(data.name, data.address),` を足す。

PATCH の `updateData.version = { increment: 1 };` の直前に:

```ts
    // 名前か住所が変わったら、比べる形と町丁目を入れ直す(設計 §7)。
    if (updateData.name !== undefined || updateData.address !== undefined) {
      Object.assign(
        updateData,
        buildingIdentityKeys(
          String(updateData.name ?? existing.name),
          String(updateData.address ?? existing.address),
        ),
      );
    }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/app/api/buildings src/lib/__tests__/buildings-route-postal-code.test.ts`
Expected: PASS(既存の `route-sales-fields.test.ts` が data の完全一致で落ちたら、期待値に key を足す)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/buildings src/lib/__tests__/buildings-route-postal-code.test.ts
git commit -m "feat(building): 棟の作成・編集で比べる形と町丁目を入れる"
```

---

### Task 6: 貼り付けて物件化(Excel 取込も)と「部屋を追加」の不具合修正

**Files:**
- Modify: `src/app/api/import/paste/commit/route.ts`
- Modify: `src/app/api/buildings/[id]/properties/route.ts`(POST)
- Test: `src/app/api/import/paste/commit/__tests__/route.test.ts`(既存に追記)
- Test: `src/lib/__tests__/unit-create-postal-code.test.ts`(既存・期待値の更新)+ `src/app/api/buildings/[id]/__tests__/add-unit-building-link.test.ts`(新規)

**Interfaces:**
- Consumes: Task 3 の `applyBuildingLink`・`writeBuildingLinkAudit`、Task 4 の `buildingChoiceSchema`
- Produces: paste commit の応答 `{ propertyId, ownerId, buildingLink }`(Excel 取込の画面は `propertyId` しか読まないので互換)

- [ ] **Step 1: 失敗するテストを書く(paste commit)**

既存の `route.test.ts` の mock に `@/lib/building-link/apply` の mock を足し、次を追記:

```ts
it("物件を作った同じ tx の最後で棟へつなぐ(choice 省略=auto)", async () => {
  applyMock.mockResolvedValue({ action: "created", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [] });
  const res = await POST(jsonReq({ ...validBody, property: { ...validBody.property, propertyType: "apartment_unit", buildingName: "n" } }));
  expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
    propertyType: "apartment_unit", buildingName: "n", choice: { kind: "auto" }, currentBuildingId: null, buildingNumber: null,
  }));
  expect((await res.json()).buildingLink).toMatchObject({ action: "created" });
});
it("buildingChoice の形が不正なら 400", async () => {
  const res = await POST(jsonReq({ ...validBody, buildingChoice: { kind: "existing", buildingId: "x" } }));
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/app/api/import/paste/commit`
Expected: FAIL

- [ ] **Step 3: paste commit を直す**

1. `CommitBody` に `buildingChoice?: unknown;`(コメント「確認画面で選んだ棟。省略=auto」)。
2. 本文を読み終えた後(`externalLinkKey` を作る前)に:

```ts
    const choiceParsed = buildingChoiceSchema.optional().safeParse(body.buildingChoice);
    if (!choiceParsed.success) {
      throw new ApiError(400, "棟の選び方の形式が正しくありません", "BAD_REQUEST");
    }
    const buildingChoice = choiceParsed.data ?? AUTO_CHOICE;
```

3. トランザクションの `return { propertyId: property.id, ownerId, ownerCreated, attachmentId };` の直前に:

```ts
        // 棟へのつなぎは**最後**に行う(ロック順: この口のロック → 外部キー → 所有者 → 物件 → 棟の順番待ち)。
        const buildingLink = await applyBuildingLink(tx, {
          propertyId: property.id,
          propertyType,
          buildingName,
          address: p.address.trim(),
          buildingNumber: null,
          choice: buildingChoice,
          currentBuildingId: null,
          userId: session.id,
        });
```

`return` に `buildingLink` を足す。監査ログの後に `await writeBuildingLinkAudit(session.id, result.propertyId, result.buildingLink);`、応答を `apiResponse({ propertyId: result.propertyId, ownerId: result.ownerId, buildingLink: result.buildingLink })`。

- [ ] **Step 4: 失敗するテストを書く(部屋を追加)**

```ts
// src/app/api/buildings/[id]/__tests__/add-unit-building-link.test.ts(要点)
it("部屋を追加は区分マンション・物件名=棟の名前で作り、その棟へつなぐ", async () => {
  pm.building.findUnique.mockResolvedValue({ id: "b1", name: "パークハウス第一" });
  applyMock.mockResolvedValue({ action: "linked", building: { id: "b1", name: "パークハウス第一" }, previousBuildingId: null, renamedFrom: null, warnings: [] });
  const res = await POST(req({ address: "東京都大田区南雪谷1丁目1", roomNo: "101" }), ctx);
  expect(res.status).toBe(201);
  expect(txMock.property.create.mock.calls[0][0].data).toMatchObject({
    propertyType: "apartment_unit", buildingName: "パークハウス第一",
  });
  expect(txMock.property.create.mock.calls[0][0].data).not.toHaveProperty("buildingId");
  expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
    choice: { kind: "existing", buildingId: "b1" }, buildingName: "パークハウス第一",
  }));
});
```

- [ ] **Step 5: 部屋を追加を直す**

`src/app/api/buildings/[id]/properties/route.ts` の POST の `prisma.property.create(...)` を:

```ts
    // ⚠不具合修正(設計 §4.4): 以前は種別が旧値 "unit"・物件名が空だった。
    //   区分マンション・物件名=棟の名前で作り、つなぎは共通の処理を通す。
    const { property, buildingLink } = await prisma.$transaction(async (tx) => {
      const property = await tx.property.create({
        data: {
          propertyType: "apartment_unit",
          buildingName: building.name,
          address: data.address,
          // … buildingId を除き、既存の欄はそのまま …
          createdBy: session.id,
        },
      });
      const buildingLink = await applyBuildingLink(tx, {
        propertyId: property.id,
        propertyType: "apartment_unit",
        buildingName: building.name,
        address: data.address,
        buildingNumber: null,
        choice: { kind: "existing", buildingId: id },
        currentBuildingId: null,
        userId: session.id,
      });
      return { property, buildingLink };
    });
```

監査ログの detail の `propertyType` を `"apartment_unit"` に。その後 `await writeBuildingLinkAudit(session.id, property.id, buildingLink);`。応答は `apiResponse({ ...property, buildingId: id }, 201)`(作った直後の行は buildingId が空なので、つないだ値を載せる)。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/app/api/import/paste src/app/api/buildings src/lib/__tests__/unit-create-postal-code.test.ts`
Expected: PASS。`unit-create-postal-code.test.ts` が `propertyType: "unit"` を期待していたら `"apartment_unit"` に直す(仕様変更=不具合修正)。`$transaction` の mock が無ければ足す。

- [ ] **Step 7: Commit**

```bash
git add src/app/api/import/paste/commit src/app/api/buildings src/lib/__tests__/unit-create-postal-code.test.ts
git commit -m "feat(building): 貼り付けて物件化と部屋を追加で棟へつなぐ(部屋を追加の種別と物件名の不具合を修正)"
```

---

### Task 7: CSV 取込と取込行の確定(`__resolved_building_id` の不具合修正)

**Files:**
- Create: `src/lib/building-link/csv-resolve.ts`
- Modify: `src/app/api/import/csv/route.ts`
- Modify: `src/lib/import-row-field-map.ts`
- Modify: `src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts`
- Modify: `src/app/api/import/jobs/[jobId]/rows/[rowId]/retry/route.ts`
- Modify: `.env.example`・`deploy/env/app.env.example`・`docs/deploy.md`(`UNIT_IMPORT_BUILDING_NOT_FOUND` を消す)
- Test: `src/lib/building-link/__tests__/csv-resolve.test.ts`
- Test: `src/lib/__tests__/import-row-field-map-building.test.ts`
- Test: `src/app/api/import/jobs/[jobId]/rows/[rowId]/__tests__/route.test.ts`(既存に追記)

**Interfaces:**
- Consumes: Task 1・2・3
- Produces:

```ts
// csv-resolve.ts
export type CsvBuildingResolution =
  | { kind: "link"; buildingId: string }
  | { kind: "create" }
  | { kind: "review"; error: string; candidates: { id: string; name: string; address: string }[] };
export interface CsvBuildingRow { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; createdAt: Date; unitCount: number }
export function decideCsvBuilding(input: { buildingName: string; address: string | undefined; sameKey: CsvBuildingRow[]; others: CsvBuildingRow[] }): CsvBuildingResolution;
export async function resolveCsvBuilding(db: CsvResolveDb, buildingName: string, address: string | undefined, cache: Map<string, CsvBuildingResolution>): Promise<CsvBuildingResolution>;
// import-row-field-map.ts
export function buildingChoiceFromRow(data: Record<string, string>): BuildingChoice;
```

方針(CSV は人が候補を選べない一括処理なので、D2 を次のように当てる):
- 同じ町丁目・同じ比べる形の棟がある → `link`(複数なら `decideBuildingLink` と同じ選び方)
- 無いが、**比べる形が同じ別の町丁目の棟**か、**名前が部分一致する棟**がある → `review`(候補つき=要確認。以前の「部分一致1件なら黙ってつなぐ」は D2 に反するのでやめる)
- どれも無い → `create`(実際の作成は物件を作るトランザクションの中で `applyBuildingLink` が行う)
- ⚠`create` の結果は**キャッシュしない**(同じ取込の次の行は、前の行が作った棟を見つけて link する=Review Focus 4)。

- [ ] **Step 1: 失敗するテストを書く(判断)**

```ts
// src/lib/building-link/__tests__/csv-resolve.test.ts
import { describe, it, expect } from "vitest";
import { decideCsvBuilding, resolveCsvBuilding, type CsvBuildingRow } from "@/lib/building-link/csv-resolve";

const row = (id: string, name: string, address: string, unitCount = 1): CsvBuildingRow => ({
  id, name, address, nameKey: null, areaKey: null, createdAt: new Date("2026-01-01"), unitCount,
});
const ADDR = "東京都大田区南雪谷1丁目164-2-45";

describe("decideCsvBuilding", () => {
  it("同じ町丁目・同じ比べる形があれば link", () => {
    expect(decideCsvBuilding({ buildingName: "第１ビル", address: ADDR, sameKey: [row("a", "第一ビル", "東京都大田区南雪谷1丁目164-2")], others: [] }))
      .toEqual({ kind: "link", buildingId: "a" });
  });
  it("別の町丁目の同名棟だけなら review(黙ってつながない)", () => {
    const d = decideCsvBuilding({ buildingName: "第１ビル", address: ADDR, sameKey: [], others: [row("b", "第一ビル", "東京都大田区南雪谷2丁目1")] });
    expect(d.kind).toBe("review");
  });
  it("部分一致が1件でも review", () => {
    const d = decideCsvBuilding({ buildingName: "パーク", address: ADDR, sameKey: [], others: [row("c", "パークハイツ", "東京都港区六本木1丁目1")] });
    expect(d).toMatchObject({ kind: "review", candidates: [{ id: "c" }] });
  });
  it("何も無ければ create", () => {
    expect(decideCsvBuilding({ buildingName: "新ビル", address: ADDR, sameKey: [], others: [] })).toEqual({ kind: "create" });
  });
});

describe("resolveCsvBuilding のキャッシュ", () => {
  it("create は覚えない(次の行は前の行が作った棟を見つける)", async () => {
    const buildings: Array<CsvBuildingRow> = [];
    const db = {
      building: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          buildings
            .filter((b) => ("areaKey" in where ? b.areaKey === where.areaKey && b.nameKey === where.nameKey : true))
            .map((b) => ({ ...b, _count: { properties: b.unitCount } })),
      },
    };
    const cache = new Map();
    expect(await resolveCsvBuilding(db as never, "新ビル", ADDR, cache)).toEqual({ kind: "create" });
    buildings.push({ ...row("n1", "新ビル", "東京都大田区南雪谷1丁目164-2"), nameKey: "新ビル", areaKey: "東京都大田区南雪谷1丁目" });
    expect(await resolveCsvBuilding(db as never, "新ビル", ADDR, cache)).toEqual({ kind: "link", buildingId: "n1" });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/csv-resolve.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/csv-resolve.ts
/**
 * CSV 取込の棟の解決(設計 2026-10-04 §4.4)。CSV は人が候補を選べないので、
 * 同じ町丁目・同じ比べる形だけを自動でつなぎ、紛らわしい候補があれば要確認に回す。
 * 実際の作成・つなぎは物件を作るトランザクションの中で applyBuildingLink が行う。
 */
import type { Prisma } from "@prisma/client";
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import { decideBuildingLink, AUTO_CHOICE } from "./resolve";

export type CsvBuildingResolution =
  | { kind: "link"; buildingId: string }
  | { kind: "create" }
  | { kind: "review"; error: string; candidates: { id: string; name: string; address: string }[] };

export interface CsvBuildingRow {
  id: string; name: string; address: string;
  nameKey: string | null; areaKey: string | null;
  createdAt: Date; unitCount: number;
}

const REVIEW_CANDIDATE_LIMIT = 10;
const NULL_KEY_SCAN_LIMIT = 500;

export function decideCsvBuilding(input: {
  buildingName: string;
  address: string | undefined;
  sameKey: CsvBuildingRow[];
  others: CsvBuildingRow[];
}): CsvBuildingResolution {
  const nameKey = buildingNameKey(input.buildingName);
  const area = areaKey(input.address);
  if (nameKey && area && input.sameKey.length > 0) {
    const d = decideBuildingLink({
      propertyType: "apartment_unit",
      buildingName: input.buildingName,
      nameKey,
      areaKey: area,
      choice: AUTO_CHOICE,
      current: null,
      chosen: null,
      candidates: input.sameKey.map((b) => ({ id: b.id, name: b.name, unitCount: b.unitCount, createdAt: b.createdAt })),
    });
    if (d.kind === "link") return { kind: "link", buildingId: d.buildingId };
  }
  const seen = new Set(input.sameKey.map((b) => b.id));
  const candidates = input.others
    .filter((b) => !seen.has(b.id))
    .slice(0, REVIEW_CANDIDATE_LIMIT)
    .map((b) => ({ id: b.id, name: b.name, address: b.address }));
  if (candidates.length > 0) {
    return {
      kind: "review",
      error: `棟名「${input.buildingName}」に似た棟が${candidates.length}件あります。同じ建物ならレビュー画面で選んでください`,
      candidates,
    };
  }
  return { kind: "create" };
}

type Row = { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; createdAt: Date; _count: { properties: number } };
/** prisma 本体も tx も渡せる(テストは `as never` で偽物を渡す)。 */
export type CsvResolveDb = { building: Pick<Prisma.TransactionClient["building"], "findMany"> };

const toRow = (b: Row): CsvBuildingRow => ({
  id: b.id, name: b.name, address: b.address, nameKey: b.nameKey, areaKey: b.areaKey, createdAt: b.createdAt, unitCount: b._count.properties,
});

export async function resolveCsvBuilding(
  db: CsvResolveDb,
  buildingName: string,
  address: string | undefined,
  cache: Map<string, CsvBuildingResolution>,
): Promise<CsvBuildingResolution> {
  const nameKey = buildingNameKey(buildingName);
  const area = areaKey(address);
  const cacheKey = `${nameKey ?? ""}|||${area ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const select = { id: true, name: true, address: true, nameKey: true, areaKey: true, createdAt: true, _count: { select: { properties: true } } };
  const sameKey = nameKey && area
    ? (await db.building.findMany({ where: { areaKey: area, nameKey }, select })).map(toRow)
    : [];
  // key が null の古い棟は、その場で計算して振り分ける(CSV は読むだけ=埋めるのは apply 側)。
  const unkeyed = (await db.building.findMany({ where: { nameKey: null }, select, take: NULL_KEY_SCAN_LIMIT, orderBy: { createdAt: "asc" } })).map(toRow);
  const others: CsvBuildingRow[] = [];
  for (const b of unkeyed) {
    const k = buildingNameKey(b.name);
    const a = areaKey(b.address);
    if (k === nameKey && a === area && area !== null) sameKey.push(b);
    else if (k === nameKey || b.name.includes(buildingName.trim())) others.push(b);
  }
  if (nameKey) {
    const sameNameOtherArea = (await db.building.findMany({ where: { nameKey }, select, take: REVIEW_CANDIDATE_LIMIT })).map(toRow);
    const partial = (await db.building.findMany({
      where: { name: { contains: buildingName.trim() } }, select, take: REVIEW_CANDIDATE_LIMIT,
    })).map(toRow);
    for (const b of [...sameNameOtherArea, ...partial]) {
      if (!others.some((o) => o.id === b.id)) others.push(b);
    }
  }
  const result = decideCsvBuilding({ buildingName, address, sameKey, others });
  // ⚠create は覚えない(同じ取込の次の行は、前の行が作った棟を link で見つける)。
  if (result.kind !== "create") cache.set(cacheKey, result);
  return result;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/csv-resolve.test.ts`
Expected: PASS

- [ ] **Step 5: CSV の route を直す**

`src/app/api/import/csv/route.ts`:
1. `UNIT_BUILDING_NOT_FOUND`・`BuildingLookupCache`・`BuildingCandidate`・`BuildingResolution`・`resolveBuildingId` を削除し、`findBuildingByNormalizedName`・`normalizeBuildingName` の import が他で使われていなければ消す(`npx eslint` で確かめる)。
2. `buildingCache` の宣言を `const buildingCache = new Map<string, CsvBuildingResolution>();` に。
3. 区分の解決の部分(`const resolution = await resolveBuildingId(...)` から `resolvedBuildingId = resolution.buildingId;` まで)を:

```ts
          const resolution = await resolveCsvBuilding(prisma, mapped.buildingName.trim(), mapped.address, buildingCache);
          if (resolution.kind === "review") {
            const enrichedRawRow = { ...rawRow };
            enrichedRawRow["__building_candidates"] = JSON.stringify(resolution.candidates);
            jobRows.push({
              jobId: job.id, rowNumber, status: "needs_review", rawData: enrichedRawRow,
              errorMessage: resolution.error, createdId: null,
            });
            continue;
          }
          resolvedBuildingId = resolution.kind === "link" ? resolution.buildingId : null;
          buildingChoiceForRow = resolution.kind === "link"
            ? { kind: "existing", buildingId: resolution.buildingId }
            : AUTO_CHOICE;
```

`let resolvedBuildingId` の隣に `let buildingChoiceForRow: BuildingChoice | null = null;` を足す。

4. 新規作成の部分: `if (resolvedBuildingId) createData.buildingId = resolvedBuildingId;` を消し、`createData.buildingName` に `mapped.buildingName?.trim() || null`(種別が区分のときだけ=`normalizeBuildingName(createData.propertyType, mapped.buildingName)` from `@/lib/property-building-name`)を入れる。`prisma.property.create(...)` を:

```ts
        const { property, buildingLink } = await prisma.$transaction(async (tx) => {
          const property = await tx.property.create({
            data: createData as Parameters<typeof prisma.property.create>[0]["data"],
          });
          const buildingLink = buildingChoiceForRow
            ? await applyBuildingLink(tx, {
                propertyId: property.id,
                propertyType: property.propertyType,
                buildingName: property.buildingName,
                address: property.address,
                buildingNumber: property.buildingNumber,
                choice: buildingChoiceForRow,
                currentBuildingId: null,
                userId: session.id,
              })
            : null;
          return { property, buildingLink };
        });
        if (buildingLink) {
          await writeBuildingLinkAudit(session.id, property.id, buildingLink);
          resolvedBuildingId = buildingLink.building?.id ?? resolvedBuildingId;
        }
```

その下の `buildingId: property.buildingId ?? null` は `buildingId: resolvedBuildingId` に(作った直後の行には入っていないため)。`commitBuildingPostalCode()` は `resolvedBuildingId` を見るのでそのまま。

5. 重複で既存物件を更新する経路(`dupHit`)は**変えない**(既存の物件を棟へ付け替えない=範囲外)。

- [ ] **Step 6: 取込行の確定を直す(不具合修正)**

`src/lib/import-row-field-map.ts`:
- `JAPANESE_FIELD_MAP` に `"棟名": "buildingName", "マンション名": "buildingName", "物件名": "buildingName",` を足す。
- `resolvePropertyField` の `directFields` に `"buildingName"` を足す。
- `buildPropertyCreateData` の `if (mapped.buildingNumber) …` の下に:

```ts
  // ⚠CSV 取込と同じ規則: 物件名がある行は区分マンションとして作る
  //   (以前は物件名を読まず、要確認から確定すると物件名も棟も落ちていた)。
  if (mapped.buildingName?.trim()) {
    createData.propertyType = "apartment_unit";
    createData.buildingName = mapped.buildingName.trim();
  }
```

- 新しい関数:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 要確認の画面で選んだ棟(`__resolved_building_id`)を、確定時の棟の選び方にする。 */
export function buildingChoiceFromRow(data: Record<string, string>): BuildingChoice {
  const id = (data["__resolved_building_id"] ?? "").trim();
  return UUID_RE.test(id) ? { kind: "existing", buildingId: id.toLowerCase() } : AUTO_CHOICE;
}
```

テスト(`src/lib/__tests__/import-row-field-map-building.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyCreateData, buildingChoiceFromRow } from "@/lib/import-row-field-map";

describe("取込行の確定で棟を落とさない", () => {
  it("マンション名の列を物件名にし、区分マンションで作る", () => {
    const d = buildPropertyCreateData({ "住所": "東京都大田区南雪谷1丁目1", "マンション名": "パーク第一" }, "u");
    expect(d).toMatchObject({ propertyType: "apartment_unit", buildingName: "パーク第一" });
  });
  it("選んだ棟は existing(小文字)", () => {
    expect(buildingChoiceFromRow({ __resolved_building_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))
      .toEqual({ kind: "existing", buildingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });
  it("無い・形が違うなら auto", () => {
    expect(buildingChoiceFromRow({})).toEqual({ kind: "auto" });
    expect(buildingChoiceFromRow({ __resolved_building_id: "x" })).toEqual({ kind: "auto" });
  });
});
```

`rows/[rowId]/route.ts` の `create_new`・`property_csv` と `retry/route.ts` の同じ箇所を:

```ts
        const createData = buildPropertyCreateData(sourceData, session.id);
        const { property, buildingLink } = await prisma.$transaction(async (tx) => {
          const property = await tx.property.create({
            data: createData as Parameters<typeof prisma.property.create>[0]["data"],
          });
          const buildingLink = await applyBuildingLink(tx, {
            propertyId: property.id,
            propertyType: property.propertyType,
            buildingName: property.buildingName,
            address: property.address,
            buildingNumber: property.buildingNumber,
            choice: buildingChoiceFromRow(sourceData),
            currentBuildingId: null,
            userId: session.id,
          });
          return { property, buildingLink };
        });
        await writeBuildingLinkAudit(session.id, property.id, buildingLink);
        createdRecord = property;
```

(retry 側は `sourceData` を `mergedData` に読み替える。)既存の `rows/[rowId]/__tests__/route.test.ts` に「`__resolved_building_id` を選んで create_new すると apply に existing が渡る」を1件足し、`$transaction`・apply の mock を足す。

- [ ] **Step 7: 環境変数の記載を消す**

`.env.example`・`deploy/env/app.env.example` の `UNIT_IMPORT_BUILDING_NOT_FOUND=needs_review` の行と、`docs/deploy.md` の3か所(表の2行・例の1行)を消す。本番の `app.env` に残っていても無害(読まれない)であることを PR 本文に書く。

- [ ] **Step 8: 通ることを確かめる**

Run: `npx vitest run src/app/api/import src/lib/__tests__/import-row-field-map-building.test.ts src/lib/building-link`
Expected: PASS(CSV の既存テストが `resolveBuildingId` の挙動=部分一致1件で link・auto_create を前提にしていたら、新しい方針の期待値に直し、直した理由をテストのコメントに書く)

- [ ] **Step 9: Commit**

```bash
git add src/lib/building-link src/app/api/import src/lib/import-row-field-map.ts src/lib/__tests__/import-row-field-map-building.test.ts .env.example deploy/env/app.env.example docs/deploy.md
git commit -m "feat(building): CSV取込と取込行の確定で棟へつなぐ(要確認で選んだ棟が効かない不具合を修正)"
```

---

### Task 8: 段1の全ゲート・提出前レビュー・PR

- [ ] **Step 1: 全ゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt 2>&1; echo tsc=$?
npx vitest run > /tmp/vitest.txt 2>&1; echo vitest=$?
npx eslint $(git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx') > /tmp/eslint.txt 2>&1; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```

Expected: 4つとも `=0`。

- [ ] **Step 2: 手元の実 DB で確かめる**(`local-dev-env-setup` メモの手順で起動)

1. `npx prisma migrate deploy` が通る。
2. 新規登録で区分マンション・物件名「テスト第一」→ 棟が1件できて、物件詳細の「マンション棟」欄に出る。
3. もう1件、同じ丁目の住所で「テスト第１」→ 同じ棟につながり、物件名が「テスト第一」になる。
4. 棟の画面「部屋を追加」→ 種別が区分マンション・物件名が棟の名前。

- [ ] **Step 3: 提出前レビュー**

`git add -A` の後、`feature-dev:code-reviewer`(sonnet)に staged diff を渡し、観点を指定: 「トランザクションとロック順(物件の行 → アドバイザリロック/棟の行 → 部屋の行)・`$executeRaw`+`::bigint`・認可(property:write/import:write)・監査ログに住所を入れていないか・既存テストの期待値を緩めていないか・旧値 unit の扱い」。P1/P2 は直す。

- [ ] **Step 4: PR**

ship スキルの手順で commit → push → `gh pr create --title "feat(building): 区分マンションを保存時に棟へ自動でつなぐ(段1)"`。本文(日本語)に: 何が変わるか・migration(ADD のみ・2列+index)・不具合2件・CSV の方針変更(部分一致1件で黙ってつながない/棟が無ければ作る)・環境変数の廃止・画面は段2。→ codex-triage スキルで @codex レビューと到着監視。**マージはユーザー。**

---

# 段 2(PR 2): 候補つき入力欄・保存後の知らせ・付け替えの確認

段1がマージされた main から新しい worktree `building-suggest` を切る(1タスク=1worktree)。Task 0 と同じ準備をする。

### Task 9: 候補の API(`GET /api/buildings/suggest`)

**Files:**
- Create: `src/lib/building-link/suggest.ts`
- Create: `src/app/api/buildings/suggest/route.ts`
- Test: `src/lib/building-link/__tests__/suggest.test.ts`
- Test: `src/app/api/buildings/suggest/__tests__/route.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BuildingSuggestion {
  id: string; name: string; area: string; unitCount: number;
  sameName: boolean; sameArea: boolean;
}
export const SUGGEST_MIN_KEY_LENGTH = 2;
export const SUGGEST_LIMIT = 10;
export function rankBuildingSuggestions(
  rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; unitCount: number; createdAt: Date }[],
  target: { nameKey: string; areaKey: string | null },
): BuildingSuggestion[];
// GET /api/buildings/suggest?name=…&address=… → { data: BuildingSuggestion[] }
```

- [ ] **Step 1: 失敗するテストを書く(並べ方)**

```ts
// src/lib/building-link/__tests__/suggest.test.ts
import { describe, it, expect } from "vitest";
import { rankBuildingSuggestions } from "@/lib/building-link/suggest";

const r = (id: string, name: string, address: string, unitCount = 1) => ({
  id, name, address, nameKey: null, areaKey: null, unitCount, createdAt: new Date("2026-01-01"),
});
const target = { nameKey: "パーク第1", areaKey: "東京都大田区南雪谷1丁目" };

describe("rankBuildingSuggestions", () => {
  it("同じ名前・同じ丁目 → 同じ名前・別の丁目 → 部分一致 の順", () => {
    const out = rankBuildingSuggestions([
      r("p", "パーク第一ハイツ", "東京都港区六本木1丁目1"),
      r("o", "パーク第一", "東京都大田区南雪谷2丁目1"),
      r("s", "パーク第１", "東京都大田区南雪谷1丁目164-2"),
    ], target);
    expect(out.map((x) => x.id)).toEqual(["s", "o", "p"]);
    expect(out[0]).toMatchObject({ sameName: true, sameArea: true });
    expect(out[1]).toMatchObject({ sameName: true, sameArea: false });
  });
  it("住所は町丁目までに丸める(番地を出さない)", () => {
    const [s] = rankBuildingSuggestions([r("s", "パーク第１", "東京都大田区南雪谷1丁目164-2")], target);
    expect(s.area).toBe("東京都大田区南雪谷1丁目");
    expect(JSON.stringify(s)).not.toContain("164");
  });
  it("最大10件", () => {
    const rows = Array.from({ length: 15 }, (_, i) => r(`x${i}`, `パーク第一${i}`, "東京都港区六本木1丁目1"));
    expect(rankBuildingSuggestions(rows, target)).toHaveLength(10);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run src/lib/building-link/__tests__/suggest.test.ts` / Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/suggest.ts
/** 物件名の候補の並べ方(設計 2026-10-04 §5)。DB を触らない純関数。 */
import { areaKey, buildingNameKey } from "@/lib/building-identity";

export interface BuildingSuggestion {
  id: string; name: string; area: string; unitCount: number;
  sameName: boolean; sameArea: boolean;
}
export const SUGGEST_MIN_KEY_LENGTH = 2;
export const SUGGEST_LIMIT = 10;

export function rankBuildingSuggestions(
  rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; unitCount: number; createdAt: Date }[],
  target: { nameKey: string; areaKey: string | null },
): BuildingSuggestion[] {
  const scored = rows.map((b) => {
    const nk = b.nameKey ?? buildingNameKey(b.name);
    const ak = b.areaKey ?? areaKey(b.address);
    const sameName = nk === target.nameKey;
    const sameArea = target.areaKey !== null && ak === target.areaKey;
    const rank = sameName && sameArea ? 0 : sameName ? 1 : 2;
    return { b, ak, sameName, sameArea, rank };
  });
  scored.sort(
    (x, y) => x.rank - y.rank || y.b.unitCount - x.b.unitCount || x.b.createdAt.getTime() - y.b.createdAt.getTime(),
  );
  return scored.slice(0, SUGGEST_LIMIT).map(({ b, ak, sameName, sameArea }) => ({
    id: b.id, name: b.name, area: ak ?? "", unitCount: b.unitCount, sameName, sameArea,
  }));
}
```

```ts
// src/app/api/buildings/suggest/route.ts
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import { rankBuildingSuggestions, SUGGEST_MIN_KEY_LENGTH } from "@/lib/building-link/suggest";

/** 1回に読む棟の上限(並べ替え前)。 */
const FETCH_LIMIT = 50;

// ---------- GET /api/buildings/suggest?name=…&address=… ----------
// 物件名の入力欄の候補(設計 §5)。⚠棟の住所は町丁目までに丸めて返す。
export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 100);
    const nameKey = buildingNameKey(name);
    if (!nameKey || nameKey.length < SUGGEST_MIN_KEY_LENGTH) return apiResponse({ data: [] });
    const target = { nameKey, areaKey: areaKey(url.searchParams.get("address")) };
    const select = { id: true, name: true, address: true, nameKey: true, areaKey: true, createdAt: true, _count: { select: { properties: true } } } as const;
    const rows = await prisma.building.findMany({
      where: { OR: [{ nameKey }, { name: { contains: name, mode: "insensitive" } }, { nameKey: null }] },
      select,
      take: FETCH_LIMIT,
      orderBy: { createdAt: "asc" },
    });
    const filtered = rows.filter((b) => {
      const nk = b.nameKey ?? buildingNameKey(b.name);
      return nk === nameKey || b.name.toLowerCase().includes(name.toLowerCase()) || (nk ?? "").includes(nameKey);
    });
    const data = rankBuildingSuggestions(
      filtered.map((b) => ({ ...b, unitCount: b._count.properties })),
      target,
    );
    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
```

route のテスト(`route-sales-fields.test.ts` と同じ mock の形): ①`property:read` が無いと 403 ②name が1文字なら DB を引かずに `[]` ③応答に番地が含まれない。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/lib/building-link src/app/api/buildings/suggest` / Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(building): 物件名の候補API"`

---

### Task 10: 候補つき入力欄の部品

**Files:**
- Create: `src/lib/building-link/combobox-model.ts`
- Create: `src/components/buildings/building-name-combobox.tsx`
- Test: `src/lib/building-link/__tests__/combobox-model.test.ts`
- Test: `src/components/buildings/__tests__/building-name-combobox.test.tsx`

**Interfaces:**
- Consumes: Task 9 の `BuildingSuggestion`・`SUGGEST_MIN_KEY_LENGTH`、Task 2 の `BuildingChoice`
- Produces:

```ts
// combobox-model.ts
export function shouldFetchSuggestions(name: string): boolean;
export function isLatestRequest(seq: number, latest: number): boolean;
export function nextActiveIndex(current: number, key: "ArrowDown" | "ArrowUp", optionCount: number): number;
export function suggestionBadges(s: BuildingSuggestion): string[];  // ["同じ名前"] / ["同じ名前","丁目が違います"]
export function choiceSummary(choice: BuildingChoice, selected: BuildingSuggestion | null): string | null;
// building-name-combobox.tsx
export interface BuildingNameComboboxProps {
  id: string; testId?: string;
  value: string; onChange: (name: string) => void;
  address: string;
  choice: BuildingChoice; onChoiceChange: (choice: BuildingChoice) => void;
  disabled?: boolean; placeholder?: string; inputClassName?: string;
}
export default function BuildingNameCombobox(props: BuildingNameComboboxProps): JSX.Element;
export function BuildingSuggestionList(props: { suggestions: BuildingSuggestion[]; activeIndex: number; onPick: (s: BuildingSuggestion | "new") => void; listId: string }): JSX.Element;
```

- [ ] **Step 1: 失敗するテストを書く(純関数)**

```ts
// src/lib/building-link/__tests__/combobox-model.test.ts
import { describe, it, expect } from "vitest";
import { shouldFetchSuggestions, isLatestRequest, nextActiveIndex, suggestionBadges, choiceSummary } from "@/lib/building-link/combobox-model";

const s = { id: "b1", name: "パーク第一", area: "東京都大田区南雪谷1丁目", unitCount: 3, sameName: true, sameArea: true };

describe("combobox-model", () => {
  it("比べる形で2文字から候補を引く", () => {
    expect(shouldFetchSuggestions("パ")).toBe(false);
    expect(shouldFetchSuggestions(" パー ")).toBe(true);
  });
  it("古い応答は捨てる", () => {
    expect(isLatestRequest(1, 2)).toBe(false);
    expect(isLatestRequest(2, 2)).toBe(true);
  });
  it("上下キーは一番下の『新しい棟として登録する』まで回る", () => {
    expect(nextActiveIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(0, "ArrowUp", 3)).toBe(2);
  });
  it("印", () => {
    expect(suggestionBadges(s)).toEqual(["同じ名前"]);
    expect(suggestionBadges({ ...s, sameArea: false })).toEqual(["同じ名前", "丁目が違います"]);
    expect(suggestionBadges({ ...s, sameName: false, sameArea: false })).toEqual([]);
  });
  it("選んだ内容の一文", () => {
    expect(choiceSummary({ kind: "existing", buildingId: "b1" }, s)).toBe("棟「パーク第一」(東京都大田区南雪谷1丁目・3部屋)につなぎます");
    expect(choiceSummary({ kind: "new" }, null)).toBe("新しい棟として登録します");
    expect(choiceSummary({ kind: "auto" }, null)).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Expected: FAIL

- [ ] **Step 3: 実装する(純関数)**

```ts
// src/lib/building-link/combobox-model.ts
/** 物件名の候補つき入力欄の判断(設計 §6.1)。React に依存しない。 */
import { buildingNameKey } from "@/lib/building-identity";
import type { BuildingChoice } from "./resolve";
import { SUGGEST_MIN_KEY_LENGTH, type BuildingSuggestion } from "./suggest";

export function shouldFetchSuggestions(name: string): boolean {
  return (buildingNameKey(name) ?? "").length >= SUGGEST_MIN_KEY_LENGTH;
}
export function isLatestRequest(seq: number, latest: number): boolean {
  return seq === latest;
}
export function nextActiveIndex(current: number, key: "ArrowDown" | "ArrowUp", optionCount: number): number {
  if (optionCount <= 0) return -1;
  if (key === "ArrowDown") return current + 1 >= optionCount ? 0 : current + 1;
  return current - 1 < 0 ? optionCount - 1 : current - 1;
}
export function suggestionBadges(s: BuildingSuggestion): string[] {
  if (!s.sameName) return [];
  return s.sameArea ? ["同じ名前"] : ["同じ名前", "丁目が違います"];
}
export function choiceSummary(choice: BuildingChoice, selected: BuildingSuggestion | null): string | null {
  if (choice.kind === "new") return "新しい棟として登録します";
  if (choice.kind === "existing" && selected) {
    return `棟「${selected.name}」(${selected.area || "住所不明"}・${selected.unitCount}部屋)につなぎます`;
  }
  return null;
}
```

- [ ] **Step 4: 部品を作る**

```tsx
// src/components/buildings/building-name-combobox.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import type { BuildingSuggestion } from "@/lib/building-link/suggest";
import {
  choiceSummary,
  isLatestRequest,
  nextActiveIndex,
  shouldFetchSuggestions,
  suggestionBadges,
} from "@/lib/building-link/combobox-model";

export interface BuildingNameComboboxProps {
  id: string;
  testId?: string;
  value: string;
  onChange: (name: string) => void;
  address: string;
  choice: BuildingChoice;
  onChoiceChange: (choice: BuildingChoice) => void;
  disabled?: boolean;
  placeholder?: string;
  inputClassName?: string;
}

/** 候補の一覧(SSR テストのため切り出す)。一番下は常に「新しい棟として登録する」(D8)。 */
export function BuildingSuggestionList({
  suggestions,
  activeIndex,
  onPick,
  listId,
}: {
  suggestions: BuildingSuggestion[];
  activeIndex: number;
  onPick: (s: BuildingSuggestion | "new") => void;
  listId: string;
}) {
  return (
    <ul
      id={listId}
      role="listbox"
      className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      {suggestions.map((s, i) => (
        <li
          key={s.id}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
          className={`flex min-h-[44px] cursor-pointer flex-col justify-center px-3 py-1.5 text-sm ${
            i === activeIndex ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
          }`}
        >
          <span className="flex flex-wrap items-center gap-1 text-gray-900 dark:text-gray-100">
            {s.name}
            {suggestionBadges(s).map((b) => (
              <span
                key={b}
                className={`rounded px-1 text-[10px] ${
                  b === "丁目が違います"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    : "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                }`}
              >
                {b}
              </span>
            ))}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {s.area || "住所不明"}・{s.unitCount}部屋
          </span>
        </li>
      ))}
      <li
        role="option"
        aria-selected={activeIndex === suggestions.length}
        onMouseDown={(e) => {
          e.preventDefault();
          onPick("new");
        }}
        className={`flex min-h-[44px] cursor-pointer items-center border-t border-gray-100 px-3 text-sm text-indigo-700 dark:border-gray-800 dark:text-indigo-300 ${
          activeIndex === suggestions.length ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
        }`}
      >
        新しい棟として登録する
      </li>
    </ul>
  );
}

export default function BuildingNameCombobox(props: BuildingNameComboboxProps) {
  const { id, testId, value, onChange, address, choice, onChoiceChange, disabled, placeholder, inputClassName } = props;
  // 候補は「どの入力に対する結果か」と一緒に持つ。入力と一致するときだけ出す
  // (⚠effect の中で同期的に setState しない=eslint react-hooks/set-state-in-effect)。
  const [result, setResult] = useState<{ query: string; data: BuildingSuggestion[] }>({ query: "", data: [] });
  const suggestions = result.query === value ? result.data : [];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<BuildingSuggestion | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    // ⚠打ち直したら古い候補を無効にする(連番を進める)。
    seqRef.current += 1;
    const seq = seqRef.current;
    if (!shouldFetchSuggestions(value)) return;
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ name: value, address });
        const res = await fetch(`/api/buildings/suggest?${qs.toString()}`);
        if (!res.ok || !isLatestRequest(seq, seqRef.current)) return;
        const body = (await res.json()) as { data: BuildingSuggestion[] };
        if (isLatestRequest(seq, seqRef.current)) setResult({ query: value, data: body.data });
      } catch {
        // 候補が出なくても入力と保存は止めない(保存時に自動で判断する)。
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, address]);

  const pick = (s: BuildingSuggestion | "new") => {
    if (s === "new") {
      setSelected(null);
      onChoiceChange({ kind: "new" });
    } else {
      setSelected(s);
      onChange(s.name);
      onChoiceChange({ kind: "existing", buildingId: s.id });
    }
    setOpen(false);
    setActiveIndex(-1);
  };

  const optionCount = suggestions.length + 1;
  const listId = `${id}-suggestions`;
  const summary = choiceSummary(choice, selected);

  return (
    <div className="relative">
      <input
        id={id}
        data-testid={testId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        className={inputClassName}
        onChange={(e) => {
          onChange(e.target.value);
          // 打ち直したら選択を外して自動の判断に戻す(§6.1)。
          if (choice.kind !== "auto") onChoiceChange({ kind: "auto" });
          setSelected(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open || !shouldFetchSuggestions(value)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((cur) => nextActiveIndex(cur, e.key as "ArrowDown" | "ArrowUp", optionCount));
          } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            pick(activeIndex === suggestions.length ? "new" : suggestions[activeIndex]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && shouldFetchSuggestions(value) && (
        <BuildingSuggestionList suggestions={suggestions} activeIndex={activeIndex} onPick={pick} listId={listId} />
      )}
      {summary && (
        <p data-testid={testId ? `${testId}-choice` : undefined} className="mt-1 text-xs text-indigo-700 dark:text-indigo-300">
          {summary}
        </p>
      )}
    </div>
  );
}
```

SSR テスト(`building-name-combobox.test.tsx`): `renderToStaticMarkup(<BuildingSuggestionList …/>)` で ①最後の行が「新しい棟として登録する」 ②「丁目が違います」の印 ③各行に `min-h-[44px]` ④部屋数の表示。

- [ ] **Step 5: 通ることを確かめる** — Run: `npx vitest run src/lib/building-link src/components/buildings` / Expected: PASS

- [ ] **Step 6: Commit** — `git commit -m "feat(building): 物件名の候補つき入力欄"`

---

### Task 11: 保存後の知らせ

**Files:**
- Create: `src/lib/building-link/notice.ts`
- Create: `src/components/buildings/building-link-notice.tsx`
- Test: `src/lib/building-link/__tests__/notice.test.ts`
- Test: `src/components/buildings/__tests__/building-link-notice.test.tsx`

**Interfaces:**
- Consumes: Task 3 の `BuildingLinkOutcome`
- Produces:

```ts
export interface BuildingNoticeLine { tone: "info" | "warn"; text: string; href?: string; hrefLabel?: string }
export function buildingLinkNoticeLines(outcome: BuildingLinkOutcome | null | undefined): BuildingNoticeLine[];
export function stashBuildingLinkNotice(propertyId: string, outcome: BuildingLinkOutcome | null | undefined): void;
export function takeBuildingLinkNotice(propertyId: string): BuildingLinkOutcome | null;
// building-link-notice.tsx
export function BuildingLinkNotice(props: { outcome: BuildingLinkOutcome | null; onClose: () => void }): JSX.Element | null;
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/building-link/__tests__/notice.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildingLinkNoticeLines, stashBuildingLinkNotice, takeBuildingLinkNotice } from "@/lib/building-link/notice";

const o = (over = {}) => ({ action: "linked" as const, building: { id: "b1", name: "パーク第一" }, previousBuildingId: null, renamedFrom: null, warnings: [] as ("duplicate_names" | "area_unknown")[], ...over });

describe("buildingLinkNoticeLines", () => {
  it("link", () => expect(buildingLinkNoticeLines(o())[0].text).toBe("棟「パーク第一」につなぎました"));
  it("そろえたときは入力を添える", () =>
    expect(buildingLinkNoticeLines(o({ renamedFrom: "パーク第１" }))[0].text).toBe("棟「パーク第一」につなぎました(入力: パーク第１)"));
  it("create は確認のお願いと棟の画面へのリンク", () => {
    const [l] = buildingLinkNoticeLines(o({ action: "created" }));
    expect(l).toMatchObject({ text: "棟「パーク第一」を新しく作りました。正式な表記か確認してください", href: "/buildings/b1" });
  });
  it("注意", () => {
    const lines = buildingLinkNoticeLines(o({ warnings: ["duplicate_names"] }));
    expect(lines.map((l) => l.text)).toContain("同じ名前の棟が複数あります。棟の一覧で確かめてください");
    const lines2 = buildingLinkNoticeLines(o({ action: "created", warnings: ["area_unknown"] }));
    expect(lines2.map((l) => l.text)).toContain("住所から町丁目を読み取れなかったため、新しい棟として作りました");
  });
  it("kept でそろえていなければ何も出さない・none も出さない", () => {
    expect(buildingLinkNoticeLines(o({ action: "kept" }))).toEqual([]);
    expect(buildingLinkNoticeLines(null)).toEqual([]);
  });
  it("外したとき", () =>
    expect(buildingLinkNoticeLines(o({ action: "unlinked", building: null }))[0].text).toBe("棟から外しました"));
});

describe("stash/take", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("1回だけ取り出せる", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    stashBuildingLinkNotice("p1", o());
    expect(takeBuildingLinkNotice("p1")).toMatchObject({ action: "linked" });
    expect(takeBuildingLinkNotice("p1")).toBeNull();
  });
  it("sessionStorage が使えなくても落ちない", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => {} });
    expect(() => stashBuildingLinkNotice("p1", o())).not.toThrow();
    expect(takeBuildingLinkNotice("p1")).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/notice.ts
/** 保存後の知らせ(設計 §6.2)。新規登録は画面が移るので sessionStorage で1回だけ渡す。 */
import type { BuildingLinkOutcome } from "./apply";

export interface BuildingNoticeLine { tone: "info" | "warn"; text: string; href?: string; hrefLabel?: string }

export function buildingLinkNoticeLines(outcome: BuildingLinkOutcome | null | undefined): BuildingNoticeLine[] {
  if (!outcome) return [];
  const lines: BuildingNoticeLine[] = [];
  const b = outcome.building;
  if (outcome.action === "created" && b) {
    lines.push({ tone: "info", text: `棟「${b.name}」を新しく作りました。正式な表記か確認してください`, href: `/buildings/${b.id}`, hrefLabel: "棟の画面を開く" });
  } else if ((outcome.action === "linked" || (outcome.action === "kept" && outcome.renamedFrom)) && b) {
    lines.push({ tone: "info", text: `棟「${b.name}」につなぎました${outcome.renamedFrom ? `(入力: ${outcome.renamedFrom})` : ""}` });
  } else if (outcome.action === "unlinked") {
    lines.push({ tone: "info", text: "棟から外しました" });
  }
  if (outcome.warnings.includes("duplicate_names")) {
    lines.push({ tone: "warn", text: "同じ名前の棟が複数あります。棟の一覧で確かめてください", href: "/buildings", hrefLabel: "棟の一覧" });
  }
  if (outcome.warnings.includes("area_unknown")) {
    lines.push({ tone: "warn", text: "住所から町丁目を読み取れなかったため、新しい棟として作りました" });
  }
  return lines;
}

const KEY_PREFIX = "building-link-notice:";

export function stashBuildingLinkNotice(propertyId: string, outcome: BuildingLinkOutcome | null | undefined): void {
  if (!outcome || buildingLinkNoticeLines(outcome).length === 0) return;
  try {
    sessionStorage.setItem(KEY_PREFIX + propertyId, JSON.stringify(outcome));
  } catch {
    // 出せなくても保存は済んでいる(知らせが出ないだけ)。
  }
}

export function takeBuildingLinkNotice(propertyId: string): BuildingLinkOutcome | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + propertyId);
    if (!raw) return null;
    sessionStorage.removeItem(KEY_PREFIX + propertyId);
    return JSON.parse(raw) as BuildingLinkOutcome;
  } catch {
    return null;
  }
}
```

⚠`notice.ts` は画面からも読むので、`apply.ts` からは **型だけ** import する(`import type`)。`apply.ts` 本体(prisma・api-helpers)をクライアントに持ち込まない。

```tsx
// src/components/buildings/building-link-notice.tsx
"use client";

import Link from "next/link";
import { X } from "lucide-react";
import type { BuildingLinkOutcome } from "@/lib/building-link/apply";
import { buildingLinkNoticeLines } from "@/lib/building-link/notice";

export function BuildingLinkNotice({ outcome, onClose }: { outcome: BuildingLinkOutcome | null; onClose: () => void }) {
  const lines = buildingLinkNoticeLines(outcome);
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid="building-link-notice" className="mb-3 flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      <ul className="flex-1 space-y-1">
        {lines.map((l) => (
          <li key={l.text} className={l.tone === "warn" ? "text-amber-800 dark:text-amber-300" : "text-indigo-900 dark:text-indigo-200"}>
            {l.text}
            {l.href && (
              <Link href={l.href} className="ml-2 underline hover:no-underline">
                {l.hrefLabel}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClose} aria-label="閉じる" className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
```

SSR テスト: created のとき `href="/buildings/b1"` と文言、outcome=null で空文字。

- [ ] **Step 4: 通ることを確かめる** — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(building): 棟へつないだあとの知らせ"`

---

### Task 12: 新規登録・編集・貼り付けの画面に組み込む(付け替えの確認つき)

**Files:**
- Modify: `src/lib/api-client.ts`(`createProperty` の戻り値と引数)
- Modify: `src/components/properties/new-property-modal.tsx`
- Modify: `src/components/properties/property-edit-form.tsx`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`
- Modify: `src/components/import/paste-import-review.tsx`・`src/app/(dashboard)/import/paste/page.tsx`
- Create: `src/lib/building-link/relink.ts`
- Test: `src/lib/building-link/__tests__/relink.test.ts`
- Test: 既存の `new-property-modal`・`property-edit-form`・`paste-import-review` の SSR/走査テストに追記

**Interfaces:**
- Consumes: Task 10 の `BuildingNameCombobox`、Task 11 の `BuildingLinkNotice`・`stashBuildingLinkNotice`・`takeBuildingLinkNotice`
- Produces:

```ts
// relink.ts
export function relinkConfirmMessage(
  current: { id: string; name: string } | null,
  newName: string,
  choice: BuildingChoice,
): string | null;
// property-edit-form.tsx
onSaved: (result?: { buildingLink?: BuildingLinkOutcome | null }) => void;
```

- [ ] **Step 1: 失敗するテストを書く(付け替えの確認)**

```ts
// src/lib/building-link/__tests__/relink.test.ts
import { describe, it, expect } from "vitest";
import { relinkConfirmMessage } from "@/lib/building-link/relink";

const cur = { id: "b1", name: "パーク第一" };
describe("relinkConfirmMessage", () => {
  it("比べる形が違う名前にしたら確認する", () =>
    expect(relinkConfirmMessage(cur, "別ビル", { kind: "auto" })).toBe("棟「パーク第一」から付け替えます。よろしいですか？"));
  it("比べる形が同じ(打ち直し)なら確認しない", () =>
    expect(relinkConfirmMessage(cur, "パーク第１", { kind: "auto" })).toBeNull());
  it("空にしたら外す確認", () =>
    expect(relinkConfirmMessage(cur, "  ", { kind: "auto" })).toBe("棟「パーク第一」から外します。よろしいですか？"));
  it("同じ棟を選び直したなら確認しない", () =>
    expect(relinkConfirmMessage(cur, "パーク第一", { kind: "existing", buildingId: "b1" })).toBeNull());
  it("別の棟を選んだら確認する", () =>
    expect(relinkConfirmMessage(cur, "別ビル", { kind: "existing", buildingId: "b2" })).not.toBeNull());
  it("新しい棟として登録を選んだら確認する", () =>
    expect(relinkConfirmMessage(cur, "パーク第一", { kind: "new" })).not.toBeNull());
  it("棟につながっていなければ確認しない", () =>
    expect(relinkConfirmMessage(null, "別ビル", { kind: "auto" })).toBeNull());
});
```

- [ ] **Step 2: 失敗を確かめる** — Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/relink.ts
/** 編集で物件名を変えたときの付け替えの確認(D4・設計 §6.3)。 */
import { buildingNameKey } from "@/lib/building-identity";
import type { BuildingChoice } from "./resolve";

export function relinkConfirmMessage(
  current: { id: string; name: string } | null,
  newName: string,
  choice: BuildingChoice,
): string | null {
  if (!current) return null;
  if (newName.trim() === "") return `棟「${current.name}」から外します。よろしいですか？`;
  if (choice.kind === "existing") {
    return choice.buildingId === current.id ? null : `棟「${current.name}」から付け替えます。よろしいですか？`;
  }
  if (choice.kind === "new") return `棟「${current.name}」から付け替えます。よろしいですか？`;
  return buildingNameKey(newName) === buildingNameKey(current.name)
    ? null
    : `棟「${current.name}」から付け替えます。よろしいですか？`;
}
```

- [ ] **Step 4: 新規登録の画面**

1. `src/lib/api-client.ts` の `createProperty` の引数に `buildingChoice?: BuildingChoice;`、戻り値を `Promise<{ id: string; buildingLink?: BuildingLinkOutcome | null }>` に(型は `import type`)。
2. `new-property-modal.tsx`: `const [buildingChoice, setBuildingChoice] = useState<BuildingChoice>(AUTO_CHOICE);`。物件名の欄を、`propertyType === "apartment_unit"` のときは `<BuildingNameCombobox id="new-property-building-name" testId="new-property-building-name" value={buildingName} onChange={setBuildingName} address={address} choice={buildingChoice} onChoiceChange={setBuildingChoice} disabled={submitting} placeholder="例: リガーレ西荻マンション" inputClassName="…既存の input の className…" />` に、それ以外は既存の `<input>` のまま。種別を変えたら `setBuildingChoice(AUTO_CHOICE)`。
3. 送信に `buildingChoice: propertyType === "apartment_unit" ? buildingChoice : undefined` を足し、成功したら `stashBuildingLinkNotice(result.id, result.buildingLink)` してから遷移。
4. 既存の SSR/走査テスト(`new-property-modal` の `data-testid="new-property-building-name"` を見るもの)が通ることを確かめ、`buildingChoice` を送ることの走査テストを1件足す。

- [ ] **Step 5: 編集の画面**

`property-edit-form.tsx`:
1. `PropertyData` に `building` の `id`・`name` が無ければ足す(親が渡している `property.building` を確認)。
2. `const [buildingChoice, setBuildingChoice] = useState<BuildingChoice>(AUTO_CHOICE);`
3. 項目の描画で `field.key === "buildingName" && (values.propertyType ?? property.propertyType) === "apartment_unit"` のときだけ `BuildingNameCombobox` を出す(`onChange={(v) => handleChange("buildingName", v)}`・`address={values.address ?? property.address}`)。
4. `handleSave` の検証のあと・`setSaving(true)` の前に:

```ts
    if ((values.propertyType ?? property.propertyType) === "apartment_unit") {
      const nameChanged = (values.buildingName ?? "") !== (property.buildingName ?? "");
      const msg = nameChanged || buildingChoice.kind !== "auto"
        ? relinkConfirmMessage(property.building ?? null, values.buildingName ?? "", buildingChoice)
        : null;
      if (msg && !window.confirm(msg)) return;
    }
```

5. payload に `if (buildingChoice.kind !== "auto") payload.buildingChoice = buildingChoice;`
6. 成功したら `const saved = await res.json().catch(() => null);` → `onSaved({ buildingLink: saved?.buildingLink ?? null })`。

`properties/[id]/page.tsx`:
1. `const [buildingNotice, setBuildingNotice] = useState<BuildingLinkOutcome | null>(null);`
2. 新規登録・貼り付けからの知らせは、**物件の読み込みが終わった後**(既存の読み込み処理の非同期の続き=`then` の中)で `setBuildingNotice(takeBuildingLinkNotice(id))` として1回だけ取り出す。⚠effect の中で同期的に set しない(eslint `react-hooks/set-state-in-effect`)。⚠`useState` の初期化関数で取り出すのも不可(サーバー描画と最初の画面描画が食い違う=hydration の警告)。
3. `onSaved={(r) => { setShowEditForm(false); setBuildingNotice(r?.buildingLink ?? null); … }}`
4. ページ上部(タブの上)に `<BuildingLinkNotice outcome={buildingNotice} onClose={() => setBuildingNotice(null)} />`。

- [ ] **Step 6: 貼り付けて物件化の確認画面**

1. `paste-import-review.tsx` の props に `buildingChoice?: BuildingChoice; onBuildingChoiceChange?: (c: BuildingChoice) => void;` を足し、`PROPERTY_FIELD_LABELS.map` の中で `f.key === "buildingName" && propertyValues.propertyType === "apartment_unit" && onBuildingChoiceChange` のときだけ `BuildingNameCombobox` を描く(見出しは既存の「建物名」のまま。下に「つなぐ先の棟」と出るのは `choiceSummary`)。
2. `import/paste/page.tsx`: `buildingChoice` の state を持ち、`body` に `buildingChoice: propertyValues.propertyType === "apartment_unit" ? buildingChoice : undefined` を足す。成功したら `stashBuildingLinkNotice(result.propertyId, result.buildingLink)` → 遷移。`CommitApiResponse` 型に `buildingLink?` を足す。
3. Excel のまとめ取込(`excel/page.tsx`・`excel-lead-commit-body.ts`)は**変えない**(1行ずつ人が選ばない=auto)。

- [ ] **Step 7: 通ることを確かめる**

Run: `npx vitest run src/components src/lib/building-link "src/app/(dashboard)"`
Expected: PASS

- [ ] **Step 8: 手元の実画面で確かめる**

1. 新規登録・区分マンション・「テスト第１」と打つ → 候補に「テスト第一」が「同じ名前」の印つきで出る → 選ぶと「棟『テスト第一』(…・N部屋)につなぎます」→ 登録すると物件詳細の上に「棟『テスト第一』につなぎました」。
2. 一番下の「新しい棟として登録する」→ 登録すると「新しく作りました。正式な表記か確認してください」+棟の画面へのリンク。
3. 編集で物件名を別の名前に → 保存の前に「棟『テスト第一』から付け替えます」の確認。キャンセルで保存されない。
4. 上下キー・Enter・Esc が効く。スマホ幅で行が押しやすい高さ。
5. 貼り付けて物件化で種別を区分マンションにすると候補が出る。

- [ ] **Step 9: Commit** — `git commit -m "feat(building): 物件名の候補・付け替えの確認・保存後の知らせを画面に組み込む"`

### Task 13(段2の締め): 全ゲート・提出前レビュー・PR

Task 8 と同じ手順。レビューの観点: 候補 API の認可(property:read)・応答に番地を出していないか・古い応答の破棄・クライアントに `apply.ts` 本体(prisma)を持ち込んでいないか(`import type` だけか)・sessionStorage の try/catch・confirm のキャンセルで保存されないか・ダークモード。PR タイトル `feat(building): 物件名の候補と棟へつないだ知らせ(段2)`。

---

# 段 3(PR 3): 棟の名前の全部屋への反映・写真タブの案内を常に出す

段2がマージされた main から worktree `building-rename`。Task 0 と同じ準備。

### Task 14: 棟の名前を全部屋に反映する(編集中の鍵があれば止める)

**Files:**
- Create: `src/lib/building-link/rename.ts`
- Modify: `src/app/api/buildings/[id]/route.ts`(PATCH)
- Modify: `src/app/(dashboard)/buildings/[id]/page.tsx`(`handleSave`)
- Test: `src/lib/building-link/__tests__/rename.test.ts`
- Test: `src/app/api/buildings/[id]/__tests__/rename-propagate.test.ts`
- Test: `src/app/api/buildings/[id]/__tests__/route-sales-fields.test.ts`(既存・`$transaction` の mock を足す)

**Interfaces:**
- ⚠**段1の最終レビューで判明(2026-10-05)**: 物件の保存が `buildingId` を書くと、外部キーの確認で棟の行に `FOR KEY SHARE` が掛かる。棟の名前の反映が棟の行を `FOR UPDATE` で取ると、これとぶつかり、待ちの輪(物件の行を持つ保存 × 部屋の行を待つ反映)になりうる。**棟の行は `FOR NO KEY UPDATE` で取ること**(`lockBuildingRow` が `FOR UPDATE` なら、反映用に `FOR NO KEY UPDATE` の版を足す)。テストで SQL に `FOR NO KEY UPDATE` が入ることを確かめる。
- Consumes: `lockBuildingRow(tx, id)`(`src/lib/edit-lock/row-locks.ts`)・`EDIT_LOCK_HEARTBEAT_GRACE_MS`・`EDIT_LOCK_IDLE_LIMIT_MS`(`src/lib/edit-lock/rules.ts`)・Task 3 の `buildingIdentityKeys`
- Produces:

```ts
export function renamePropagateConfirmMessage(oldName: string, newName: string, unitCount: number): string | null;
export function isBuildingRename(oldName: string, newName: string | undefined): boolean;
export async function countEditLockedUnits(tx: { $queryRaw: … }, buildingId: string): Promise<number>;
export async function propagateBuildingName(tx: …, input: { buildingId: string; newName: string; userId: string }): Promise<{ updated: number; changeLogs: ChangeLogInput[] }>;
```

- [ ] **Step 1: 失敗するテストを書く(純関数と SQL)**

```ts
// src/lib/building-link/__tests__/rename.test.ts
import { describe, it, expect, vi } from "vitest";
import { renamePropagateConfirmMessage, isBuildingRename, countEditLockedUnits } from "@/lib/building-link/rename";

describe("rename", () => {
  it("部屋があるときだけ確認する", () => {
    expect(renamePropagateConfirmMessage("旧", "新", 3)).toBe("部屋3件の物件名も「新」に直します。よろしいですか？");
    expect(renamePropagateConfirmMessage("旧", "新", 0)).toBeNull();
    expect(renamePropagateConfirmMessage("同じ", " 同じ ", 3)).toBeNull();
  });
  it("前後の空白だけの違いは名前の変更ではない", () => {
    expect(isBuildingRename("A", " A ")).toBe(false);
    expect(isBuildingRename("A", undefined)).toBe(false);
    expect(isBuildingRename("A", "B")).toBe(true);
  });
  it("編集中の鍵の数え方: 解除されておらず、合図と操作が期限内のものだけ(DB の時計で)", async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ n: 2 }]) };
    expect(await countEditLockedUnits(tx as never, "b1")).toBe(2);
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/"force_released_at" IS NULL/);
    expect(sql).toMatch(/clock_timestamp\(\)/);
    expect(sql).toMatch(/"building_id" = \?::uuid/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/building-link/rename.ts
/**
 * 棟の名前を、つながっている全部屋の物件名へ反映する(D3・D11・設計 §6.3)。
 * ⚠ロック順: **棟の行 → 部屋の行**(apply.ts は棟の行をロックしないので逆順は無い)。
 * ⚠誰かが部屋を編集中(編集中の鍵)なら反映せず止める。誰が編集中かは返さない(件数だけ)。
 */
import type { Prisma } from "@prisma/client";
import { EDIT_LOCK_HEARTBEAT_GRACE_MS, EDIT_LOCK_IDLE_LIMIT_MS } from "@/lib/edit-lock/rules";

const GRACE_SEC = EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000;
const IDLE_SEC = EDIT_LOCK_IDLE_LIMIT_MS / 1000;

export function isBuildingRename(oldName: string, newName: string | undefined): boolean {
  return newName !== undefined && newName.trim() !== oldName.trim();
}

export function renamePropagateConfirmMessage(oldName: string, newName: string, unitCount: number): string | null {
  if (unitCount <= 0 || !isBuildingRename(oldName, newName)) return null;
  return `部屋${unitCount}件の物件名も「${newName.trim()}」に直します。よろしいですか？`;
}

export async function countEditLockedUnits(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  buildingId: string,
): Promise<number> {
  // ⚠期限は DB の時計で見る(service.ts の assertNotEditLockedByOther と同じ式)。
  // ⚠make_interval の秒は ::double precision を明示(service.ts の注記と同じ理由)。
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "edit_locks" l JOIN "properties" p ON p."id" = l."resource_id"
    WHERE l."resource_type" = 'property'::"EditLockResource"
      AND p."building_id" = ${buildingId}::uuid
      AND l."force_released_at" IS NULL
      AND l."heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
      AND l."activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
  `;
  return rows[0]?.n ?? 0;
}

export interface RenameChangeLog {
  targetTable: "properties"; targetId: string; fieldName: "buildingName";
  oldValue: string | null; newValue: string; source: "manual"; changedBy: string;
}

export async function propagateBuildingName(
  tx: Pick<Prisma.TransactionClient, "property">,
  input: { buildingId: string; newName: string; userId: string },
): Promise<{ updated: number; changeLogs: RenameChangeLog[] }> {
  const units = await tx.property.findMany({
    // ⚠`NOT: { buildingName: X }` だけだと物件名が null の部屋を拾わない(SQL の <> は NULL を除く)。
    where: {
      buildingId: input.buildingId,
      OR: [{ buildingName: null }, { NOT: { buildingName: input.newName } }],
    },
    select: { id: true, buildingName: true },
  });
  if (units.length === 0) return { updated: 0, changeLogs: [] };
  const res = await tx.property.updateMany({
    where: { id: { in: units.map((u) => u.id) } },
    data: { buildingName: input.newName, version: { increment: 1 } },
  });
  return {
    updated: res.count,
    changeLogs: units.map((u) => ({
      targetTable: "properties", targetId: u.id, fieldName: "buildingName",
      oldValue: u.buildingName, newValue: input.newName, source: "manual", changedBy: input.userId,
    })),
  };
}
```

 テストで物件名が null の部屋も直ることを確かめる。

- [ ] **Step 4: PATCH /api/buildings/[id] に組み込む**

`updateMany` の部分を次に置き換える(`isBuildingRename(existing.name, updateFields.name)` のときだけトランザクションで反映。それ以外は既存のまま):

```ts
    const renaming = isBuildingRename(existing.name, updateFields.name as string | undefined);
    if (renaming) updateData.name = String(updateFields.name).trim();
    const { count, propagated } = await prisma.$transaction(async (tx) => {
      if (renaming) await lockBuildingRow(tx, id);
      const updated = await tx.building.updateMany({ where: { id, version }, data: updateData });
      if (updated.count === 0 || !renaming) return { count: updated.count, propagated: null };
      const locked = await countEditLockedUnits(tx, id);
      if (locked > 0) {
        throw new ApiError(
          409,
          `この棟の部屋${locked}件が編集中のため、名前を全部屋に反映できません。編集が終わってから保存してください`,
          "UNITS_EDIT_LOCKED",
        );
      }
      const propagated = await propagateBuildingName(tx, { buildingId: id, newName: updateData.name as string, userId: session.id });
      if (propagated.changeLogs.length > 0) await tx.changeLog.createMany({ data: propagated.changeLogs });
      return { count: updated.count, propagated };
    });
    if (count === 0) { /* 既存の 409 CONFLICT をそのまま投げる */ }
```

監査ログ `update` の後に `if (propagated) await writeAuditLog({ userId: session.id, action: "building.rename_propagate", targetTable: "buildings", targetId: id, detail: { updatedUnits: propagated.updated } });`。

テスト(`rename-propagate.test.ts`): ①名前を変えて編集中の鍵が0なら部屋の物件名がそろい版番号が進み、監査ログに件数 ②鍵が1件以上なら 409 `UNITS_EDIT_LOCKED` で、部屋も棟も更新されない(propagate が呼ばれない・トランザクションごと失敗)③名前を変えない保存では lockBuildingRow も countEditLockedUnits も呼ばない ④応答・エラーに編集中の人の名前が入らない。

- [ ] **Step 5: 棟の画面に確認を出す**

`src/app/(dashboard)/buildings/[id]/page.tsx` の `handleSave` の先頭(`setSaving(true)` の前)に:

```ts
    const msg = renamePropagateConfirmMessage(building.name, editForm.name, building._count.properties);
    if (msg && !window.confirm(msg)) return;
```

⚠`rename.ts` は prisma の**型**しか import しないので画面から読んでよい(実行時に prisma を持ち込まない)。ただし `@/lib/edit-lock/rules` が実行時依存を持つなら、`renamePropagateConfirmMessage`・`isBuildingRename` を `src/lib/building-link/rename-message.ts` に分けて画面はそちらを読む(build でクライアント bundle に prisma が入らないことを確かめる)。

- [ ] **Step 6: 通ることを確かめる** — Run: `npx vitest run src/lib/building-link src/app/api/buildings "src/app/(dashboard)/buildings"` / Expected: PASS(`route-sales-fields.test.ts` は `$transaction: vi.fn(async (cb) => cb(prismaMock))` を足して通す)

- [ ] **Step 7: Commit** — `git commit -m "feat(building): 棟の名前を直したら全部屋の物件名に反映する(編集中の部屋があれば止める)"`

---

### Task 15: 写真タブの案内を常に出す(3通り)

**Files:**
- Modify: `src/components/properties/photo-tab-building-hint.tsx`
- Modify: `src/components/properties/photo-tab.tsx`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`
- Test: `src/components/properties/__tests__/photo-tab-building-hint.test.tsx`(既存なら追記・無ければ新規)

**Interfaces:**
- Produces: `PhotoTabBuildingHint({ propertyType, building, onEditProperty }: { propertyType: string; building: { id: string; name: string } | null; onEditProperty?: () => void })`

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// src/components/properties/__tests__/photo-tab-building-hint.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoTabBuildingHint } from "../photo-tab-building-hint";

describe("PhotoTabBuildingHint", () => {
  it("区分マンション・棟あり: 棟写真へのリンク", () => {
    const html = renderToStaticMarkup(<PhotoTabBuildingHint propertyType="apartment_unit" building={{ id: "b1", name: "パーク第一" }} />);
    expect(html).toContain('href="/buildings/b1#building-photos"');
    expect(html).toContain("共用部・外観");
  });
  it("区分マンション・棟なし: 物件名を入れると棟につながる案内と編集ボタン", () => {
    const html = renderToStaticMarkup(<PhotoTabBuildingHint propertyType="apartment_unit" building={null} onEditProperty={() => {}} />);
    expect(html).toContain("物件名(マンション名)を入れると棟につながり、共用部・外観の写真を部屋どうしで共有できます");
    expect(html).toContain("<button");
  });
  it("区分マンション・棟なし・編集できない: ボタンは出さない", () => {
    const html = renderToStaticMarkup(<PhotoTabBuildingHint propertyType="apartment_unit" building={null} />);
    expect(html).not.toContain("<button");
  });
  it("それ以外: この物件の写真です。", () => {
    const html = renderToStaticMarkup(<PhotoTabBuildingHint propertyType="land" building={null} />);
    expect(html).toContain("この物件の写真です。");
    expect(html).not.toContain("<a");
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Expected: FAIL

- [ ] **Step 3: 実装する**

`photo-tab-building-hint.tsx` の関数を次にする(`BUILDING_PHOTOS_ANCHOR` はそのまま):

```tsx
/**
 * 物件写真タブ見出し下の案内文(常に出す・設計 §6.4)。
 * - 区分マンション・棟あり: 共用部・外観の写真を置く棟写真へのリンク
 * - 区分マンション・棟なし: 物件名を入れると棟につながる案内(+編集を開くボタン)
 * - それ以外: この物件の写真であることだけ
 */
export function PhotoTabBuildingHint({
  propertyType,
  building,
  onEditProperty,
}: {
  propertyType: string;
  building: { id: string; name: string } | null;
  onEditProperty?: () => void;
}) {
  const textClass = "mt-0.5 text-xs text-gray-500 dark:text-gray-400";
  if (propertyType === "apartment_unit" && building) {
    return (
      <p className={textClass}>
        この物件単体の写真です。共用部・外観などの棟全体写真は
        <Link
          href={`/buildings/${building.id}#${BUILDING_PHOTOS_ANCHOR}`}
          className="mx-1 inline-flex items-center gap-0.5 font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          <Building2 className="h-3.5 w-3.5" />
          {building.name || "棟の詳細"}の棟写真
        </Link>
        をご利用ください。
      </p>
    );
  }
  if (propertyType === "apartment_unit") {
    return (
      <p className={textClass}>
        この物件単体の写真です。物件名(マンション名)を入れると棟につながり、共用部・外観の写真を部屋どうしで共有できます。
        {onEditProperty && (
          <button
            type="button"
            onClick={onEditProperty}
            className="ml-1 font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
          >
            物件名を入れる
          </button>
        )}
      </p>
    );
  }
  return <p className={textClass}>この物件の写真です。</p>;
}
```

`photo-tab.tsx`: props に `propertyType: string` と `onEditProperty?: () => void` を足し、`<PhotoTabBuildingHint propertyType={propertyType} building={building ?? null} onEditProperty={onEditProperty} />`。

`properties/[id]/page.tsx`: `<PhotoTab propertyId={property.id} propertyType={property.propertyType} building={…既存…} onEditProperty={canEdit ? () => setShowEditForm(true) : undefined} />`(`canEdit` は既存の「編集」ボタンの表示条件と同じ変数を使う。無ければその条件式をそのまま)。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/components/properties` / Expected: PASS(写真タブの既存テストが props の不足で落ちたら `propertyType` を足す)

- [ ] **Step 5: Commit** — `git commit -m "fix(photo): 写真タブの案内を全物件で常に出す(区分マンションは棟の有無で出し分け)"`

---

### Task 16(段3の締め): 全ゲート・手元確認・PR・資料

- [ ] **Step 1: 全ゲート**(Task 8 Step 1 と同じ)
- [ ] **Step 2: 手元の実画面**: ①棟の名前を変える → 「部屋N件の物件名も…直します」→ OK で全部屋の物件名がそろう ②別のタブで部屋の編集を開いたまま棟の名前を変える → 「部屋1件が編集中のため…」で止まり、棟の名前も変わらない ③写真タブ: 区分・棟あり=リンク/区分・棟なし=案内+「物件名を入れる」で編集が開く/土地=「この物件の写真です。」
- [ ] **Step 3: 提出前レビュー**(観点: ロック順=棟の行→部屋の行・トランザクションごと失敗するか・編集中の人の名前を返していないか・クライアント bundle に prisma が入っていないか・ダークモード)
- [ ] **Step 4: PR** `feat(building): 棟の名前の全部屋への反映と写真タブの案内(段3)` → @codex → マージはユーザー
- [ ] **Step 5: 資料の更新**(マージ後): `C:\Users\issin\Desktop\Claude\system-docs\` の使い方ガイド・マニュアルに「物件名を入れると棟に自動でつながる・候補の見方・棟の名前を直すと全部屋に反映」を追記し、古い「棟は手で作る」記載を消す。Artifact 2本を同じ URL で再公開し、アプリ内の `public/docs/guide.html`・`manual.html` も同期(別 PR)。文言は実コードで裏取りしてから書く。
- [ ] **Step 6: 実機確認リストの 172 を直す**: 「棟につながっている物件」の前提を「物件名を入れて保存した区分マンション」に書き換え、段1〜3の確認項目を追加する(Artifact 版を上げる)。
