# 販売図面 F4-1：会社情報の設定画面化 設計書

**日付:** 2026-07-13
**トピック:** sales-sheet-company-settings（販売図面ひな型プロジェクト F4 の第1弾）
**基盤:** `docs/.../sales-sheet-jisha-format`（メモリ）／会社帯=機能B（`footer-band.ts`/`company-info.ts`）

## ゴール

会社帯（販売図面 下部の会社情報）に直書きしている自社情報を、**管理画面から編集できる**ようにする。設定はDBの単一行に保存し、未設定時は現行の直書き値（`COMPANY_INFO`）にフォールバックする。あわせて、御社の指示により会社帯から **英字社名・保証協会・所属協会** の3項目を削除する。

## スコープ（今回）

- **含む:** 会社情報 **7項目**（会社名／宅建免許番号／電話番号／FAX番号／メールアドレス／ホームページURL／所在地）の設定画面化＋DB保存＋図面への反映。会社帯から3項目（英字社名・保証協会・所属協会）を削除。
- **含まない（別サブプロジェクト）:** 地図/QR自動生成、用途地域の面積按分表示、ロゴ画像アップロード。

## 確定した方針（ユーザー承認済み）

1. **編集7項目**（英字社名・保証協会・所属協会は編集対象から除外）。
2. **図面（会社帯）からも上記3項目を削除**（表示しない）。
3. **DB変更（会社情報テーブル追加）承認済み**。新テーブルのみ・既存データ不変・additive。本番migration適用は別承認。
4. **スナップショット方式**：会社情報は図面の**作成時点でサーバ側が焼き込む**。設定変更は以後に作成する図面へ反映され、既存図面は作成時の値を保持する（作り直しで更新）。

## アーキテクチャ概要

既存の管理設定画面（`/admin/sale-dm-settings`・`/admin/registry-settings`）と同一骨格。ただし会社情報は**秘匿情報ではない**ため、暗号化まわり（暗号鍵・`*_enc`列・`encryptionConfigured`・503ガード・警告バナー）は**すべて不要**＝より単純。`SaleDmConfig` のプレーン列の系譜（`provider`/`senderName` 等）を踏襲する。

会社情報の図面反映は「サーバ側の図面生成時に流し込む」だけで済む：会社帯の**座標はデータ非依存**（`buildFooterBand` の位置は `footer` 矩形の比率＋定数で決まり、会社情報の値には依存しない）。したがってエディタ（クライアント）は無改修——`autoBalanceLayout` は座標プローブに既定の `COMPANY_INFO` を使い続けても同じ座標を得る。焼き込み済みの文字内容は保存ドキュメント側に残る。

## Global Constraints（全タスク共通・spec由来）

