# F11: /uploads 配信負荷 — 現状調査と改善 Plan（17-A・read-only Explore 起点）

dashboard 性能改善の残候補 F11「uploads 配信負荷」の調査結果と改善候補の整理。
**本ドキュメントは Plan であり、候補 A〜E は未実装**（production / nginx / env / package /
storage 設計の変更はすべて承認待ち）。実施済みは F（test-only guard）のみ。

調査基準 commit: `a31e974`（main）。

---

## 1. 現状の配信経路（確定事実）

```
ブラウザ → nginx(TLS終端・location / で proxy_pass のみ)
        → Next.js (next start・systemd)
        → /uploads/[...path] route handler（GET のみ）
           1. getApiSession()            … 認証（401）
           2. getUserPermissions()       … 権限ロード
           3. authorizeUploadAccess()    … DB逆引き認可（4 テーブル findMany LIKE contains
                                            + 一致 candidate ごとに property.findUnique）
           4. getStorage().read(key)     … 実体を全量 Buffer で取得（≤8MB）
           5. resolveRegistryServeMeta() … attachment findMany（5本目・全 200 配信で実行）
           6. registry のみ writeAuditLog … AuditLog INSERT（fail-open）
        → Response 200（全量・ストリーミングなし）
```

- proxy.ts（middleware）は `/uploads` を **二重に除外**（PUBLIC_PATHS + matcher）。
  認証・認可はすべて route handler 内で実施（=配信1件ごとにフルコスト）。
- nginx に `/uploads` 専用 location なし（`/_next/static/` のみ 1y キャッシュ）。
  X-Accel-Redirect / sendfile / proxy_cache は未使用。
- 本番 storage backend は `server`（リモート storage サーバへ HTTP）
  → **配信のたびにリモートへ全量 fetch**（アプリ内キャッシュなし）。
- ヘッダ現状: 非 registry=`Cache-Control: private, max-age=3600`／
  registry=`no-store` + `nosniff` + generic `Content-Disposition`（S1b-4）。
- **ETag / Last-Modified / 304 なし**（adapter は S3 ETag・fs.stat mtime を取得しながら破棄）。
- **Range / Accept-Ranges / 206 なし**（常に 200 全量）。
- storage key は immutable（`Date.now()`/UUID 採番・上書きなし・削除は soft-delete）
  → キャッシュ/ETag 設計に有利な性質。

## 2. 負荷ポイント（重い順の整理）

| # | 負荷 | 内容 |
|---|---|---|
| 1 | ギャラリーの原本直読み | サムネイル生成が一切なく、`<img>` が常に原本（≤8MB）を取得。物件/建物/現地調査の全グリッドが対象 |
| 2 | 1 GET あたりの固定コスト | 認証+権限+LIKE findMany×4+findUnique(一致分)+resolveRegistryServeMeta の計 5〜6 DB ops が**写真1枚ごと**に発生 |
| 3 | registry PDF preview | `no-store` のため iframe (再)表示ごとに全量再取得+フル認可+AuditLog INSERT |
| 4 | 304 がない | max-age=3600 失効後は不変ファイルでも全量再転送+リモート storage 再 fetch |
| 5 | 全量バッファ | streaming なし。同時アクセス時は (同時数×ファイルサイズ) が Node RAM に乗る |
| 6 | eager load | BuildingPhotoTab はタブゲートなしでページ表示と同時に全枚数 GET。field-survey pin サムネは `loading="lazy"` なし+thumbnailUrl null 時は原本 fallback |
| 7 | 一覧の非ページング | photos/attachments の findMany に take なし（N 枚 = N 並列 GET） |

LIKE `contains` 逆引きは fileUrl への substring scan（index 保証なし）で、
テーブル成長に比例して per-request コストが上がる点も中期リスク。

## 3. 認可/PII 分類（現状）

| カテゴリ | 認可 | Cache-Control | 監査 |
|---|---|---|---|
| PropertyPhoto | property:read + field_staff は createdBy/assignedTo scope | private, max-age=3600 | なし |
| BuildingPhoto | property:read のみ（**scope なし**） | 同上 | なし |
| 添付（property） | property:read + scope。registry は加えて registry_pdf:preview/download AND | registry=no-store / 他=private 1h | registry のみ毎 GET |
| 添付（owner） | owner:read のみ（表示レベル非連動） | private, max-age=3600 | なし |
| FieldSurveyPinPhoto | field_survey:read + 自分の pin（他人は read_all/manage） | private, max-age=3600 | なし |

公開（無認証）カテゴリはなし。認可は fail-closed（invalid key/未知 targetType→forbidden）。
※ BuildingPhoto の scope なし・owner 添付の表示レベル非連動は**仕様判断事項**（本タスクでは現状記録のみ）。

## 4. 改善候補と評価

### A. Range request 対応（206/Accept-Ranges）— 保留
- 対象は実質 PDF（≤8MB）のみで動画なし。ブラウザ PDF viewer の部分取得が効くのは
  Accept-Ranges 提示時だが、registry は no-store のため効果は限定的。
