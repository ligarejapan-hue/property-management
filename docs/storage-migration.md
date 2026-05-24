# Storage Migration: local → S3 互換 (Phase 2)

このドキュメントは `STORAGE_BACKEND=s3` 切替時の運用手順をまとめたものです。
対象は AWS S3 / Cloudflare R2 / MinIO。adapter 名は `S3Adapter`、env キーは
`STORAGE_S3_*` で共通です。

## 設計の前提（Phase 2）

- 既存 DB の `PropertyPhoto.fileUrl` / `BuildingPhoto.fileUrl` /
  `Attachment.fileUrl` の値（`/uploads/{key}`）は **変更しません**。
- 配信は `GET /uploads/[...path]` proxy route に集約されており、
  backend (Local / Server / S3) によらず同じ URL で同じ bytes を返します。
- signed URL は Phase 2 では実装しません（全リクエストをアプリ proxy 経由）。
- `/uploads/[...path]` には現状アクセス権限チェックがありません（既存仕様）。
  attachment 単位の権限フックは別 PR で対応予定です（Phase 2 同梱しない）。
- photo / attachment 削除時に `storage.delete()` を呼ばない既存バグも別 PR で
  対応予定です（S3/R2 化後は課金対象になるため優先度高）。

## 必須 env

```
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=<bucket-name>
STORAGE_S3_REGION=<region>         # AWS は ap-northeast-1 等、R2 は auto
STORAGE_S3_ACCESS_KEY_ID=<...>
STORAGE_S3_SECRET_ACCESS_KEY=<...>
```

## 任意 env

```
STORAGE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com  # R2 / MinIO 時
STORAGE_S3_FORCE_PATH_STYLE=true                                 # MinIO 等
```

## backend 別の env 例

### AWS S3
```
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=property-management
STORAGE_S3_REGION=ap-northeast-1
STORAGE_S3_ACCESS_KEY_ID=AKIA...
STORAGE_S3_SECRET_ACCESS_KEY=...
# ENDPOINT は未設定
```

### Cloudflare R2
```
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=property-management
STORAGE_S3_REGION=auto
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
```

### MinIO (self-hosted)
```
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=property-management
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY_ID=minioadmin
STORAGE_S3_SECRET_ACCESS_KEY=minioadmin
STORAGE_S3_ENDPOINT=http://minio:9000
STORAGE_S3_FORCE_PATH_STYLE=true
```

## 移行手順（dry-run → apply → cutover）

> 本番ストレージへの書き込みを伴うので、必ず順番どおり、dry-run と
> staging を挟んでから本番 apply してください。

### 1. 事前確認

- bucket を作成済み（CORS / public access は不要、サーバ proxy 経由のため）
- IAM / API トークンの権限: `GetObject` / `PutObject` / `DeleteObject` / `HeadObject`
- `LOCAL_UPLOAD_ROOT` の値（既定は `<repo>/public/uploads`）と中身を確認

### 2. 依存インストール

```
npm install
```

`@aws-sdk/client-s3` が追加されています。

### 3. dry-run（書き込みなし）

```
node scripts/migrate-local-to-s3.mjs
```

- 既存 local ファイルを列挙し、各 key が S3 に存在するか HEAD で確認
- 何件 upload になるか / 何件 skip になるかを表示
- **--apply を付けない限り何も書きません**

### 4. staging で apply

```
node scripts/migrate-local-to-s3.mjs --apply
```

- 既に S3 に存在する key は skip（冪等）
- 失敗があれば最後に集計、exit 2

### 5. cutover（本番への切替）

1. `.env` を `STORAGE_BACKEND=s3` + 上記 env に変更
2. アプリ再起動（VPS の場合 `systemctl restart property-management`）
3. ブラウザで `/uploads/<key>` がそのまま 200 で配信されることを確認
4. 念のため数日 `LOCAL_UPLOAD_ROOT` を残しておく（rollback 余地）

### 6. rollback

異常時は `.env` の `STORAGE_BACKEND=local` に戻して再起動するだけ。
local 側の実体ファイルは触っていないので、そのまま配信に戻ります。

## 注意

- 本 migration script は **DB を一切触りません**。`fileUrl` の値は変えません。
- registry PDF は Phase 2 では storage adapter を経由しないため、移行対象外です。
- 1 ファイル失敗で中断はせず、最後に集計してから非 0 終了します。再実行で残りだけ進みます。
- CI / 自動化での実行は想定していません。手動実行用です。
