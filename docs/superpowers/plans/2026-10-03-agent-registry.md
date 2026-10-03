# 国交省の業者一覧(反響の受付の候補) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 国交省の「建設業者・宅建業者等企業情報検索システム」から、国土交通大臣免許と東京都・神奈川県・埼玉県・千葉県の知事免許の宅建業者(約5万社)を、本番サーバーで夜間に少しずつ集めて「国交省の業者一覧」に持つ。受付の窓で業者を探したとき、名簿に無ければこの一覧からも候補を出し、選んだ瞬間に名簿へ写す。

**Architecture:** 一覧は名簿(`agents`)とは別の表 `mlit_agents` に持つ。集める処理は「1回の呼び出しで数分だけ進めて、進み具合を表に残す」口 `POST /api/agent-registry/crawl-run` にし、systemd の timer が夜間10分ごとに叩く(巡回の自動終了・添付お掃除と同じ型・合言葉が未設定なら 503=休眠)。ページの読み取りは純関数(HTML→値)、進め方は純関数の状態遷移に分け、どちらも実物のHTMLの並びを写した見本でテストする。

**Tech Stack:** Next.js 16 app router / Prisma + Postgres / vitest(node 環境) / Node の `fetch` と `TextDecoder("shift_jis")`(新しい依存なし)

**Spec:** 本書の「決めたこと」と、親の設計 `docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md`(名簿=電話帳型・会社情報のみ・電話番号で引く)。

## 決めたこと(発注者 2026-10-03)
- D1 対象=**国土交通大臣免許・東京都知事免許・神奈川県知事免許・埼玉県知事免許・千葉県知事免許**の宅建業者だけ(市区町村での絞り込みなし)。
- D2 先方(国交省)へは問い合わせず、御社の判断で集める(先方のサイトに禁止の定めは無い=発注者確認)。→ 先方に負担をかけない作りを必須にする(下の G1〜G4)。
- D3 集めた業者は**名簿とは別の「国交省の業者一覧」**に持つ。受付の窓で選んだときだけ名簿へ写す。名簿は「実際に関わった業者」のまま。
- D4 集める処理は**本番サーバーで夜間に自動**。スイッチ(合言葉)は最初は未設定=動かない。

## Global Constraints
- G1 アクセスは**同時に1本だけ**・**1回ごとに4秒以上あける**・夜間 **22:00〜翌7:00(日本時間)だけ**動く。
- G2 先方が 200 以外を返したら(429・503・500・タイムアウト・想定外の画面)**その回はすぐ止め**、エラーを表に残す。続けて3回失敗したら**その日は止める**(翌晩に再開)。
- G3 先方の画面の作りが変わって読めなくなったら(件数・列が取れない)止めて記録する。**推測で読まない**。
- G4 名乗り(User-Agent)は正直に書く: `property-management agent-registry (low-rate; ligarejapan.com)`。
- G5 **個人名は取らない・持たない**: 代表者名・政令使用人・宅建士の名前は読み捨てる。持つのは商号・ふりがな・免許番号・主たる事務所の所在地・電話番号・免許の有効期間だけ。
- G6 新しい依存は足さない。migration は**追加だけ**(新しい表2つ・`agents` に NULL 可の列1つ)。
- G7 画面の文言は平易な日本語。一覧から来た候補には「国交省の一覧」と分かる印を付ける。

## 先方の画面の仕組み(2026-10-03 の試しの3回で確認)
- 検索: `POST https://etsuran2.mlit.go.jp/TAKKEN/takkenKensaku.do`(cp932)。`CMD=search`・`licenseNoKbn=<00|11|12|13|14>`・`dispCount=50`・`sortValue=1`(免許証番号順)。セッション cookie が要る(先に `takkenKensaku.do?outPutKbn=1` を GET)。
- ページ送り: 同じ口に `CMD=selectPage`・`pageListNo1=<ページ番号>`(前回の `sv_*` の隠し項目をそのまま送り返す)。
- 件数: 本文に「検索結果：26906件」(東京都知事免許・50件×539ページ)。
- 一覧の列: 免許行政庁/免許証番号「(17)第000001号」/商号/代表者名/事務所名/所在地。詳細へは `js_ShowDetail('13000001')`=**行政庁2桁+番号6桁**(回次を含まない=更新しても変わらない鍵)。
- 詳細: `POST tkGaiyo.do`・`sv_licenseNo=13000001`。商号のふりがな(半角カナ)・免許の有効期間・主たる事務所の所在地・**電話番号**が載る。⚠電話番号は詳細にしか無い。

