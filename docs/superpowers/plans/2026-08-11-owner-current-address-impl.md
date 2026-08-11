# 所有者の「現住所」と「登記上住所」の分離 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development または superpowers:executing-plans をタスクごとに使う。手順は `- [ ]` で追跡する。

**Goal:** 所有者に「現住所」を持たせ、DM の宛先を現住所優先で解決する。登記上の住所は既存の `address`/`zip` に据え置く。

**設計の正本:** `docs/superpowers/specs/2026-08-10-owner-current-address-design.md`(@codex 32巡・72件対応済み)。**この計画は順序と検証の手順書であり、規則の正本ではない**。判断に迷ったら必ず設計書の該当節を読む。

**Tech Stack:** Next.js(App Router) / Prisma / PostgreSQL / vitest(env=node)

---

## Global Constraints

- **既存の `Owner.address` / `Owner.zip` は「登記上」**。意味を変えない。新設は `currentAddress` / `currentZip`(DB列 `current_address` / `current_zip`)。
- **`zip` と `address` は必ずペアで扱う**。片方だけ解決・片方だけ書き込みをしない(設計 §4・§6.1)。
- **形式を理由に郵便番号を捨てない**(海外の番号が消える。設計 §4・§6.1)。null にするのは「住所が変わったのに対になる番号が渡ってこない」ときだけ。
- **表示レベルは `owner_address` / `owner_zip` を流用**。新 resource は作らない(設計 §5)。
- **enum を作らない**。migration は additive のみ。
- **テストは env=node**(jsdom 無し)。UI は `renderToStaticMarkup` + ソース文字列アサート。
- 各タスクの終わりに **`npx tsc --noEmit`** と **そのタスクで触った範囲の vitest** を通す。最後に全ゲート。

---

## 実装前に必ずやる(タスク0)

- [ ] **書き込み箇所の全列挙**。設計 §6/§8 の表は「既知のもの」であって網羅の保証ではない。次を grep して**実際の一覧を作り、計画の各タスクと突き合わせる**:

```bash
# 所有者の住所・郵便番号に書く箇所
grep -rn "zip:" src/app/api src/lib --include=*.ts | grep -v test
grep -rn "address:" src/app/api src/lib --include=*.ts | grep -v test | grep -i owner
# 明示 select で所有者を返す箇所
grep -rn "address: true" src/ --include=*.ts | grep -v test
# 所有者の検索
grep -rn "owners/search\|searchOwners" src/ --include=*.ts --include=*.tsx
```

- [ ] 出てきた箇所のうち**計画に無いもの**があれば、**そのタスクに追記してから**着手する(32巡で「同じ処理が別系統にもある」が繰り返し出た)。

### タスク0の実測結果(2026-08-11)

`address: true` を含むのは 54 ファイル。うち**所有者の select は 32 ファイル**(残りは物件の住所)。役割ごとの割り当て:

| 役割 | ファイル | 扱い |
|---|---|---|
| **DM の宛先**(解決関数を通す) | `properties/dm-batches/route.ts` / `dm-batches/[id]/csv/route.ts` / `properties/sale-dm/campaigns/route.ts` | Task 7 |
| **検索**(生値のときだけ対象+結果表示) | `properties/suggest/route.ts` / `owners/search/route.ts` / `owners/route.ts` | Task 8 |
| **所有者の読み書き**(新2列を通す) | `properties/[id]/route.ts` / `owners/[id]/route.ts` / `properties/[id]/owners/create-and-link/route.ts` | Task 4・5 |
| **取込** | `import/owner-csv/route.ts` / `import/reception-owner/route.ts` / `import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts` | Task 9 |
| **補正・品質チェック**(登記上のまま or 両方) | `admin/owners/**` の 14 ファイル / `owners/[id]/corporate-cleanup` / `owners/[id]/corporate-lookup` | Task 10 |
| **名寄せ** | `admin/owners/correction/merge/route.ts` / `merge-preview/route.ts` | Task 11 |
| **登記上のまま**(変更不要) | `lib/owner-dedup.ts` / `lib/owner-property-linker.ts` / `lib/registry-pdf/process.ts` / `admin/postal-code-audit/route.ts` | 設計 §7 |

