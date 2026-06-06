# 現地調査写真 — プライバシーチェックリスト（EXIF GPS 取扱い）

現地調査ピン写真（FieldSurveyPinPhoto）のプライバシー保護について、
**実装済みで担保されている範囲**と、**未実装のまま残っている gap（画像ファイル本体の EXIF GPS）**を明文化する。

- EXIF stripping の本実装は **未承認・未実装**（2026-06-06 時点）。本 docs は設計判断の前提整理であり、コード仕様を変更しない。
- DB/API レスポンスの PII 非保存 invariant は PR #132 で、非 HTTPS 警告バナーは PR #135 で merge 済み。

> 取り扱い注意: 本チェックリストに沿って確認する際も、**実画像・実座標・実個人情報を
> PR 本文・Issue・チャット・ログ・スクリーンショット・テスト fixture に残さない**こと。
> EXIF の有無を確認する場合も「GPS タグが有る/無い」の結果のみを記録し、座標値そのものは書かない。

関連実装:

- アップロード API: `src/app/api/field-survey/pins/[id]/photos/route.ts`
- クライアント: `src/components/field-survey/pin-create-modal.tsx` / `pin-detail-panel.tsx` /
  `use-field-survey-pin-photo-mutations.ts`
- 検証定数: `src/lib/storage/types.ts`（`ALLOWED_PHOTO_MIMES` / `MAX_FILE_SIZE` / `validateFile`）
- storage adapter: `src/lib/storage/local-adapter.ts` / `server-adapter.ts` / `s3-adapter.ts`
- 配信 proxy: `src/app/uploads/[...path]/route.ts` + `src/lib/uploads-authorization.ts`
- invariant test: `src/lib/__tests__/field-survey-photo-pii-invariants.test.ts`
- route test（audit ロック等）: `src/lib/__tests__/field-survey-pin-photos-route.test.ts`

---

## 1. 現状の安全範囲（実装済み・テストロック済み）

以下は既に実装され、テストで回帰検知される。**本 docs の対象外（再実装不要）**。

- [ ] **DB**: `FieldSurveyPinPhoto` に GPS / EXIF / metadata / storageKey 列が **存在しない**
  （スカラー10列のみ: id, pinId, fileUrl, thumbnailUrl, fileName, fileSize, mimeType,
  uploadedByUserId, sortOrder, createdAt。schema コメント「EXIF / GPS 列は作らない (PII 蓄積回避)」）
- [ ] **座標はピン側**: 位置情報は `FieldSurveyPin`（lat / lng / accuracy）にのみ保存され、写真テーブルとは分離
- [ ] **API レスポンス**: `SELECT_PHOTO` projection が storageKey / 座標 / EXIF / uploadedByUserId を返さない
- [ ] **audit**: 写真 upload / delete の `detail` は `{pinId, photoId}` のみ
  （URL / fileName / 座標は監査ログに出さない・route test でロック）
- [ ] **fileUrl は常に proxy 相対** `/uploads/{key}`（絶対 URL を保存しない = `/uploads` 認可 proxy の迂回防止）
- [ ] **配信認可**: `/uploads` は `authorizeUploadAccess` で
  「自分のピン + `field_survey:read`」または「他人のピンは `read_all` / `manage`」を満たす場合のみ返す
- [ ] **非 HTTPS 警告**: insecure context では地図画面にバナー表示（PR #135）

---

## 2. 残る gap（本 docs の主対象）

**（2026-06-07 更新）新規アップロード分は、POST route が保存前に EXIF/GPS strip
（`stripFieldSurveyPhotoMetadata`）を実行するようになった（route 接続済み・下記 5. 参照）。**

ただし、以下の gap / 残余は引き続き残る:

- **route 接続前にアップロード済みの画像ファイルには EXIF GPS が残っている**
  （遡及 strip は未実施・別タスク・要承認 = 下記 6.）
- strip 対象は JPEG / PNG / WebP のみ。**HEIC / HEIF は本 route で 422 reject**（保存されない）
- **MakerNote / XMP / PNG tEXt 系は strip 対象外**（残余。utility 先頭コメント参照。
  「完全解消」ではない）
- storage adapter（local / server / s3）は引き続きバイト無加工で保存する
  （strip は field-survey route 層の責務。adapter には入れない = 下記 4. 注意参照）
- `/uploads` 配信 proxy は認可後に保存バイトをそのまま返す（新規分は strip 済バイト）

補足:

- DB / API レスポンス / audit の防衛（上記 1.）は **ファイルバイトには及ばない**。別レイヤの問題である
- local backend（開発時）は `public/uploads/` 配下へ書き込むため、proxy を経ない static 配信経路があり得る
  （本番は server / s3 backend のため非該当）
