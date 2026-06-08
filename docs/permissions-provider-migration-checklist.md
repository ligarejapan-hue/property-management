# 権限プロバイダ移行チェックリスト / runbook（F12 他ページ展開）

`/api/me/permissions` の**ページ直接 fetch** を段階的に減らし、権限状態の取得を
canonical な **provider 経由**へ寄せるための、**実装前チェックリスト / runbook**。
これは設計・手順書であり実装ではない（**docs-only**）。

対象コード基準: main `be4bda2`（PR #150 = 直接 fetch 許可リスト test 反映済み）以降。

> 前提（重要・用語注意）: 本リポジトリに `PermissionsProvider` / `usePermissions` という名前は**存在しない**。
> canonical な権限配布の実体は **`ScreenProtectionProvider` / `useScreenProtection`** である（下記 §0 の用語マッピング）。
> 以降「provider」「provider フック」はこの実体を指す。

関連実装・テスト（根拠。本 docs では一切変更しない）:

- canonical provider: `src/components/screen-protection/screen-protection-provider.tsx`
- provider フック: `useScreenProtection()`（同ファイル named export）
- route: `src/app/api/me/permissions/route.ts`（`{ permissions, capabilities }` を返す GET）
- 判定ヘルパ: `src/lib/permissions.ts` の `hasPermission(permissions, resource, action)`（default-deny）
- 移行済み参照実装: `src/app/(dashboard)/properties/page.tsx`（物件一覧・F12-2 で移行完了）
- source assertion test 群: `src/lib/__tests__/permissions-provider-distribution.test.ts` /
  `permissions-direct-fetch-allowlist.test.ts` / `me-permissions-route.test.ts` ほか（§付録B）

---

## 0. 用語マッピング（実装前に必読）

タスク指示の通称と実コードの正規名が異なる。grep で迷子にならないよう最初に固定する。

| タスク指示の通称 | 実コードの正体 | 所在 |
|---|---|---|
| PermissionsProvider | **ScreenProtectionProvider**（default export） | `src/components/screen-protection/screen-protection-provider.tsx` |
| usePermissions | **useScreenProtection()**（named export・**これが唯一の取得点**） | 同上 |
| （context） | ScreenProtectionContext（外部 export なし・フック経由のみ） | 同上 |
| loading | **permissionsLoading**（provider state・初期 true） | 同上 |
| pending | **permissionsRefreshPending**（**consumer 側** state。provider には無い） | `properties/page.tsx`（参照実装） |
| effectivePermissions | **consumer 側のローカル派生値**（provider state ではない） | `properties/page.tsx`（参照実装） |

provider が context 配布する値は **7 キー**（5 ではない）:

```
bypass(boolean) / watermarkText(string|null) /
permissions(PermissionEntry[]|null) / capabilities(MeCapabilities|null) /
permissionsLoading(boolean) / permissionsError(boolean) /
refetchPermissions(() => Promise<void>)
```

- `permissions` / `capabilities` の **`null` は「未取得 or 取得失敗 = 権限なし／機能なし扱い（fail-safe）」**。
- `PermissionEntry = { resource: string; action: string; granted: boolean }`。判定は
  `hasPermission(permissions, resource, action)`（`permissions.find(...)?.granted ?? false`・default-deny）。
- `MeCapabilities = { corporateLookup: boolean; registryAutoFetch: boolean }`。provider は
  `=== true` の**厳格判定**で詰める（true 以外は false に倒す = 広く許可しない）。
- `refetchPermissions` は provider 内 `loadPermissions`（in-flight dedupe あり・`Promise<void>`）を共有。
  consumer は完了を `await` / `.finally()` できる。
- **`bypass` / `watermarkText` は画面保護（透かし）専用**。consumer は表示ゲートに使わない（§5 capability 不変条件参照）。

---

## 1. 目的

- `/api/me/permissions` の**ページ直接 fetch を減らす**（最終的に canonical = provider 1 箇所へ集約）。
- 権限状態の取得を **`ScreenProtectionProvider` に寄せる**（`useScreenProtection()` で consume）。
- **stale 権限表示を防ぐ**（client navigation で layout が保持され mount 時 1 回 fetch では
  権限の付与／剥奪に追従できない問題を、進入時 refetch + stale 非表示で解消する）。

非目的（やらない）:

- route / DB 権限ロジック / server 側権限ゲートの変更。
- provider 実装（`screen-protection-provider.tsx`）の挙動変更。
- capability の意味変更（厳格判定・disabled 専用・サーバ再判定の規約を緩めない）。

---

## 2. 現在の既知残存候補（main `be4bda2` 時点・実コードで再確認済み）

`/api/me/permissions` を**実際に直接 fetch している箇所は 4**（コメント言及は除く）:

| # | ファイル | 役割 | 移行 |
|---|---|---|---|
| canonical | `src/components/screen-protection/screen-protection-provider.tsx` | **唯一あるべき取得点**（mount 時 + refetch を共有・in-flight dedupe） | **対象外（不変）** |
| 残① | `src/app/(dashboard)/field-survey/...`（`src/components/field-survey/field-survey-map.tsx`） | client で write/manage 判定 | 移行対象 |
| 残② | `src/app/(dashboard)/admin/owners/[id]/page.tsx` | owner field-level + corporateLookup capability | 移行対象 |
| 残③ | `src/app/(dashboard)/properties/[id]/page.tsx` | 最多面（下記 §3） | 移行対象 |

- `src/app/(dashboard)/properties/page.tsx`（**物件一覧**）は F12-2（PR #145）で**移行済み** =
  直接 fetch ゼロ・`useScreenProtection()` 経由のみ。**他ページ移行の参照実装**（§4・§付録A）。
- `src/components/properties/registry-auto-fetch-button.tsx` は capability を **prop で受けるだけ**で fetch しない。
- この 4 箇所は PR #150 の `permissions-direct-fetch-allowlist.test.ts` が許可リストとして固定済み
  （canonical 1 + 移行待ち 3・総数 4）。移行が進むと許可リストから 1 つずつ減る（§7・§付録B）。

> ⚠ ユーザー提示の候補（screen-protection-provider=canonical / properties[id] / admin owners / field-survey-map）と
> 実コードは一致した。移行対象は **3 ページ**（canonical は対象外）。

---

## 3. 移行優先順位（推奨）と複雑度プロファイル

**面が単純な順から着手し、最多面を最後にする。** ただし最小面の field-survey は別種の罠（tristate）を持つ。

| 順 | ページ | 複雑度プロファイル | 固有の罠 |
|---|---|---|---|
| 1 | **field-survey-map.tsx** | 判定 2 個（`field_survey:write` → canWritePin / `field_survey:manage` → canManagePin）。capability 不使用 | **tristate**（`boolean\|null`）＋**server read gate 併存**（§5・§8） |
| 2 | **admin/owners/[id]/page.tsx** | owner field-level 4 種（owner_name/owner_address/owner_zip/owner_corporate_number）＋ capability 1 種（corporateLookup） | UI source test が setter をロック（§付録B） |
| 3 | **properties/[id]/page.tsx** | **最多面**: resource:action 判定（registry:auto_fetch / property:write / owner:write×2 / owner:read）＋ field-level 8 種＋ capability 2 種＋**API レスポンスのキー有無（masked/hidden）分岐** | 多層条件が 1 ファイル集約 |

理由: field-survey は判定が最小だが tristate と server gate という質の異なる罠を最初の関門として明示する。
properties/[id] は条件層が最多のため、3 点セットに習熟してから最後に着手する。

---

## 4. 展開時に必ず守る 3 点セット（参照実装 = `properties/page.tsx`）

直接 fetch を `useScreenProtection()` に置換するだけでは **stale 権限表示**が再発する。
以下 3 点を**セットで**入れる。1 つでも欠くと下表の回帰が起きる。

### (1) 進入時 refetch（`refetchPermissions` を「進入あたり最大 1 回」）

- `permissionsRefreshRequestedRef`（`useRef(false)`）で**ページ進入（mount）あたり 1 回**に制限。
- `permissionsLoadingAtMountRef` で **mount 時点の loading 状態を初回 render に 1 度だけ確定**。
- `permissionsLoading` 中は呼ばない（provider の取得と**同時 2 本**にしない）。
- **発火条件は「失敗時のみ」ではない**。「mount 時に進行中だった取得が**成功**」のみ早期 return し、
  **残り全ケース（= mount 時取得完了済みの client navigation 再訪 = stale、または mount 時進行中の取得が失敗）で refetch する**。
  client navigation 再訪 stale 対応が**進入時 refetch の主目的**。