## Review Focus
1. 先方が混んでいる/止めている(503・429・タイムアウト・メンテナンス画面)→ その回で止まり、続きから再開できる(同じページ・同じ会社を取り直さない、取りこぼさない)。
2. 月をまたぐ一巡の途中で、一覧から消えた会社(廃業・免許の失効)→ 一巡が最後まで終わったときだけ「一覧に無い」にする。途中で止まった一巡で消さない。
3. 名簿にすでにある業者(同じ電話番号・同じ免許番号)を一覧から選んだ → 二重に作らず、名簿の業者を使う。
4. 免許の更新で回次が変わる(17→18)/商号・所在地・電話が変わる → 同じ会社として上書きし、詳細を取り直す。
5. 個人名(代表者名)が表にもログにも残らない。

## File Structure
- Create `prisma/migrations/20261003100000_add_mlit_agents/migration.sql` — 表 `mlit_agents`・`mlit_crawl_state`、`agents.mlit_agent_id`
- Modify `prisma/schema.prisma` — `MlitAgent`・`MlitCrawlState`・`Agent.mlitAgentId`
- Create `src/lib/agent-registry/parse.ts` — 一覧・詳細の HTML→値(純関数)
- Create `src/lib/agent-registry/client.ts` — 先方への取得(cookie・cp932・4秒の間隔・失敗の分類)
- Create `src/lib/agent-registry/crawl.ts` — 進め方(状態遷移・夜間の判定・一巡の締め)
- Create `src/lib/agent-registry/store.ts` — 進め方が使う保存(prisma 版)
- Create `src/app/api/agent-registry/crawl-run/route.ts` — timer の口(合言葉・dryRun)
- Modify `src/proxy.ts` — `PUBLIC_EXACT_PATHS` に上の口
- Modify `src/lib/agent-inquiry/agent-search.ts` — 名簿の候補が足りないとき一覧からも探す
- Create `src/app/api/agent-registry/[id]/adopt/route.ts` — 一覧の業者を名簿へ写す(同じ業者があればそれを返す)
- Modify `src/components/agent-inquiry/agent-picker.tsx`・`src/lib/api-client.ts`・`src/lib/agent-inquiry/desk-form.ts` — 候補に「国交省の一覧」の印・選んだら写す
- Create `deploy/systemd/pm-agent-registry.service.example`・`.timer.example`、Modify `deploy/env/app.env.example`
- Tests: `src/lib/agent-registry/__tests__/{parse,client,crawl,store}.test.ts`・`src/app/api/agent-registry/**/__tests__/route.test.ts`・既存の agent-search / agent-picker / migration 走査のテスト・見本 `src/lib/agent-registry/__tests__/fixtures/{list,detail}.html`

---

### Task 1: 表を足す(migration・追加だけ)

**Files:** migration・`prisma/schema.prisma`・`src/lib/__tests__/agent-registry-migration-scan.test.ts`

**Interfaces — Produces:**
```prisma
model MlitAgent {
  id            String    @id @default(uuid()) @db.Uuid
  licenseKey    String    @unique @map("license_key")      // "13000001"=行政庁2桁+番号6桁
  authority     String                                      // "00" | "11" | "12" | "13" | "14"
  licenseLabel  String    @map("license_label")             // "東京都知事(17)第000001号"
  companyName   String    @map("company_name")
  companyKana   String?   @map("company_kana")
  address       String?
  phone         String?
  phoneDigits   String?   @map("phone_digits")             // 数字だけ(検索用)
  validUntil    String?   @map("valid_until")              // 表示用の文字のまま
  listed        Boolean   @default(true)                    // 最新の一巡で一覧にあった
  seenCycle     String?   @map("seen_cycle")                // "2026-10" など
  needsDetail   Boolean   @default(true) @map("needs_detail") // 詳細を取る(取り直す)必要がある
  detailAt      DateTime? @map("detail_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  agents        Agent[]
  @@index([phoneDigits])
  @@index([companyName])
  @@index([needsDetail])
  @@map("mlit_agents")
}
model MlitCrawlState {
  authority   String    @id                                 // 行政庁ごとに1行
  cycle       String                                         // 今の一巡 "2026-10"
  phase       String                                         // "list" | "detail" | "done"
  nextPage    Int       @default(1) @map("next_page")
  totalPages  Int?      @map("total_pages")
  failStreak  Int       @default(0) @map("fail_streak")
  dayOffUntil DateTime? @map("day_off_until")               // 3回続けて失敗したら翌晩まで止める
  lastError   String?   @map("last_error")                 // 分類コードだけ(本文は残さない)
  lastRunAt   DateTime? @map("last_run_at")
  @@map("mlit_crawl_state")
}
// Agent に追加: mlitAgentId String? @map("mlit_agent_id") @db.Uuid + relation(onDelete: SetNull) + @@index([mlitAgentId])
```
- [ ] Step 1: 走査テストを書く(migration は CREATE TABLE ×2・ADD COLUMN ×1・CREATE INDEX だけ・DROP/ALTER TYPE/既存列の NOT NULL 化なし・`mlit_agents` に代表者の列が無い)→ 失敗を見る
- [ ] Step 2: schema と migration を書く(`prisma format` は使わない=全体を書き換えるため。手で追記)→ `npx prisma generate`
- [ ] Step 3: 使い捨てDB `pm_agent_registry_check` に `migrate deploy` → `prisma migrate diff` で新しい表の差分なしを確かめる → テスト緑 → commit