- **会社情報は非秘匿:** 暗号化しない。`secret-crypto`・`*_enc`列・enc-key env・`encryptionConfigured`・503分岐・バナーは**作らない**。プレーン `String?` 列のみ。
- **権限:** APIルートは既存権限 `hasPermission(perms, "user_management", "write")` で管理者ゲート（`requireAdmin` ローカルヘルパ・失敗は `ApiError(403, "…（管理者のみ）", "FORBIDDEN")`）。文字列 `user_management:write` を**そのまま再利用**。
- **監査:** 保存時 `writeAuditLog({ action: "company_profile_update", targetTable: "company_profile", detail: { target: "singleton", fields: <変更項目名の配列>, updatedAt } })`。**値は入れない・項目名のみ**。`targetId` は**渡さない**（`AuditLog.targetId` は `@db.Uuid`＝文字列 "singleton" を入れるとPostgresが弾き `writeAuditLog` が握り潰して監査が消える）。**新action文字列を `src/lib/audit-log-detail-safety.ts` の `ACTION_EXTRA_KEYS` に登録**（`company_profile_update: {"target","updatedAt"}`。`fields` は `ALWAYS_SAFE_KEYS` 済ゆえ生存）。未登録だと監査ビューアで全項目 `[REDACTED]`。
- **シングルトン:** `id String @id @default("singleton")`。migration の `id` 列に `DEFAULT 'singleton'` を付ける（現行 `registry_fetch_config` 準拠）。行は seed せず `upsert({ where:{id:"singleton"}, create:{ id:"singleton", … } })` で遅延生成。読取は行不在を許容し既定値へフォールバック。
- **api-client の mock:** 新ラッパーは `USE_MOCK` 短絡（EMPTY定数を返す）を実装。でないとmockビルドが壊れる。
- **フォールバック:** DB値があれば優先、空なら `COMPANY_INFO` 直書き値。`COMPANY_INFO` は**残す**（既定値・回帰の基準）。
- **二重レンダラ:** `buildFooterBand` は既存 element 種別（text/table/shape）のみを出力＝レンダラ（`render-html.ts`/`SalesSheetRenderer.tsx`）は無改修。ただし parity テスト・footer/company-info/spec-sheet テストは3項目削除に合わせて更新。
- **TDD＋全ゲート:** RED→GREEN。`npx tsc --noEmit`=0 ／ フル `npx vitest run` 緑 ／ `npx eslint <変更>`=0 ／ `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 緑。
- **HTTP本番:** `crypto.randomUUID` 不使用（本機能は乱数ID不要の見込みだが規約として明記）。

---

## 設計詳細

### 1. データモデル（`prisma/schema.prisma`＋migration）

新モデル `CompanyProfile` → テーブル `company_profile`（シングルトン1行）。

```prisma
model CompanyProfile {
  id          String   @id @default("singleton")
  nameJa      String?
  license     String?
  tel         String?
  fax         String?
  email       String?
  hp          String?
  address     String?
  updatedAt   DateTime @updatedAt
  updatedById String?  @db.Uuid
  @@map("company_profile")
}
```

migration `NNNN_add_company_profile`（additive・新テーブルのみ・backfill無・`id ... DEFAULT 'singleton'`）。**英字社名/保証協会/所属協会の列は作らない**（削除項目ゆえ）。

### 2. 設定の解決（config-store lib）

`src/lib/sales-sheet/company-profile-store.ts`（新規）:

- 型 `CompanyProfile`（`nameJa/license/tel/fax/email/hp/address` の**必須** string＝解決後は必ず値がある）。
- `resolveCompanyProfile(dbRow | null): CompanyProfile`（純関数）：各項目 `trimOrNull(dbRow?.field) ?? COMPANY_INFO.field`。空文字/空白のみ→フォールバック。テスト容易な純関数として切り出す。
- `loadCompanyProfile(): Promise<CompanyProfile>`：`prisma.companyProfile.findUnique({ where:{ id:"singleton" }})` → `resolveCompanyProfile(row)`。try/catch でDBエラー時は `resolveCompanyProfile(null)`（フォールバック＝fail-safe・図面生成を止めない）。

`COMPANY_INFO`（`company-info.ts`）は既定値ソースとして残すが、**英字社名(`nameEn`)・保証協会(`guaranteeAssoc`)・所属協会(`memberAssoc`)は会社帯から削除**するため、これら3キーは会社帯レイアウトから参照されなくなる（定数自体の3キーは削除してよい＝下記3で footer-band と同時更新）。

### 3. 会社帯への流し込み＋3項目削除（`footer-band.ts`／`build-document.ts`）

**3-a. `buildFooterBand` に会社情報を注入（後方互換の既定引数）:**

```ts
export function buildFooterBand(
  footer: Rect,
  data: FooterBandData,
  company: CompanyProfile = COMPANY_INFO, // 未指定時は既定値＝エディタ座標プローブは不変
): SalesSheetElement[]
```

- 会社ブロックの text 要素は `company.nameJa`/`company.tel`/… を参照（従来の `COMPANY_INFO.*` 直参照を差し替え）。
- `CompanyProfile` 型（解決後7項目・全 string 必須）は company-profile-store から import。`COMPANY_INFO`（3キー削除後は正確に7項目）がそのまま既定値＝`CompanyProfile` を満たすので、追加の既定定数は設けない。

**3-b. 3項目削除＝会社帯レイアウトの簡素化:**

- **削除する要素:** `footer-name-en`（英字社名）・`footer-guarantee`（保証協会）・`footer-member`（所属協会）。
- 名前行：`footer-name-ja` ＋ TEL/FAX のみ（`NAME_EN_OFFSET_MM`/`NAME_EN_W_MM` は不要になり削除）。
- 情報グリッド：残りは `license`（旧左列）＋ `email`/`hp`/`address`（旧右列）の**4行**。左列に license のみだと空きが目立つため**2×2へ再配置**（左列＝免許番号／所在地、右列＝Email／HP）を既定案とする。**視覚は実装時にプレビューを送付し御社確認**（機能B同様）。
- 取引条件テーブル・担当テーブル・区切り線・帯外周は不変。

**3-c. `SpecSheetParts` に `company` を追加して流し込む（`build-document.ts`）:**

- `SpecSheetParts` に `company?: CompanyProfile` を追加。`buildSpecSheetDocument` の footer 展開を `...buildFooterBand(L.footer, parts.footer ?? {}, parts.company)` に変更（`company` 未指定なら既定値＝現行踏襲）。
- `buildSaleMansionDocument`/`buildSaleLandDocument`/`buildSaleHouseDocument`/`buildSaleBuildingDocument` の各 `input` に `company?: CompanyProfile` を通し、`buildSpecSheetDocument({ …, company: input.company })` へ forward（各 `Sale*Input` 型に `company?` 追加）。

**3-d. エディタ（`editor-document.ts`）:** 変更なし。`autoBalanceLayout` の `buildFooterBand(L.footer, {probe})` は `company` を渡さず既定値で座標のみ取得（座標はデータ非依存＝不変）。削除した3要素の id は templateRects から自然に消え、`idx===-1` skip で無害。

### 4. サーバ図面生成での読込（`src/app/api/properties/[id]/sales-sheets/new/route.ts`）

- ルートハンドラ内で `const company = await loadCompanyProfile();` を1回呼び、`buildSaleLandDocument({ …, company })` 等の各ビルダー呼び出しに渡す（4種すべて）。
- これで**新規作成される図面**の会社帯は最新のDB会社情報（無ければ既定値）で焼き込まれる。プレビュー route（`sales-sheet/preview`）が会社帯を含むなら同様に `loadCompanyProfile()` を渡す（該当時のみ・要確認）。

### 5. 保存API（`src/app/api/admin/company-settings/route.ts`・新規）

- `GET`：`requireAdmin()` → `loadCompanyProfile()` → `{ data: { nameJa, license, tel, fax, email, hp, address, updatedAt } }`。`Cache-Control: no-store`。**非秘匿ゆえ実値を返す**（フォームに現在値を初期表示）。
- `PUT`：`requireAdmin()` → `parseJsonBody` → インライン zod `putSchema`（全項目 optional string・空文字→`null` 正規化・URLは `absUrlOrEmpty` 相当のゆるい検証を hp に適用可）→ `prisma.companyProfile.upsert({ where:{id:"singleton"}, create:{ id:"singleton", …data, updatedById }, update:{ …data, updatedById }})` → `writeAuditLog(...)`（§Global Constraints）→ `{ data: <更新後解決値> }`。`handleApiError` で 422/403。
- 権限ヘルパ `requireAdmin()` はこのファイル内ローカル（sale-dm の `requireSaleDmAdmin` 準拠・`getApiSession`/`getUserPermissions`/`hasPermission`）。

### 6. APIクライアント（`src/lib/api-client.ts`）

- 型 `CompanyProfileSettings`（`nameJa/license/tel/fax/email/hp/address/updatedAt`）＋ `EMPTY_COMPANY_PROFILE_SETTINGS`。
- `fetchCompanySettings()` / `updateCompanySettings(body)`（`USE_MOCK` 短絡でEMPTY返却）。

### 7. 設定画面（`src/app/(dashboard)/admin/company-settings/page.tsx`・新規）

- `"use client"`。`useEffect` → `fetchCompanySettings()` → 各項目 `useState` に初期表示。7項目の controlled input（ラベル：会社名／宅建免許番号／電話番号／FAX番号／メールアドレス／ホームページURL／所在地）。会社名・免許番号など長さがレイアウトに効く項目には**文字数の目安**を添える（可変長で会社帯が崩れうる旨の軽い注意）。
- `save()` → `updateCompanySettings(body)` → 成功/失敗表示。sale-dm の `Field` ヘルパ様式を踏襲（秘匿系ヘルパ `KeyField` は使わない）。

### 8. 管理メニュー（`src/components/layout/sidebar.tsx`）

- `adminNavItems` に `{ label: "会社情報", href: "/admin/company-settings", icon: <Building2 … /> }` を1件追加（`lucide-react` からアイコン import）。`isAdmin` グループ内に自動描画。
- nav-source テスト（`sale-dm-settings-nav-source.test.ts` 同様）があれば会社情報リンクの存在を追加検証（新規 `company-settings-nav-source.test.ts` か既存拡張）。

### 9. 監査allowlist（`src/lib/audit-log-detail-safety.ts`）

- `ACTION_EXTRA_KEYS` に `company_profile_update: new Set(["target","updatedAt"])`（or 既存様式に合わせる）を追加。`fields` は `ALWAYS_SAFE_KEYS` ゆえ生存。

## テスト戦略

- **純関数（TDD中心）:** `resolveCompanyProfile`（DB値優先・空→フォールバック・全空→全既定）／`buildFooterBand`（3要素が**出力されない**・残り要素の内容が渡した `company` 由来・既定引数で従来同等の座標）。
- **ビルダー結線:** `buildSpecSheetDocument`/`buildSale*Document` が `company` を footer へ配線（`build-mansion.test.ts` 等の会社帯 assert を3項目削除・注入に合わせ更新）。
- **parity:** `render-html-parity.test.ts` の会社帯 assert を更新（英字社名を含む assert は削除、会社名JP等で確認）。`company-info.test.ts`・`footer-band.test.ts`・`spec-sheet-document.test.ts` を更新。
- **route:** 会社設定 GET/PUT の権限（未認証/非管理者→403）・空文字→null・upsert・監査（値を含まない）を UIレス（node env）で検証。`new/route.ts` が `loadCompanyProfile()` を会社帯へ渡すこと。
- **UIレス制約:** page.tsx のインタラクションは単体不可＝`renderToStaticMarkup`＋文字列assert or プレゼン部品SSR＋レビューで担保（既存方針）。
- **フル `npx vitest run` 緑**を「緑」宣言の根拠にする（対象限定にしない）。

## 段取り（タスク分割の目安・詳細は実装計画で）

1. Prisma モデル＋migration（`company_profile`）。
2. `company-profile-store.ts`（`resolveCompanyProfile` 純関数＋`loadCompanyProfile`）＋テスト。
3. `footer-band.ts`：会社情報注入（既定引数）＋3項目削除＋2×2再配置＋テスト更新。
4. `build-document.ts`：`SpecSheetParts.company`＋各ビルダー forward＋テスト更新。`new/route.ts` で `loadCompanyProfile()` 配線。
5. 保存API route（GET/PUT・zod・権限・監査）＋テスト。監査allowlist登録。
6. api-client ラッパー＋型＋EMPTY。
7. 設定画面 page.tsx＋sidebar nav＋nav-source テスト。
8. 視覚プレビュー（会社帯）を御社確認 → 微調整。

## 非目標 / 既知の制約

- **可変長レイアウト:** 会社帯は幅固定＋`overflow:hidden`。極端に長い値は隣接と重なる/切れる。MVPは許容＋フォームに目安表示。自動フィットは将来。
- **スナップショット:** 既存図面は遡って更新しない（作成時の値を保持）。
- **本番migration適用:** 実装・ローカル適用まで。本番反映は別承認（vps-deploy）。

## 落とし穴（先行事例から継承）

- `AuditLog.targetId` は uuid ＝ "singleton" 不可。`targetId` を渡さず `targetTable`＋`detail.target` で表す。
- 監査 allowlist 未登録＝ビューアで `[REDACTED]`。
- シングルトン行は遅延 upsert（`create` に `id:"singleton"` 明示）。読取は行不在許容。
- api-client の `USE_MOCK` 短絡を忘れない。
- worktree は `npm ci`（junction共有不可）＋`prisma generate` 済であること。