⚠ **計画に無かった経路が1つ見つかった**: `src/app/api/properties/property-dm-export/route.ts`(**物件宛DM**)。
→ **対象外と判定**。この経路の宛先は**物件の住所**(`Property.postalCode` + `Property.address`)で、所有者の住所・郵便番号は**出力しない**とコード内に明記されている(route.ts:33・84)。所有者の select は宛名の氏名用。**現住所の影響を受けない**。
⚠ 後から「なぜここだけ直していないのか」と問われないよう、**この判断を計画に残す**。

---

## Task 1: migration と schema(挙動は変わらない)

**Files:** `prisma/schema.prisma` / `prisma/migrations/<timestamp>_add_owner_current_address/migration.sql`

**Produces:** `Owner.currentZip` / `Owner.currentAddress`(いずれも `String?`)

- [ ] schema の `model Owner` に2列を追加(`@map("current_zip")` / `@map("current_address")`)。索引は張らない。
- [ ] `npx prisma migrate dev --name add_owner_current_address --create-only` で SQL を作り、**中身が `ALTER TABLE "owners" ADD COLUMN` の2行だけ**であることを目視。
- [ ] `npx prisma generate` → `npx tsc --noEmit` = 0。
- [ ] **この時点でアプリの挙動は一切変わらない**ことを確認(フル vitest が緑のまま)。
- [ ] commit: `feat(owner): 現住所の列を追加(additive・挙動不変)`

## Task 2: 宛先の解決(純関数)

**Files:** Create `src/lib/owner-mailing-address.ts` / Test `src/lib/__tests__/owner-mailing-address.test.ts`

**Produces:**
```ts
export type MailingAddress = { zip: string | null; address: string | null; source: "current" | "registry" | "none" };
export function resolveMailingAddress(owner: {
  zip: string | null; address: string | null;
  currentZip: string | null; currentAddress: string | null;
}): MailingAddress;
/** グループ(同一送付先)の郵便番号を決める。設計 §4.0 */
export function resolveGroupZip(zips: (string | null)[]): string | null;
```

- [ ] 先にテストを書いて **RED** を確認する。最低限のケース:
  - 現住所あり+番号あり → current / 現住所あり+番号空 → 番号は空(登記上を混ぜない) / 現住所なし → registry / 両方なし → none
  - **海外の番号**(`10001`・`SW1A 1AA`)がそのまま返ること
  - `resolveGroupZip`: 全員空→null / 1種類→それ / **書き方違い(`1500001` と `150-0001`)→1種類扱い** / 2種類→null
- [ ] 実装 → GREEN。⚠ **正規化は既存の `normalizeZipForGroup` を使う**(独自実装しない)。
- [ ] commit

## Task 3: 表示レベル(PII)の配線 ← **公開より先**

**Files:** `src/lib/display-level.ts` / `src/lib/api-helpers.ts` / Test `src/lib/__tests__/display-level-current-address.test.ts`

- [ ] `OwnerDisplayConfig` / DEFAULT / full・hidden プリセット / `applyDisplayToOwner` / field masking 表に新2列を追加(`owner_address` / `owner_zip` の値を流用)。
- [ ] テスト: 表示レベルが `masked`/`hidden` のとき**新しい2列もマスクされる**こと(fail-open の検出)。
- [ ] ⚠ **ここを飛ばして先の Task を進めない**。マスク無しで API に出すと生の住所が漏れる。
- [ ] commit

## Task 4: 読み取り経路(API の select と型)

**Files:** `src/app/api/properties/[id]/route.ts`(**GET と PATCH の両方**) / `src/lib/api-client.ts` / タスク0の grep で出た明示 select 全部

- [ ] `select` に新2列を追加。**GET だけ直して PATCH を忘れない**(設計 §8)。
- [ ] `api-client.ts` の Owner 系レスポンス型に追加。
- [ ] テスト: **現住所が入っている所有者を読み込み、応答に含まれる**こと(欠けると編集フォームが空で保存し現住所を消す)。
- [ ] commit