- 完了は `refetchPermissions().finally(() => setPermissionsRefreshPending(false))` で解除。

> ❌ `refetchPermissions` を単純に「mount で 1 回呼ぶだけ」や「失敗時のみ」で実装すると、
> client navigation の再訪で **stale 権限**が残る（§8 NG 停止条件）。

### (2) pending の lazy init（`useState(() => !permissionsLoading)`）

- `permissionsRefreshPending` の初期値を **`() => !permissionsLoading`** で遅延初期化する。
- mount 時に**取得完了済み**（= この後 entry refresh が走る予定）なら**最初の描画から pending=true**で開始し、
  refetch 完了まで stale な granted を使わせない。

> ❌ `useState(false)` で始めると、refetch 完了前の**最初の数フレームで stale な granted から
> ボタンが表示・クリック可能**になる回帰（distribution test がこの初期値をロック）。

### (3) effectivePermissions で stale 権限ボタン非表示

- 導出は純関数（`useMemo`、**state に保持しない**）:
  `effectivePermissions = (permissionsRefreshPending || permissionsLoading) ? [] : (mePermissions ?? [])`。
- granted 判定は `effectivePermissions` に対して行う（refresh 中は空配列 = 全 false = ボタン非表示）。
- deps に `mePermissions` を含め、refetch 成功で context 更新 → 再導出 → 最新権限に追従させる。

> ❌ `effectivePermissions` を使わず `mePermissions` を直接判定に使うと、refresh 中に**古い権限が一瞬表示**される
> stale window が再発する（タスク指示の禁止事項。`refetchPermissions` だけの流用は不可）。

### 3 点セットを 1 つでも欠くと何が起きるか

| 欠落 | 症状 |
|---|---|
| (1) 進入時 refetch を欠く（or「失敗時のみ」） | client navigation 再訪で **revoke / grant に追従できず stale** のまま |
| (2) pending lazy init を欠く（`useState(false)`） | mount 直後の数フレームで**一瞬ボタン表示＆クリック可能** |
| (3) effectivePermissions を欠く（`mePermissions` 直接） | refresh 中に**古い権限ボタンが一瞬見える**（stale window 再発） |

---

## 5. ページ別チェックポイント

各ページ共通の**前提ゲート**（最初に確認）:

- [ ] 対象ページが `(dashboard)/layout.tsx` の `DashboardLayout` 配下（= `ScreenProtectionProvider` に覆われている）か。
      覆われていないページ（`(auth)` 配下・Storybook 単体描画・USE_MOCK 経路等）で `useScreenProtection()` を呼ぶと
      **createContext のデフォルト（permissions=null / loading=true / refetch=no-op）が返り loading 固定**になる → 移行対象外（§8）。
- [ ] provider は `'use client'`。**server component から呼べない**。server 側の権限ゲートは移行対象外（下記 field-survey 参照）。

### 5-1. field-survey-map.tsx（`field_survey:write` / `field_survey:manage`）

- [ ] **tristate 注意ページ**。`canWritePin` / `canManagePin` は `boolean | null` の**3 状態**:
  - `null` = 判定不能 → UI は**押下許可**し **API 403 で最終ガード**（`PinAddModeToggle` の `canWrite`）。
  - `false` = 既知の権限なし → **ボタン disable**（`canWrite === false` で disabled の表示文言あり）。
  - `true` = 許可。
- [ ] **`permissions=null`（2 状態に collapse）への素朴移行は NG**。provider は loading も error も `permissions=null` に倒すため、
      consumer 側で `permissionsLoading` / `permissionsError` を使い「**取得中／失敗 = 従来 null 相当（押下許可・403 委譲）**」と
      「**成功して entry 無し = false（disable）**」を**書き分ける**こと（§8）。
- [ ] 権限判定は `resource === "field_survey" && action === "write"/"manage" && p.granted === true`（明示 deny を許可扱いしない）。
- [ ] **AbortController 置換注意**。permissions fetch は AbortController + `cleanup return () => ac.abort()` を持つが、
      **同ファイルの map データ（pins / properties）fetch も別系統で AbortController を持つ**。これは**触らない**。
      permissions effect 撤去時は対象 effect の cleanup（return 文）・`ac.signal` / `ac.abort` の残骸が消えたか **diff 目視**する
      （bare `/AbortController/` の source assertion は pins 側が残るため**偽 green**になり撤去漏れを検知しない・§7）。