- adapter の partial-read（S3 Range param 等）まで入れないと server 側負荷は減らない
  （route 内 slice では全量 fetch は残る）。If-Range/ETag 前提も未整備。
- **判定: production+interface 変更・費用対効果低 → defer**。

### B. Cache-Control 整理 + 条件付き GET（304）— 最有力・要承認
- key が immutable なので **ETag(=key 由来) + If-None-Match → 304** が安全に成立。
  304 時は authz は通す（権限剥奪を反映）が **storage fetch と本文転送をスキップ**
  → 本番（server backend）の「配信ごとリモート全量 fetch」を再訪問時にゼロ化。
- あわせて非 registry の `private, max-age=3600` は維持（immutable 付与は要検討）。
- 変更面: route + StorageReadResult への etag/mtime 追加（3 adapter）＝ **production 変更**。
- **判定: 次 PR の第1候補。ただし PII キャッシュ方針（owner 添付等を no-store に
  するか）の判断が絡むため承認後に着手**。
- 既存テストロック: `uploads-route.test.ts`（private, max-age=3600 / 今回追加の
  registry no-store runtime 検証）と `registry-pdf-enforcement.test.ts` の更新が必要。

### C. サムネイル生成/軽量化 — 要 package 承認（sharp 等）
- thumbnailUrl の配管（DB 列・授権の thumbnailUrl 逆引き※pin のみ・UI fallback）は
  既存。生成系がゼロ。sharp 等の追加 = **package 変更で禁止 → Plan のみ**。
- 軽量な前段（package 不要・production UI 変更のみ・別 PR 候補）:
  - field-survey pin サムネに `loading="lazy"` 付与
  - BuildingPhotoTab のタブゲート化（eager → on-demand）
- **判定: lazy/タブゲートの小 PR → その後 sharp 承認を得て本体**。

### D. nginx / X-Accel-Redirect — 承認事項に分離
- 認可は Node・バイト送出は nginx という定石。`deploy/nginx/*.conf.example` と
  VPS 設定の変更が必要 = **本タスク禁止**。local backend 前提（本番は server backend）
  のため、採用するなら storage 配置の再設計とセット。
- **判定: B/C 実施後も配信負荷が残る場合の選択肢として保留**。

### E. S3/R2 + CDN 署名 URL — 将来案
- env/storage 設定変更が必要。署名 URL は adapter に Phase 2 として明記済みの未実装。
  認可モデルが「都度 DB 逆引き」から「短命 URL 発行時点の認可」へ変わる設計判断を伴う。
- **判定: 将来案として記録のみ**。

### F. test-only guard — ✅ 実施済（本ブランチ）
`src/lib/storage/__tests__/uploads-route.test.ts` に 7 ケース追加（production 不変）:
1. registry preview の **runtime** ヘッダ検証（no-store/nosniff/inline）+ 監査
   `registry_pdf_preview`（従来は source-assertion のみの盲点）
2. registry download（?download=1）= generic filename + `registry_pdf_download`
3. propertyId null 時の audit detail undefined（非 PII 維持）
4. 非 registry は監査なし + nosniff/Content-Disposition なし（現状仕様の固定）
5. **Range ヘッダ無視 = 200 全量**（206/Accept-Ranges/Content-Range なしの現状固定。
   将来 A 実施時はこのロックを意図的に更新）
6. MIME map 外拡張子（.svg）→ application/octet-stream（XSS 安全側の固定）
7. 未デコード `%2e%2e` セグメント = リテラル名扱いで traversal せず 404
   （key-validation の decode 前提の境界ロック）

## 5. 推奨順序

1. **（済）F: test-only guard** — 本ブランチ
2. **B: ETag/304** — 要承認（PII キャッシュ方針と StorageReadResult 拡張）
3. **C 前段: lazy + BuildingPhotoTab タブゲート** — 小 production PR（要承認）
4. C 本体（sharp 承認）→ 必要なら D/E
- 計測（本番 nginx アクセスログ/応答時間）は VPS 操作を伴うため**別承認**。

## 6. 関連する既知事項（本タスク対象外・記録のみ）

- `docs/storage-migration.md:14-17` に「/uploads にアクセス権限チェックなし」という
  **stale 記述**（Phase B authorizeUploadAccess 実装済みのため事実と相違）→ docs 修正候補。
- local backend は `public/uploads` 配下に実体を書くため、`STORAGE_BACKEND=local` 運用
  だと Next の static 配信で認可を迂回し得る（本番は server backend のため非該当・
  dev 限定の注意点）。
- 非 registry PII ファイルのアクセス監査なし／BuildingPhoto scope なし／owner 添付の
  表示レベル非連動は PII/認可の仕様判断（S1b 系の延長で別途）。
- 17-B field-survey EXIF 方針とは独立（本 Plan は配信負荷のみ・EXIF/strip に非接触）。