## Task 5: 書き込み(手入力系)とペアの規則

**Files:** `src/lib/validators.ts` / `src/lib/owner-create.ts` / `src/lib/owner-edit-utils.ts` / `src/app/api/owners/[id]/route.ts` / `src/app/api/owners/route.ts` / `src/app/api/properties/[id]/owners/create-and-link/route.ts` / `src/lib/property-field-constants.ts`

**Consumes:** Task 2 の型

- [ ] `createOwnerSchema` と `updateOwnerSchema`(**両方**)に2列。
- [ ] `OwnerCreateData` / `OWNER_FIELD_WRITE_RESOURCES` / `createFieldWriteChecks` / `fieldWriteChecks` / create の**明示列挙**(3 route)に2列。
- [ ] `OWNER_TRACKED_FIELDS` に2列(変更履歴)。
- [ ] **ペアの規則(設計 §6.1)をサーバー側に実装**:
  - `currentAddress` が変わるのに `currentZip` が同時に来ない → `currentZip` を null にする
  - **`currentZip` だけの更新は 400 で拒否**
- [ ] **§6.1.1**: 暗黙のクリアも `owner_zip` への書込として扱い、権限が無ければ **403**(住所の更新ごと拒否。黙って省略しない)。
- [ ] テスト: 住所だけ送る/番号だけ送る/`owner_address` は書けるが `owner_zip` は書けない利用者 → それぞれ期待どおり。
- [ ] commit

## Task 6: 所有者の編集 UI(2段化)

**Files:** `src/app/(dashboard)/properties/[id]/page.tsx`(所有者カード) / `src/components/owners/owner-link-modal.tsx`

- [ ] 住所欄の横にボタン。ホバーで「登記上の住所と現在の所在が違う場合はクリックしてください」。
- [ ] 押すと2段になり、**住所と郵便番号をペアでコピーして開始**(設計 §3.2 の図)。
- [ ] **住所を1文字でも編集したら現住所の郵便番号を空にする**。
- [ ] `AddressLookupControls` は**現住所側だけ**に付ける。
- [ ] 保存時に「現住所はあるが番号が空」なら注意を出す(保存は妨げない)。
- [ ] **2画面とも同じものを実装**(片方だけだと作成→編集の2手になる)。
- [ ] テスト: SSR + ソース文字列アサート(env=node のため)。
- [ ] commit

## Task 7: DM の宛先(5系統を1本に通す)

**Files:** `src/lib/dm-export.ts` / `src/app/api/properties/dm-batches/route.ts` / `.../[id]/csv/route.ts` / `src/lib/dm-batch/eligibility.ts` / `src/app/api/properties/sale-dm/campaigns/route.ts` / `src/lib/sale-dm-letter/recipients.ts`

**Consumes:** Task 2