- [ ] **位置情報 / 地図表示と責務を分ける**。permissions effect は geolocation（`getCurrentPosition`）・bbox データ取得
      （`/api/field-survey/map/properties`・`/api/field-survey/pins`）とは**別 effect**。これらは移行対象外。
- [ ] **server read gate を触らない**。`field-survey/map/page.tsx`（server component）が
      `getUserPermissions` + `hasPermission(permissions, "field_survey", "read")` で gate し、許可時のみ client を render する。
      これは server 側で不変。移行で置換するのは **client の write/manage 取得のみ**（capabilities は不使用）。

### 5-2. admin/owners/[id]/page.tsx（owner_* full/edit ＋ corporateLookup capability）

- [ ] owner 表示/編集判定: `owner_name` / `owner_address` / `owner_zip` は `action === "full"`、
      `owner_corporate_number` は `full` **または** `edit`（granted）で `fieldEditable` を組む。
- [ ] 表示レベル語彙は full/edit/read/masked/partial/hidden。**full のみ生値**・他はマスク・**hidden は API が 403**。
- [ ] capability は **corporateLookup のみ**取得（`json.capabilities?.corporateLookup ?? false` → `CorporateLookupPanel` の `configured`）。
      registryAutoFetch は**取得しない**。
- [ ] **properties/[id] と同方針**にする部分（コメントに「properties/[id]/page.tsx と同方針」と明記済）:
      直接 fetch + `.then().catch(() => {})`・AbortController なし・依存配列 `[]`（mount 1 回）。これを provider consume へ置換する。
- [ ] stale になり得る箇所: `fieldEditable.corporateNumber`（法人番号入力欄＋Panel）と `!configured`（「法人番号API未設定」）。
      進入時 refetch で追従させる（3 点セット）。

### 5-3. properties/[id]/page.tsx（最多面）

- [ ] resource:action 判定（granted 必須）: `registry:auto_fetch` / `property:write` / `owner:write`（**2 箇所**: canWriteOwner と canCreateOwnerMemo 用）/ `owner:read`。
- [ ] field-level 8 種: owner_name/owner_name_kana/owner_phone/owner_zip/owner_address/owner_email は **full のみ**、
      owner_corporate_number / owner_note は **full または edit**。`ownerEditableFields` / `canCreateOwnerMemo` に格納。
- [ ] **capabilities 両方**: corporateLookup（国税庁 Web-API）と registryAutoFetch（謄本自動取得 provider）。
      いずれも **UI ボタン disabled 判定のみ・実行可否はサーバ側で再判定**（規約・§capability 不変条件）。
- [ ] **field-level 表示条件**: PII 表示は `owner:read`（canRead）に加え、**API レスポンスのキー有無**でも分岐
      （`"email" in po.owner` の `emailReturned`、`corporateNumber !== undefined`。hidden 時はキー自体が無い）。
      この masked/hidden 分岐は権限 state とは別レイヤなので**移行で触らない**。
- [ ] owner 編集ボタンは `canEditOwner(canRead, canWrite, hasAnyEditable, version)`（owner:read + owner:write + 編集可能項目 + version 取得済み）。
      誤紐づき修正ボタンは owner:write のみで表示し execute 側で property:write を再検証（サーバ最終判定）。
- [ ] **CSV/DM/PII 表示条件との混同禁止**: このページは `csv_export` / `csv_export_personal` / `registry_pdf:preview/download` を
      **一切参照しない**。CLAUDE.md §19 のとおり **`owner:read` を export 権限の代替にしない**・`csv_export` 系が必要な出力は両権限を確認、の境界を侵さない。
- [ ] screen protection marker（ルート div の `data-pii-protected` / `data-pii-surface="property"`）は permissions と非連動・常時付与。**触らない**。

### capability 不変条件（admin/owners・properties/[id] 共通）

- [ ] capabilities は provider 側で `=== true` 厳格判定済み。consumer 側で**再緩和しない**（`?? true` / `!= false` 等で広げない・§8）。
- [ ] capability は **disabled 判定専用**。実行ゲートに昇格させない（実行可否は常にサーバ側で再判定）。
- [ ] consumer は capability を別名 state へ写すだけで**判定式を変えない**。
      （`corporate-lookup-panel.tsx` の zip activation のように `!!fieldEditable?.zip && !!result.record.postCode` の AND など
      capability / 編集権限単独でない activation 条件は移行対象外。）