### Task 2: 読み取り(純関数・実物の並びを写した見本で)

**Files:** `src/lib/agent-registry/parse.ts`・見本2つ・`parse.test.ts`

**Interfaces — Produces:**
```ts
export interface ListRow { licenseKey: string; authority: string; licenseLabel: string; companyName: string; address: string | null }
export interface ListPage { total: number; pages: number; page: number; rows: ListRow[] }
export interface Detail { licenseKey: string; companyKana: string | null; address: string | null; phone: string | null; validUntil: string | null }
export class LayoutChanged extends Error {}          // 想定の列・件数が見つからない
export function parseListPage(html: string): ListPage   // 代表者名の列は読み捨てる
export function parseDetail(html: string, licenseKey: string): Detail
```
- 見本は 2026-10-03 に取った実物のHTMLから**並び(タグ・列の順・全角空白・js_ShowDetail の形)をそのまま写し**、会社名・人名・住所・電話は架空の値に差し替える(実在の個人名をリポジトリに入れない)。
- 同じ会社が事務所ごとに複数行ある場合は licenseKey でまとめ、「本店」の行の所在地を使う。
- [ ] Step 1: テスト: 件数「検索結果：26906件」→ total=26906・pages=539/各行の licenseKey=js_ShowDetail の引数/商号の全角空白は半角空白1つに/**代表者名がどの値にも入らない**/列が1つ欠けた・件数の文言が無い HTML は `LayoutChanged`/0件の画面は rows=[]・total=0/詳細から電話・ふりがな・有効期間/電話が無い詳細は null → 失敗を見る
- [ ] Step 2: 実装 → 緑 → commit

### Task 3: 取得(先方に負担をかけない取り方)

**Files:** `src/lib/agent-registry/client.ts`・`client.test.ts`

**Interfaces — Produces:**
```ts
export type FetchFail = "http_429" | "http_5xx" | "http_other" | "timeout" | "network" | "layout";
export interface RegistryClient {
  searchFirst(authority: string): Promise<ListPage>;
  selectPage(authority: string, page: number): Promise<ListPage>;
  detail(licenseKey: string): Promise<Detail>;
  readonly requestCount: number;
}
export class FetchError extends Error { constructor(public kind: FetchFail) }
export function createRegistryClient(opts?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; minIntervalMs?: number }): RegistryClient
```
- 1つの client の中で**前の呼び出しから 4 秒(minIntervalMs)たつまで待つ**・同時に呼ばれても順番に1本ずつ(内部の待ち行列)。
- cookie は最初の GET で受け取り、以後送る。ページ送りは直前の検索の `sv_*` 隠し項目を送り返す(検索をしていない行政庁のページ送りは、先に searchFirst を1回挟む)。セッション切れ(検索画面に戻された)は1回だけ取り直す。
- 応答は `TextDecoder("shift_jis")` で読む。タイムアウト 30 秒。
- [ ] Step 1: テスト(偽の fetch・偽の時計): 2回目は 4 秒待つ/同時に3回呼んでも 4 秒ずつ順番/429→`http_429`・503→`http_5xx`・タイムアウト→`timeout`・読めない画面→`layout`/名乗りの見出し/cookie を送り返す/送る項目(CMD・licenseNoKbn・dispCount=50・sortValue=1・selectPage の pageListNo1 と sv_* の送り返し)→ 失敗を見る
- [ ] Step 2: 実装 → 緑 → commit