- [ ] `ownerAddressGroupKey` / `groupPropertyOwnersByAddress` / `buildDmRow` を**解決後の値**で。**鍵は住所だけ**(設計 §4.0)。空住所 skip は「現住所も登記上も空」に。
- [ ] グループの郵便番号は `resolveGroupZip`。
- [ ] `dm-batches` の where(`address: { not: "" }`)と件数集計を「どちらかが非空」に。`select` に2列。
- [ ] `eligibility.ts` の型と判定。
- [ ] **売却DM も同じ純関数を通す**(`recipients.ts` は `buildDmRow` を通っていない。設計 §4 の警告)。
- [ ] テスト(**組み合わせで**): 同じ現住所の共有者は1通/別々の現住所は2通/登記上が空でも現住所があれば対象/番号が片方だけ/番号が食い違う(→空)/**売却DMでも同じ結果**。
- [ ] commit

## Task 8: 検索と結果表示(3入口・4画面)

**Files:** `src/app/api/properties/suggest/route.ts` / `src/app/api/owners/search/route.ts` / `src/app/api/owners/route.ts` / `src/components/owners/owner-link-modal.tsx` / `src/components/owners/OwnerMislinkModal.tsx` / `src/app/(dashboard)/import/jobs/[jobId]/page.tsx` / `src/app/(dashboard)/properties/page.tsx`

- [ ] 検索対象に現住所を追加。⚠**表示レベルが生値のときだけ**(`SEARCHABLE_LEVELS` と同じ規則)。
- [ ] ⚠ `owners/search` と `owners` 一覧は **`applyDisplayToOwner` を通さず手書き**なので、そこにも同じ規則で入れる。
- [ ] **結果に現住所(マスク済み)を返し、4画面すべてで表示**する。とくに `OwnerMislinkModal` は現在**氏名とIDしか出ていない**。
- [ ] テスト: 生値のとき当たる/マスク時は当たらない(検索オラクル)/**当たった値が画面に出る**。
- [ ] commit

## Task 9: 取込(5経路)

**Files:** `src/lib/csv-parser.ts` / `src/app/api/import/owner-csv/route.ts` / `src/lib/reception-owner-match.ts` / `src/app/api/import/reception-owner/route.ts` / `src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts` / `.../retry/route.ts` / `.../manual-link-reception-owner/route.ts`

- [ ] **列の対応表3箇所**(`OWNER_CSV_COLUMN_MAP` / route 内 `JAPANESE_FIELD_TO_PROPERTY` / `createData` の明示列挙)。
- [ ] **ペア取込**: `OWNER_HEADER_TO_FIELD` / `parseOwnerRows`(⚠登記上住所の4列連結を流用しない) / `ParsedOwnerRow` / プレビュー / upsert。
- [ ] ⚠ **`parseSheet` に `formattedTextHeaders` で郵便番号2列を渡す**(プレビューと本取込の両方)。**先頭ゼロが消える**。
- [ ] **`__owner_link_data` の中身**と `RecoveredOwner` 型、`manual-link` の create/update に2列。
- [ ] **取込エラー行の編集/再試行**: 2 route は**完全なコピペ重複**。**共通モジュールへ切り出してから**足す。
- [ ] **`link_existing`** でも空欄補完。
- [ ] **設計 §6.3 の3規則をすべての補完経路に**: ペアを分解しない/ロックの下で読み直す/行の確保〜完了を1 tx。
- [ ] 補完時は**項目ごとの変更履歴**を同じ tx で作る(Task 11 の門が判断できるように)。
- [ ] テスト: ヘッダ自動判定/列の対応を明示指定/**ペア取込を端から端まで**/**先頭ゼロの郵便番号**/住所が違う組み合わせで何も入らない/補完直前に手入力→上書きされない/同じ行への同時解決で片方 409。
- [ ] commit

## Task 10: 補正・品質チェック

**Files:** `src/app/api/admin/owners/[id]/correction/text-fix/route.ts` / `.../contact-fix/route.ts` / `src/app/api/admin/owners/text-hygiene-candidates/route.ts` / `src/app/api/admin/owners/contact-quality-candidates/route.ts` / 品質チェック画面 / `src/app/api/admin/owners/[id]/corporate-apply/route.ts` / `src/app/api/admin/owners/correction/corporate-restore-apply/route.ts` / `src/components/owners/corporate-lookup-panel.tsx` / `src/app/api/admin/owners/[id]/registry-address-cleanup/route.ts` / `src/app/api/admin/owners/[id]/correction/address-fill/route.ts` / `src/lib/owner-correction.ts` / `src/app/api/admin/owners/[id]/corporate-candidate/route.ts` / `src/app/(dashboard)/admin/owners/[id]/page.tsx`