---

## 6. 実装 PR ごとの推奨分割

- [ ] **1 ページ 1 PR**（field-survey → admin owners → properties[id] の順）。
- [ ] 最初は **field-survey map**（最小面・tristate を最初の関門として習熟）。
- [ ] **source assertion test の更新は当該ページの実装 PR 内で同時に行う**（test-only 後追い PR にしない）。
      理由: distribution test は移行で**必ず赤**になるため（§付録B）、実装 PR 単体を green に保つには同 PR 内更新が必須。
- [ ] **大きな横断リファクタは禁止**。provider 実装は触らない（consumer 側のみ編集が原則）。

---

## 7. 実装時の検証観点（実装 PR 用・順序付き）

docs-only の本 runbook 自体は build/test 省略可（CLAUDE.md §10）。以下は**実装 PR で必須**の順序:

1. [ ] **対象ページ targeted test**（当該ページ UI source test）。
2. [ ] **`permissions-provider-distribution.test.ts` 全体**（配列除外と consume 追加の整合・横断ロック）。
3. [ ] **当該ページ UI source test の更新**（§付録B のページ別ロックを置換）。
4. [ ] **`permissions-direct-fetch-allowlist.test.ts`**（許可リストが 1 要素減ったこと）。
5. [ ] **`npx tsc --noEmit`**（`useScreenProtection()` の分割代入・`permissions: mePermissions` 別名化の型）。
6. [ ] **`npx vitest run`**（関連／全体）。
7. [ ] **`npm run build`**。
8. [ ] **`git diff --check`**。
9. [ ] **直接 fetch 残数の証跡**: 直接 fetch の箇所数を before→after で提示し、
      **allowlist が 1 減った**（canonical 除き 3→2→1→0）ことを報告に含める。
      検出は test と同じ正規表現 `fetch\(\s*["']\/api\/me\/permissions["']`（シングル／ダブル両対応）で行う
      （`fetch("/api/me/permissions")` のダブルクォート固定 grep は test の検出ロジックとずれ得る）。

> AbortController を撤去したページは、bare `/AbortController/` の source assertion が**偽 green**になり得るため、
> test 通過を撤去の証拠にしない。**対象 effect の cleanup（return 文）と未使用変数の消滅を diff 目視**で確認する。

---

## 8. NG 時の停止条件（出たら実装を止めて報告）

- [ ] **stale 権限ボタンが一瞬でも出る**（3 点セットの欠落・§4）。
- [ ] **provider 取得失敗時に bypass / 権限が fail-safe にならない**（透かし復活・ボタン消失が起きない）。
- [ ] **capabilities の意味が変わる**（`=== true` 厳格を緩める・disabled 専用から実行ゲートへ昇格・サーバ再判定を外す）。
- [ ] **field-survey で tristate を 2 状態に collapse**し disable 文言が誤表示される（取得失敗で従来 null だった所が false に倒れる等）。
- [ ] **server 側権限ゲートを触る必要が出る**（field-survey の server read gate 等）。
- [ ] **API route や DB 権限ロジックの変更が必要**になる。
- [ ] **provider 実装（screen-protection-provider.tsx）を編集する必要**が出る（consumer のみ編集が原則。
      触ると 7 キー配布・`setBypass(false)`×2・`isScreenProtectionBypassed`×1 等の不変条件まで連鎖で落ちる）。
- [ ] **package / lock / schema / migration / env の差分**が出る。
- [ ] 対象ページが **provider 未 mount 経路**（DashboardLayout / SessionProvider 配下でない）と判明。

---

## 9. 報告テンプレート（実装担当が報告すべき項目）

```markdown
## 権限プロバイダ移行 実装報告

- セッション名 / PR番号:
- 対象ページ: （例: field-survey-map.tsx）
- 削除した直接 fetch: （file:line・fetch("/api/me/permissions") の箇所）
- provider から取得する値: （useScreenProtection() の分割代入。permissions/permissionsLoading/refetchPermissions 等）
- pending / effectivePermissions の扱い:
  - permissionsRefreshPending の初期値（() => !permissionsLoading）:
  - effectivePermissions 導出（(pending||loading) ? [] : (perms ?? []) を useMemo）:
  - 進入時 refetch（permissionsRefreshRequestedRef + loadingAtMount + 残ケース refetch）:
- tristate / capability 不変条件のページ別確認結果:
- source assertion 更新: （distribution 配列除外＋consume 追加 / 該当 UI source test / allowlist 減）
- 直接 fetch 残数: before → after（canonical 除く。例 3 → 2）
- provider tsx を触っていないこと（consumer のみ編集）:
- 実行テスト: targeted / distribution / tsc / build / diff --check の結果
- 未実施範囲 / 未移行で残るページ:
```