- 運用緩和（任意・強制力なし）: 調査端末側でカメラアプリの位置情報タグを OFF にしておく
  （既存保存分と strip 残余への防御として引き続き有効）

---

## 3. 現在のアップロード経路（コード上の事実）

```
client <input type="file" accept="image/*" capture="environment">
  → File を無加工で FormData に append
  → POST /api/field-survey/pins/[id]/photos
      validateFile(MIME allowlist + 8MB)            ← 判定のみ・変換なし
      Buffer.from(await file.arrayBuffer())         ← 生バイト
      stripFieldSurveyPhotoMetadata(buffer, mime)   ← EXIF/GPS strip（HEIC/HEIF・malformed は 422）
      storage.upload(strippedBuffer)                ← strip 後バイトのみ保存
  → prisma.fieldSurveyPinPhoto.create（proxy 相対 fileUrl・fileSize は strip 後サイズ）
  → GET /uploads/{key}（認可後、保存バイトを返却）
```

- MIME allowlist: `image/jpeg` / `image/png` / `image/webp` / `image/heic` / `image/heif`
  （`ALLOWED_PHOTO_MIMES`。**property / building の写真 route とも共有**される定数）
- サイズ上限: 8 MB（`MAX_FILE_SIZE`）
- クライアント側に canvas / 再エンコード等の画像処理は存在しない（File がそのまま送られる）

---

## 4. 実装候補（Explore→Plan 比較の要約）

| 候補 | 概要 | 判定 |
|---|---|---|
| A. client canvas 再エンコード | package 不要だが、Android で HEIC を decode できず無音失敗・orientation 反映がブラウザ依存・vitest(node) でテスト不能・直接 API POST で迂回可能（server invariant にならない） | 不採用 |
| B. server 画像ライブラリ（sharp 等） | 一貫性は高いが package + lock 変更が必要。prebuilt sharp は HEIC 非対応（libvips 系のシステム依存 = VPS ビルド複雑化）・再エンコードは lossy | 代替案（要 package 承認） |
| B0. pure TS route-level strip | **依存追加なし・lossless（再エンコードなし）・server-side invariant・合成バイト fixture で vitest ロック可**。field-survey route 内（Buffer 生成〜 `storage.upload` の間）にのみ挿入 | **推奨** |
| C. 配信時（/uploads）strip | 原本（GPS 付き）が at rest に残り続けるため目的未達。read 毎の CPU 負荷・キャッシュ矛盾もある | 不採用 |
| D. docs / 運用ルールのみ | 即時可能だが利用者の設定規律に依存し、強制力も検証手段もない | 暫定併用のみ（本 docs がこれに相当） |

注意（B0 / B 共通の前提）:

- **挿入位置は field-survey route 内のみ**とする。storage adapter 層に入れると
  property / building / attachment / registry-pdf の全アップロードに波及し、
  **PropertyPhoto の gpsLat / gpsLng / takenAt 保持 invariant（テストロック済み）を破壊する**ため不可
- sharp は Next.js の推移的 optionalDependency として node_modules に存在するが、
  **未宣言のまま import して使うことは不可**（Next.js 側の都合で消え得る・環境によって install されない・
  prebuilt は HEIC 非対応）。B 案を採る場合は package.json への明示宣言（= package 承認）が必要

---

## 5. 推奨候補

**B0: field-survey route-level の pure TS strip**（承認後に別 PR で実装）。

- 形式別の処理: JPEG = EXIF（APP1）内の GPS 情報を除去 / PNG = `eXIf` chunk 除去 /
  WebP = RIFF 内 EXIF chunk 除去 / **HEIC・HEIF = 手書きパース困難なため方針承認が必要**（下記 6.）
- lossless（画素データの再エンコードなし）のため画質・ファイルサイズに影響しない
- route 内の server-side 処理のため、クライアントを差し替えても迂回できない
- 合成バイト fixture（手組みの最小 JPEG/PNG/WebP バイト列）で実画像なしにテスト固定できる
  （vitest environment "node" と整合）

進捗メモ:

- POC（PR #142）: pure utility `src/lib/field-survey/exif-strip.ts`
  （JPEG = GPS IFD zero-fill・Orientation 保持 / PNG = eXIf chunk drop /
  WebP = EXIF chunk drop + RIFF size 再計算 / HEIC・HEIF = unsupported / 構造不正 = malformed）と
  合成バイト fixture テスト `src/lib/__tests__/field-survey-exif-strip.test.ts` を追加済み。
