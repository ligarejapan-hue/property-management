# 取引・帳票 段3後半その2(ロゴ・角印・文面の設定と書類への埋め込み)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 取引の設定でロゴ・角印の画像と、書類ごとの文面(あいさつ文・注意事項)を登録でき、資金計画表の PDF・プレビューにロゴと文面、Excel に文面が入る。

**Architecture:** 画像は専用の API(管理者だけ)で受け取り、EXIF を落として保存場所の `deal-settings/` に置き、`deal_settings.logo_key / seal_key` に鍵を書く(版の番号で守る)。書類を作るときはサーバーが画像を読み、`data:` の URL にして HTML に埋め込む(PDF を作るブラウザは外を読まない)。文面は `deal_settings.texts` に `{ funding_plan: { greeting, notes } }` で持つ。

**Tech Stack:** Next.js 16 route handlers, Prisma 7, zod 4, vitest 4

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md`(§2.4・§4.2・§5 取引の設定・§6「ロゴ・角印と文面は段3」)

## Global Constraints

- DB の変更なし(`logo_key`・`seal_key`・`texts` は段1で作成済み)。新しい部品なし。
- 取引の設定は管理者だけ(`requireDealAdmin`)。
- 画像は PNG・JPEG だけ。保存前に EXIF を落とす(位置情報を残さない恒久ルール)。
- 監査には種類・寸法・バイト数だけ。ファイル名は残さない。
- 前職の文面は使わない。初期の文面は空(入れた人の文だけが出る)。

## 読み替え(Rulings)

1. **このブランチは段3後半その1の上に重ねる。** その1(発行・書類タブ)がまだマージ前のため。PR の向き先はその1のブランチにし、その1がマージされたら main に向け直る。
2. **画像は `/uploads` からは配らない。** `deal-settings/` の鍵は `/uploads` で明示的に 404。設定画面の見本は管理者だけの専用の道 `GET /api/admin/deal-settings/images/[kind]` で出す。
3. **画像の差し替え・削除は文字の設定と別の道にし、同じ版の番号で守る。** 画面は画像を変えたあと、入力中の文字を消さないよう、版の番号と「画像あり」だけを差し替える。
4. **角印は登録と見本の表示まで。** 資金計画表は角印を使わない書類(設計 §4.4 の領収書などで使う=段5)。
5. **ロゴは PDF・プレビューにだけ入れ、Excel には入れない。** Excel には文面(あいさつ文・注意事項)を入れる。理由: Excel は数字を直して使う控えで、画像の位置合わせの手間に見合わない。
6. **画像のファイルが見つからないときは、ロゴなしで書類を作る。** 発行を止めない。
7. **上限:** 画像 1MB・長辺 2000px。あいさつ文 400 字・注意事項 1000 字(改行あり)。

## Review Focus

1. 管理者でない人が画像を上げる・見る → 403。`/uploads/deal-settings/...` → 404。
2. 画像の差し替えで古いファイルを消す/記録に失敗したら新しいファイルを消す。
3. 画像の形と中身が合わない(PNG と言って中身が違う)→ 422。
4. 文面の HTML がエスケープされる(`<script>` が文字のまま)。改行が保たれる。
5. 画面で文字を入力中に画像を変えても、入力が消えない。

---

### Task 1: 文面の設定(schema・解決・保存)
- `dealTextsSchema`(`funding_plan: { greeting: text(400), notes: text(1000) }`・strict)を `dealSettingsUpdateSchema.texts` に足す。
- `resolveDealSettings` が `texts`・`hasLogo`・`hasSeal` を返す(鍵そのものは返さない)。

### Task 2: 画像の API と保存
- `src/lib/deals/branding.ts`(純関数): 種類・MIME・鍵 `deal-settings/<kind>-<id>.<ext>`・`isDealSettingsStorageKey`・data URI。
- `src/app/api/admin/deal-settings/images/[kind]/route.ts`: GET(見本)・POST(multipart・version)・DELETE(?version=)。
- `src/lib/uploads-authorization.ts`: `deal-settings/` も 404。
- 監査 `deal_settings_image_update`。

### Task 3: 書類への埋め込み
- `loadDealBranding()`(サーバー): ロゴを data URI に。
- 資金計画表の HTML: 会社欄の上にロゴ、作成日の下にあいさつ文、末尾に注意事項。Excel: あいさつ文と注意事項の行。
- 発行・プレビューの両方で使う。

### Task 4: 設定画面・説明書
- 取引の設定に「ロゴ・角印」「書類の文面(資金計画表)」の欄。画像は共通の枠(FileDropZone)で。
- guide/manual に追記。