### Task 4: 進め方(状態遷移・夜間・一巡の締め)

**Files:** `src/lib/agent-registry/crawl.ts`・`crawl.test.ts`

**Interfaces — Consumes:** Task 2・3。**Produces:**
```ts
export const AUTHORITIES = ["00", "13", "14", "11", "12"] as const;   // 大臣・東京・神奈川・埼玉・千葉
export function inNightWindow(now: Date): boolean                      // JST 22:00〜翌7:00
export function cycleOf(now: Date): string                             // JST の "YYYY-MM"
export interface StepBudget { deadlineMs: number; maxRequests: number } // 既定: 8分・100回
export interface StepResult { requests: number; listed: number; detailed: number; stopped: null | FetchFail | "budget" | "day_off" | "outside_window" }
export interface CrawlStore {
  loadStates(): Promise<CrawlState[]>;
  saveState(s: CrawlState): Promise<void>;
  upsertListRows(rows: ListRow[], cycle: string): Promise<number>;      // 変わった行は needsDetail=true
  nextNeedingDetail(limit: number): Promise<string[]>;                  // licenseKey を古い順
  saveDetail(d: Detail, at: Date): Promise<void>;                       // needsDetail=false
  closeCycle(cycle: string): Promise<number>;                           // その一巡で見なかった行を listed=false
}
export async function crawlStep(deps: { client: RegistryClient; store: CrawlStore; now: () => Date; budget: StepBudget }): Promise<StepResult>
```
- 1回の呼び出しで: 夜間でなければ何もしない → 行政庁を順に、`phase=list` ならページを進めて行を upsert(`seenCycle`=今の一巡・商号/所在地/免許の表示が変わった行と新しい行は `needsDetail`)→ 最後のページまで終えたら次の行政庁 → 全行政庁の一覧が終わったら詳細が要る行を古い順に取る → 全部終わったら**一巡の締め**: その一巡で一度も見なかった行を `listed=false`(5つの行政庁すべての一覧が最後まで終わったときだけ)→ 全行政庁を `done`。
- 月が変わったら(`cycleOf(now)` が `cycle` と違い、かつ前の一巡が done)次の一巡を `list` の1ページ目から始める。前の一巡が途中なら、まずそれを終わらせる。
- 失敗: その回はすぐ止める・`failStreak+1`・3 以上なら `dayOffUntil`=翌日の 22:00(JST)。成功したら 0 に戻す。
- 一覧の途中でページ数が変わった(件数が増減した)ら、そのページから続ける(1件ずれても次の一巡で拾う。消える判定は締めのときだけ)。
- [ ] Step 1: テスト(偽の client・メモリ上の store・偽の時計)。**順番の交差は総当たり**: 一覧の途中で失敗→次の呼び出しは同じページから/詳細の途中で止まった→同じ会社を取り直さない/一巡の途中で月が変わる→前の一巡を終えてから次へ/途中で止まった一巡では `listed=false` にしない/全部終わった一巡では見なかった行だけ false/夜間の外は 0 回/予算(8分・100回)で止まる/3回続けて失敗→その晩は動かない・翌晩は動く → 失敗を見る
- [ ] Step 2: 実装 → 緑 → commit

### Task 5: timer の口と保存(prisma 版の store)

**Files:** `src/app/api/agent-registry/crawl-run/route.ts`・`src/lib/agent-registry/store.ts`・`src/proxy.ts`・`deploy/systemd/pm-agent-registry.{service,timer}.example`・`deploy/env/app.env.example`・テスト

- 作りは `field-survey/sessions/auto-end-run` と同じ: `AGENT_REGISTRY_CRAWL_SECRET` 未設定=503(休眠)/見出し `x-agent-registry-secret` 不一致=403/`?dryRun=1`=進み具合だけ返して先方にアクセスしない/同時に2本走らない(Postgres の advisory lock・取れなければ 409 で何もしない)。
- store の upsert は licenseKey で1回の SQL にまとめる(50行ずつ)。商号・所在地・免許の表示が変わったときだけ `needsDetail=true`。
- 運用ログは件数と分類コードだけ(会社名・電話・先方の本文を出さない)。監査ログは書かない(人の操作ではない・件数が多い)。
- timer: `OnCalendar=*-*-* 22,23,00,01,02,03,04,05,06:00/10:00`(夜間10分ごと)・curl の `--max-time 600`。合言葉は argv に載せない(既存と同じ `-H @-`・`%%s`)。
- [ ] Step 1: テスト: 503/403/dryRun で client を呼ばない/ロック中は 409/結果の形/proxy の公開パスに入っている/ログに会社名が出ない/store の upsert で変わった行だけ needsDetail・closeCycle は見なかった行だけ(使い捨てDB)→ 失敗を見る
- [ ] Step 2: 実装 → 緑 → commit