---

## 付録A: 移行済み参照実装（`properties/page.tsx` 物件一覧）

他ページ移行の**お手本**。F12-2（PR #145）で直接 fetch を撤去済み:

- `const { permissions: mePermissions, permissionsLoading, refetchPermissions } = useScreenProtection();`
- `permissionsRefreshRequestedRef` / `permissionsLoadingAtMountRef` による進入時 1 回 refetch。
- `permissionsRefreshPending = useState(() => !permissionsLoading)`。
- `effectivePermissions = (permissionsRefreshPending || permissionsLoading) ? [] : (mePermissions ?? [])`（useMemo）。
- 直接 fetch ゼロ（`fetch("/api/me/permissions")` literal なし）。

> 物件一覧は `csv_export` / `csv_export_personal` / `owner` で CSV/DM ボタンを出し分ける。移行先ページごとに
> 「対象ボタン」は異なる（§付録C）が、3 点セットの**構造は共通**。

## 付録B: 移行で更新が必要な source assertion test（ページごと）

移行 PR で各ページから直接 fetch を撤去すると、以下が**必ず赤**になる。**同一 PR 内**で更新する。

| テスト | 何をロックしているか | 移行時の対応 |
|---|---|---|
| `permissions-provider-distribution.test.ts`（3 ページ非接触ブロック） | 3 ページが `/api/me/permissions` を含むことを `toMatch` で**肯定的**に期待 | 移行済みページをループ配列から**除外**＋当該ページの consume 系 assert を追加 |
| `permissions-direct-fetch-allowlist.test.ts`（PR #150） | 直接 fetch の call site 集合 = 許可リスト（canonical 1 + 移行待ち 3・総数 4・各 1） | 移行済みページを `MIGRATION_PENDING` から外す（許可リスト/総数を減らす） |
| `admin-owner-detail-ui.test.ts`（admin owners 移行時） | `/api/me/permissions` 直接 fetch ＋ `setCorporateLookupConfigured` / `setFieldEditable` の存在 | provider consume へ置換した形に更新 |
| `field-survey-pin-ui-source.test.ts`（field-survey 移行時） | `/api/me/permissions` で `field_survey:write` 判定する形 | 同上（tristate の扱いも反映） |
| `corporate-lookup-ui.test.ts` ほか UI source test | capability 取得の形 | 該当があれば更新 |

> いずれも **test-only のソース文字列アサーション**（`fs.readFileSync` + 正規表現）。
> distribution test は provider の 7 キー配布・`setBypass(false)`×2・`isScreenProtectionBypassed`×1 も別途ロックしているため、
> **provider tsx は触らない**（触ると連鎖で落ちる）。`me-permissions-route.test.ts` は route 契約をロック（route は移行対象外なので不変）。

## 付録C: 検証時の stale 追従・fail-safe 目視シナリオ（実装 PR 用）

実テストは書かないが、実装担当が手で再現する目視（各ページの対象ボタンで）:

| ページ | 対象 UI |
|---|---|
| properties 一覧（参照） | CSV / DM ボタン |
| properties/[id] | owner 編集ボタン / 誤紐づき修正ボタン |
| admin/owners/[id] | 法人番号編集欄 / CorporateLookupPanel |
| field-survey-map | PinAddModeToggle（追加トグル）/ PinDetailPanel の削除ボタン |

- (a) **grant 追従**: 権限 grant 状態でページ再訪 → 進入時 refetch でボタン**出現**。
- (b) **revoke 追従**: 滞在中に管理者が revoke → 次回進入の refetch でボタン**消失**。
- (c) **fail-safe**: refetch を失敗（5xx / 非 2xx）させる → `permissions=null` → ボタン**消失**、
      かつ `bypass=false` へ倒れ**透かし（WatermarkOverlay）が復活**することを確認。
- consumer 側で `bypass` を表示ゲートに使っていないこと（guard / watermark 専用）を diff で確認。