- **（2026-06-07）route 接続済み**: POST `/api/field-survey/pins/[id]/photos` が保存前に
  utility を必ず通し、**strip 後 buffer のみ** `storage.upload()` に渡す
  （HEIC/HEIF・malformed は 422。下記 6. の決定に基づく）。
  これにより**新規アップロード分の §2 gap は解消**。既存保存分（遡及）と strip 残余
  （MakerNote / XMP / PNG tEXt 系）は §2 のとおり残る。
- 適用は field-survey photos route 限定（PropertyPhoto / BuildingPhoto / attachments は非適用。
  route test の source assertion でロック）。

---

## 6. 実装方針の決定状況（2026-06-07 時点）

- [x] **HEIC / HEIF の扱い = field-survey route で 422 reject**（採用・実装済み）。
  共有定数 `ALLOWED_PHOTO_MIMES` は変更せず、strip 段階の route 側分岐で 422 にする。
  エラーメッセージは PII を含まない汎用文言
  （「この画像形式は現地調査写真では現在サポートされていません。JPEG / PNG / WebP を使用してください。」）。
  iPhone 既定形式のため UX 影響は実機検証（下記 7.）で確認する
- [x] **malformed（パース不能）画像 = fail-closed（422 reject）**（採用・実装済み）。
  原本をそのまま保存する fail-open は silent gap になるため不採用。
  エラーメッセージは「画像ファイルを処理できませんでした。」（PII 非含有）
- [x] **JPEG の除去方式 = GPS IFD のみ外科的削除（zero-fill）**（採用・PR #142 で実装）。
  Orientation タグ保持 = 表示回転に影響なし。MakerNote 内の位置情報は理論上残り得る
  （残余として許容・§2 に明記。APP1 全 drop + Orientation 再注入案は採らなかった）
- [ ] **既存アップロード済み画像の遡及 strip**: 未決のまま（route 接続 PR の対象外。
  storage 内の走査が必要・別タスク・別承認）
- [x] **PropertyPhoto には適用しない**（不変条件・維持）:
  PropertyPhoto の gpsLat / gpsLng / takenAt は物件ドキュメント用途で**意図的に保持**しており、
  invariant test が保持を強制する。EXIF strip は FieldSurveyPinPhoto（field-survey route）限定
  （route test の source assertion でもロック）

---

## 7. 実機検証項目（実装後・実端末での確認）

実装 PR の merge 後、実端末で以下を確認する。
**確認に使った実画像・座標値は記録に残さない**（GPS タグの有無のみ記録する）。

- [ ] **iPhone JPEG**: カメラの位置情報タグ ON で撮影 → アップロード → ダウンロードしたファイルに GPS タグが無い
- [ ] **Android JPEG**: 同上
- [ ] **HEIC / HEIF**: 承認した方針どおりに動く（422 の場合: エラーメッセージが利用者に分かる文言か）
- [ ] **orientation**: 縦持ち / 横持ちで撮影した写真が、一覧サムネイル・プレビューで横倒しにならない
- [ ] **画質・サイズ**: lossless 方式でファイルサイズが増えない・見た目の劣化がない
  （strip 後はむしろわずかに小さくなるのが正常）
- [ ] **アップロード成功 / 失敗時の表示**: 成功時プレビュー正常・失敗時（422）に再撮影 / 再選択へ誘導できる
- [ ] **EXIF 確認手順**: ダウンロードした実ファイルを exiftool 等のローカルツールで確認する
  （オンラインの EXIF 確認サービスへ実写真をアップロードしない）
- [ ] **既存テストが green のまま**（下表のロックを破壊していない）

---

## 付録: 壊してはいけない既存テストロック（回帰検知用）

| 観点 | テスト |
|---|---|
| FieldSurveyPinPhoto = 10 列の set 一致・GPS/EXIF/storageKey 等の禁止トークン不在 | `field-survey-photo-pii-invariants.test.ts` |
| PropertyPhoto の gpsLat / gpsLng / takenAt **保持**（消してはいけない側） | `field-survey-photo-pii-invariants.test.ts` |
| `SELECT_PHOTO` projection が座標 / storageKey / EXIF を含まない | `field-survey-photo-pii-invariants.test.ts` |
| route 内の設計コメント（storageKey 非出力 / EXIF 列なし）の存在 | `field-survey-photo-pii-invariants.test.ts` |
| 写真 upload / delete の audit detail = `{pinId, photoId}` のみ（URL / 拡張子 / 座標を含まない） | `field-survey-pin-photos-route.test.ts` |
| 非 HTTPS 警告バナー（helper 使用・hostname 等を JSX に出さない） | `field-survey-insecure-context-banner-source.test.ts` |

> EXIF strip 実装 PR では、上記を**一切変更せずに** strip 用の新規テスト
> （合成バイト fixture による「GPS タグが消えている」「Orientation が方針どおり」等）を追加する。