- [ ] **候補探しの2つ**(text-hygiene / contact-quality)に現住所・現住所郵便番号を追加(画面の型・配線も)。
- [ ] `text-fix`: **正規化して同値なら郵便番号を据え置き、変われば §6.1 の通常規則でクリア**(クリア時は `owner_zip` 権限が要る)。
- [ ] `contact-fix`: 現住所が非空のとき、**住所を据え置いたままペアとして書き直す**形なら整形も数字の修理も許す。⚠**住所の生値表示レベルと `owner_address` の書込権限を要求**。
- [ ] `corporate-apply` / `corporate-restore-apply`: **住所と郵便番号を一組でしか反映させない**。`corporate-restore-apply` の nta モードは **`cleanedAddress` を登記上へ・国税庁のペアを現住所へ**(両方書く)。
- [ ] `registry-address-cleanup` / `address-fill` は**登記上のみ**。⚠ `owner-correction.ts` の `extractAddressFromRawData` の候補キーから**現住所系を除外**。
- [ ] admin 所有者詳細: **両方返して両方表示**し、ラベルを「現住所」「登記上住所」に正す。
- [ ] テスト: 設計 §6.1/§6.2/§6 の各テスト項目。
- [ ] commit

## Task 11: 名寄せ(統合)

**Files:** `src/app/api/admin/owners/correction/merge/route.ts` / 安全確認の実装

- [ ] **引き継ぎ3通り**(設計 §7 の表)+ **拒否2通り**(住所が違う/同じ住所で番号が違う)。
- [ ] **安全確認の門**: 変更履歴の項目が現住所2列**だけ**で、**かつ引き継ぎが実際に行われる**ときのみ許す。
- [ ] **ChangeLog を手組みの並びに追加**(この route は `recordChanges` を呼んでいない)。
- [ ] **権限**: `owner:write` と `owner_address`/`owner_zip` の書込を要求。無ければ **403**(統合ごと拒否)。
- [ ] テスト: 3通りの引き継ぎ/2通りの拒否/権限不足で403/作成後に現住所を足した source が統合できる/他項目も編集された source は従来どおり拒否。
- [ ] commit

## Task 12: 売却DMの古い下書き

**Files:** `src/app/api/properties/sale-dm/drafts/confirm/route.ts`

- [ ] 確定時に、保存済み宛先と**いまの解決結果**が食い違えば **409**「宛先を作り直してください」。
- [ ] ⚠ **下書きの所有者を既定の順序でロックした tx の中で**読み直して判定し、同じ tx で状態を変える(`lockOwnersForShare` の既存の型に合わせる)。
- [ ] テスト: 古い下書きの確定が409/作り直せば確定できる/**確定と住所更新を並行**させても古い宛先で確定されない。
- [ ] commit

## Task 13: 走査型ガードと全ゲート

**Files:** Create `src/lib/__tests__/owner-field-wiring.test.ts`

- [ ] **画面名やフィールド名を手で並べないガード**: `Owner` の列を足したとき `OWNER_TRACKED_FIELDS` / `display-level` の表 / `fieldWriteChecks` の3点に入っていなければ落ちる(今回と同種の抜けを将来も自動検出)。
- [ ] 全ゲート:
  - `npx tsc --noEmit` = 0
  - **`npx vitest run`(フル)**
  - `npx eslint <変更ファイル>` = 0 error(疑わしければ `git stash` でベースライン比較)
  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
- [ ] 提出前レビュー(`feature-dev:code-reviewer`)にホットスポットを明示して依頼: **ペアの一貫性・権限の迂回・取込の全経路・並行操作・表示レベルの fail-open**。
- [ ] PR 作成 → `@codex review` → クリーンまで。

---

## 反映時の手順(実装とは別・ユーザー承認後)

1. `npm ci` → ⚠**`npx prisma generate`** → `npx prisma migrate deploy` → `npm run build` → `npm prune` → `systemctl restart`
2. **restart の後**に、**反映前に作られた未確定の売却DM下書きを無効化**(設計 §4.1。反映直前に件数を再確認)
3. 反映直後に `current_address` の非NULL件数を数える(0件のうちは軽く戻せる)
4. ⚠ **切り戻しは「現住所が1件も入っていない間」だけ安全**。入った後は原則「前へ倒す」。やむを得ず戻すときは**所有者の編集・DM出力・統合・補正を止めてから**(設計 §9.1)
