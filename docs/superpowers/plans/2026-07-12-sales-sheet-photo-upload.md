# 販売図面 写真のローカルアップロード 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 販売図面エディタの写真パネル（「写真を追加」）に、物件ギャラリーからの選択に加えて**ローカルのフォルダから写真をアップロード**する導線を追加する。アップロードした写真は物件の写真として保存され、ギャラリーに現れて図面に追加できる。

**Architecture:** クライアントのみ。**サーバは既存の `POST /api/properties/[id]/photos`（multipart・`property:write`＋所有物件認可）を再利用**する（これが必須＝保存時 IDOR ガード `isUploadKeyOwnedByProperty` が PropertyPhoto 行を要求するため、sheet-scoped な別保存にすると保存時422になる）。`PhotoGalleryPanel` にアップロード UI（`FilePickerButton` 再利用・複数可）とアップロード→再取得ロジックを足す。バックエンド・スキーマ・保存境界は無改修。

**Tech Stack:** React client component / 既存 storage・認可 / Vitest（env=node・SSR構造テスト＋レビュー担保）。

## Global Constraints
- **サーバ無改修**：既存 `POST /api/properties/[id]/photos`（`file` フィールドの multipart）を使う。zod/route/storage/認可は変更しない。
- 新規ID生成が要る場合は `safeRandomId`（HTTP本番＝crypto.randomUUID不可）。ただし図面要素追加は既存 `onAddPhoto`→`addImageElement`（`safeRandomId` 内包）に委ねる＝本PRで新規ID生成なし。
- `/uploads` 認可・EXIF は既存挙動のまま（**PropertyPhoto は GPS を意図的に保持＝invariant test 有り**。EXIF strip を property-photo 経路へ足さない）。
- 追加できる src は `isSafeImageSrc`（`/uploads/` か `data:`）のみ＝既存ガード踏襲。
- クライアント fetch/アップロードの対話は SSR 構造テスト＋レビューで担保（jsdom無）。
- TDD（純関数/構造）。フル `npx vitest run` 緑・tsc0・eslint0・build 緑。

## 決まったこと（承認済み設計）
- アップロードした写真は**その物件の写真として永続保存**（物件の写真タブ・他図面にも出る）＝ユーザー了承済み。
- GPS は既存の物件写真と同様**除去しない**＝ユーザー了承済み。
- UX：アップロード→ギャラリー再取得（新写真が現れる）→ユーザーがクリックして図面に追加（既存フロー）。自動追加はしない（複数アップロード時の過剰追加を避ける）。

---

## Task 1: 写真パネルにローカルアップロード導線

**Files:** Modify `src/components/import/file-picker-button.tsx`（`multiple?` 追加）, `src/components/sales-sheet/editor/PhotoGalleryPanel.tsx`; Test（SSR構造）`src/components/sales-sheet/editor/__tests__/photo-gallery-panel.test.tsx`（無ければ新規）。

**Interfaces:**
- Consumes: `FilePickerButton`（既存・default export）、`POST /api/properties/[id]/photos`、`GET /api/properties/[id]/photos`（既存）。
- Produces: なし（UI）。

- [ ] **Step 1: `FilePickerButton` に `multiple?: boolean` を後方互換で追加**
  - props に `multiple?: boolean`（既定 undefined＝false）。`<input type="file" ... multiple={multiple} />`。registry-DM の既存呼び出しは無指定＝従来どおり単一。
  - 既存テストがあれば緑を確認（挙動不変）。

- [ ] **Step 2: `PhotoGalleryPanel` — 再取得関数の抽出**
  - `useEffect` 内の取得を `loadPhotos()`（`propertyId` クロージャ or 引数）へ抽出し、初回 `useEffect` と アップロード後の両方から呼べるようにする（`cancelled` ガードは維持）。`photos`/`error` state は据え置き。

- [ ] **Step 3: アップロード UI＋ロジック**
  - パネル本文（ギャラリーの上）に「ローカルからアップロード」セクション：`FilePickerButton`（`accept="image/*"`・`multiple`・`label="写真をアップロード"`・`hint="JPEG/PNG/WebP・1枚8MBまで・複数可"`）。
  - `uploading: boolean` / `uploadError: string | null` state。
  - onChange：選択ファイルを順に `POST /api/properties/${propertyId}/photos`（`FormData` に `file` を append・`method:"POST"`・**Content-Type は自動**＝手動指定しない）。全件終了後に `loadPhotos()` で再取得。失敗（非2xx/例外）は件数付きで `uploadError` に表示（例「N枚中M枚アップロードできませんでした」）。アップロード中は FilePicker を `disabled`＋「アップロード中…」。
  - 8MB 超/対象外 mime はサーバが 4xx を返す＝そのメッセージ or 定型文で `uploadError`。**クライアントでも過大サイズは事前に弾いて良い**（任意）。
  - アップロードした写真は再取得で現れ、既存 `PhotoGrid`→`onPick`→`onAddPhoto` で図面に追加できる（自動追加なし）。

- [ ] **Step 4: SSR 構造テスト**
  - `renderToStaticMarkup(<PhotoGalleryPanel .../>)` 初期描画に、アップロードの `FilePickerButton`（`data-file-picker` or ラベル文言「写真をアップロード」）＋ `<input type="file" ... multiple>` が含まれることを構造 assert。既存 `PhotoGrid` の描画テストがあれば非回帰を確認。
  - （対話＝アップロード→再取得は SSR 不可＝レビュー担保。可能なら `uploadPhotoFiles(propertyId, files, fetchImpl)` を純関数化し fetch を注入してユニットテスト。）

- [ ] **Step 5: ゲート** — フル `npx vitest run` 緑・`npx tsc --noEmit`=0・`npx eslint <変更ファイル>`=0・`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 緑。
- [ ] **Step 6: commit** `feat(sales-sheet): 写真パネルにローカルアップロード導線(既存photos endpoint再利用)`。

---

## 実装後（コーディネータ）
- 最終 whole-branch review（opus・**認可/IDOR/アップロード経路**を重点）→ push → PR（base=main）→ @codex（codex-triage・アップロード/認可は@codexの強み）→ clean → **ユーザーマージ**。

## スコープ外
sheet-scoped な一時写真・EXIF strip の property-photo 経路への追加（invariant 違反）・自動追加・アップロード進捗バー。