### Task 6: 受付の窓で一覧からも探す・選んだら名簿へ写す

**Files:** `agent-search.ts`・`src/app/api/agent-registry/[id]/adopt/route.ts`・`agent-picker.tsx`・`api-client.ts`・`desk-form.ts`・テスト

**Interfaces — Produces:**
```ts
// AgentHit に追加: source: "agents" | "mlit"; licenseLabel?: string(source="mlit" のとき id は mlit_agents.id)
// searchAgents(q, { includeRegistry }): 名簿の候補が LIMIT 未満のとき、残りの枠で mlit_agents(listed=true・電話あり)を探す。
//   電話=phone_digits LIKE、文字=商号・ふりがなの部分一致。名簿に写し済み(agents.mlit_agent_id が同じ)・
//   名簿に同じ代表電話の業者がある一覧の行は出さない(二重の候補にしない)。
// POST /api/agent-registry/{id}/adopt → { agent: AgentHit(source="agents") }
//   名簿に mlit_agent_id が同じ業者(しまっていない)→ それを返す(作らない)
//   名簿に同じ代表電話の業者(しまっていない)→ それに mlit_agent_id を付けて返す
//   どちらも無い → 商号・ふりがな・免許番号(表示)・所在地・電話で名簿に作る(作成者=押した人・監査1件)
//   同時に2回押されても1件(mlit_agents の行ロック → 名簿を読み直してから作る)
```
- 画面: 一覧から来た候補は「**国交省の一覧**」の小さな印と免許番号を添える。押すと写してから、今までどおり選んだ状態になる(写すのに失敗したら赤字で理由)。一覧の候補を出すのは「業者を登録できる人」だけ(書けない人には出さない=写せないため)。
- 名簿の画面(`/agents`)の検索には出さない(名簿は関わった業者だけ=D3)。
- [ ] Step 1: テスト: 名簿で足りれば一覧を探さない/名簿に写し済みの行・同じ電話の行は出ない/`listed=false` は出ない/adopt の3通り+同時2回で1件/書けない人は 403・一覧の候補も出ない/候補の印の表示(SSR)/名簿の画面の検索には出ない → 失敗を見る
- [ ] Step 2: 実装 → 緑 → commit

### Task 7: 仕上げ

- [ ] フル `npx vitest run`・`npx tsc --noEmit`・eslint・`npm run build`(全部終了コード 0 を見てから commit)
- [ ] 実ブラウザ確認(本番ビルド・使い捨てDB): 一覧の行を数件 DB に入れた状態で、受付の窓で電話番号・会社名で探す → 印つきで出る → 選ぶと名簿に1件できる/もう一度探すと名簿の候補として出る(二重にならない)
- [ ] 提出前レビュー(別AI・ブランチ全体)→ PR → @codex
- [ ] **先方への実アクセスは、本番反映のあと発注者の承認を得てから**: `?dryRun=1` → 合言葉を入れて夜間に1回だけ手で叩き、1ページ+数社で止まる・間隔が4秒以上あることをログで確かめてから timer を有効にする
- [ ] 使い方ガイド/マニュアルへの追記は本番で一巡が終わってから(件数が確定してから)

## 運用の見込み
- 一覧のページ: 約1,100ページ(5行政庁の合計の見込み)/詳細: 約5万社。4秒あけて1回8分・100回まで・夜間9時間(54回)→ **1晩 約5,400件・初回は約10日**。
- 2か月目以降: 一覧の全ページ(約1,100回=1晩弱)+新しい会社・変わった会社の詳細だけ。
- 先方の負担: 4秒に1回=1時間900回まで。人がふつうに検索するのと同程度の間隔。

## やらないこと
- 支店ごとの電話番号(先方に無い)・代表者などの個人名・国交省以外のサイト・名簿の画面での一覧の表示・検索以外の操作。
