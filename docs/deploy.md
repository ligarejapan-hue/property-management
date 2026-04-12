# 本番デプロイガイド

対象: Node.js 18+ / PostgreSQL 15+ / Linux サーバー（または同等の PaaS）

---

## 1. リリース前チェックリスト

### 実行環境

- [ ] Node.js **v18 以上**であること
  ```bash
  node --version   # v18.x 以上
  npm --version    # 9.x 以上
  ```
- [ ] PostgreSQL **15 以上**であること

### コード・ビルド

- [ ] `npm run build` がエラー・警告ゼロで完了すること
- [ ] `npx tsc --noEmit` がエラーゼロで完了すること
- [ ] `npm run lint` が通ること
- [ ] `src/proxy.ts` が最新（`middleware.ts` が残っていないこと）

### セキュリティ

- [ ] `AUTH_SECRET` / `NEXTAUTH_SECRET` が 32 文字以上のランダム文字列であること
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] `DATABASE_URL` が本番 DB を指していること
- [ ] `NEXTAUTH_URL` が本番 HTTPS ドメインになっていること
- [ ] `.env` ファイルが公開リポジトリにコミットされていないこと（`.gitignore` 確認）
- [ ] `NODE_ENV=production` で seed を実行していること（テスト用ユーザー・サンプルデータは作成されない）
- [ ] 初期管理者の初回ログイン後にパスワードを変更済みであること（`mustChangePassword=true` で作成）

### ストレージ

- [ ] `STORAGE_BACKEND=server` に設定済みであること
- [ ] `STORAGE_SERVER_URL` / `STORAGE_SERVER_API_KEY` が設定済みであること
- [ ] ストレージ疎通確認（ステップ 5 の curl 5項目）がすべて期待通りであること

### 調査情報プロバイダ（KSJ）

- [ ] `KSJ_API_URL` が本番 GeoServer エンドポイントを指していること  
  （利用しない場合は設定不要、調査情報 providers=0 のまま動作する）

---

## 2. 本番環境で必要な環境変数

### 必須

| 変数名 | 説明 | 例 |
|--------|------|----|
| `DATABASE_URL` | PostgreSQL 接続文字列 | `postgresql://user:pass@host:5432/dbname` |
| `NEXTAUTH_SECRET` | セッション暗号化キー（32文字以上） | `openssl rand -hex 32` で生成 |
| `NEXTAUTH_URL` | アプリの公開 URL（HTTPS） | `https://your-domain.com` |
| `STORAGE_BACKEND` | ストレージ方式 | `server` |
| `STORAGE_SERVER_URL` | ストレージサーバーの Base URL | `https://files.your-domain.com` |
| `STORAGE_SERVER_API_KEY` | ストレージサーバー認証キー | ランダム文字列 |

### 推奨

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `STORAGE_SERVER_BUCKET` | バケット名 | `property-management` |
| `KSJ_API_URL` | 調査情報取得用 GeoServer WFS エンドポイント | 未設定（機能無効） |

### オプション

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `UNIT_IMPORT_BUILDING_NOT_FOUND` | 区分取込時の棟未存在挙動 | `needs_review` |
| `NTA_ROSENKA_API_URL` | 路線価 API（将来実装） | 未設定 |
| `ROAD_LEDGER_API_URL` | 道路台帳 API（将来実装） | 未設定 |

### 開発専用（本番では設定不要）

| 変数名 | 説明 |
|--------|------|
| `NEXT_PUBLIC_USE_MOCK` | DB 未接続時のモックモード（`true` / 空） |
| `STORAGE_SERVER_URL=http://localhost:4000` | mock-storage-server 用 |

> **注意:** `SESSION_MAX_AGE`・`LOGIN_MAX_ATTEMPTS`・`LOGIN_LOCK_DURATION_MINUTES` は
> `src/lib/auth.ts` にハードコードされており、env では制御されない。
> 変更する場合はソースを直接編集すること。

---

## 3. 本番環境 設定ファイル管理方針

**方針: env はすべてサーバー上で管理し、git にはコミットしない。**

`.env` / `.env.production` はいずれも `.gitignore` で管理外となっている。  
本番環境の env はサーバー上のファイルに直接記述し、リポジトリには含めない。

### シークレット分類

| 変数名 | 分類 | 理由 |
|--------|------|------|
| `DATABASE_URL` | 🔴 シークレット | DB パスワードを含む |
| `NEXTAUTH_SECRET` | 🔴 シークレット | セッション暗号化キー（漏洩でセッション偽造可能） |
| `STORAGE_SERVER_API_KEY` | 🔴 シークレット | ストレージサーバー認証キー |
| `NEXTAUTH_URL` | 🟢 設定値 | 公開ドメイン |
| `STORAGE_BACKEND` | 🟢 設定値 | `server` 固定 |
| `STORAGE_SERVER_URL` | 🟢 設定値 | ストレージの公開エンドポイント |
| `STORAGE_SERVER_BUCKET` | 🟢 設定値 | バケット名 |
| `KSJ_API_URL` | 🟢 設定値 | 内部 GeoServer URL |
| `UNIT_IMPORT_BUILDING_NOT_FOUND` | 🟢 設定値 | 動作設定値 |

> 設定値も秘匿不要ではあるが、git 管理を増やすメリットより  
> **「env はすべてサーバー上」で統一する方が運用ミスが少ない**。

### 推奨管理方法（systemd）

シークレットと設定値を1ファイルにまとめる。  
ファイルは root 所有・権限 600 でサーバーに配置する。

**`/etc/property-management/app.env`**（サーバー上のみ・git 管理外）:
```dotenv
# --- シークレット ---
DATABASE_URL="postgresql://user:STRONG_PASSWORD@localhost:5432/property_management"
NEXTAUTH_SECRET="<openssl rand -hex 32 の出力>"
STORAGE_SERVER_API_KEY="<ランダム文字列>"

# --- 設定値 ---
NODE_ENV=production
NEXTAUTH_URL="https://your-domain.com"
STORAGE_BACKEND=server
STORAGE_SERVER_URL="https://files.your-domain.com"
STORAGE_SERVER_BUCKET=property-management
KSJ_API_URL="http://your-geoserver.internal/geoserver/ksj/ows"
UNIT_IMPORT_BUILDING_NOT_FOUND=needs_review
```

配置手順:
```bash
sudo mkdir -p /etc/property-management
sudo touch /etc/property-management/app.env
sudo chmod 600 /etc/property-management/app.env
sudo chown root:root /etc/property-management/app.env
# エディタで値を入力
sudo vim /etc/property-management/app.env
```

**`/etc/systemd/system/property-management.service`**:
```ini
[Unit]
Description=Property Management App
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/property-management
EnvironmentFile=/etc/property-management/app.env
ExecStart=/usr/bin/node /opt/property-management/node_modules/.bin/next start
# ↑ node のパスは `which node` で確認すること（/usr/local/bin/node の場合もある）
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now property-management
```

### PM2 を使う場合

`ecosystem.config.js`（git 管理外）に全 env を記述する:
```js
module.exports = {
  apps: [{
    name: "property-management",
    script: "node_modules/.bin/next",
    args: "start",
    env_file: "/etc/property-management/app.env",  // ファイル参照
  }]
};
```

> ⚠ `ecosystem.config.js` が存在する場合は `.gitignore` に追加すること。

### NG パターン

| NG | 理由 |
|----|------|
| `.env` や `.env.production` をリポジトリにコミット | 漏洩リスク（`.gitignore` で防止済み） |
| シークレットを `NEXT_PUBLIC_` で始まる変数名に入れる | ブラウザバンドルに露出 |

> **本プロジェクトのシークレット 3 件はいずれも `NEXT_PUBLIC_` プレフィクスを持たないため、  
> クライアントバンドルには含まれない。**

---

## 4. 初回デプロイ手順

### ステップ 0: 実行環境を確認

```bash
node --version   # v18.x 以上であること
npm --version    # 9.x 以上であること
psql --version   # PostgreSQL 15 以上であること
systemctl --version 2>/dev/null | head -1 || pm2 --version | head -1
```

### ステップ 1: app.env を配置

「[3. 本番環境 設定ファイル管理方針](#3-本番環境-設定ファイル管理方針)」の方針に従い、  
**サーバー上の1ファイルに全 env を記述する**。`.env.example` を参考に値を設定すること。

```bash
sudo mkdir -p /etc/property-management
sudo touch /etc/property-management/app.env
sudo chmod 600 /etc/property-management/app.env
sudo chown root:root /etc/property-management/app.env
sudo vim /etc/property-management/app.env
# .env.example を参考に全変数を記入
# AUTH_TRUST_HOST は HTTPS 本番環境では不要（入れないこと）
```

### ステップ 2: リポジトリを取得・依存インストール

```bash
sudo git clone <repository-url> /opt/property-management
cd /opt/property-management
sudo chown -R www-data:www-data /opt/property-management

# 依存インストール
# ⚠ @tailwindcss/postcss・tailwindcss はビルド時に必要なため dependencies に入っている
#   NODE_ENV=production 環境下でも --omit=dev で除外されない（devDependencies ではないため）
sudo -u www-data npm ci --omit=dev

# Prisma クライアント生成（src/generated/prisma/ に出力）
# ⚠ postinstall では自動実行されないため必須
set -a && sudo cat /etc/property-management/app.env | grep DATABASE_URL | source /dev/stdin ; set +a
sudo -E -u www-data npx prisma generate
# 期待: ✓ Generated Prisma Client into ../src/generated/prisma
```

### ステップ 3: DB マイグレーション

```bash
cd /opt/property-management

# app.env を読み込んでからマイグレーション実行
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data npx prisma migrate deploy
# 期待: 2 migrations applied. / No pending migrations.
```

> `prisma migrate deploy` は本番向け（マイグレーション履歴のみ適用）。  
> 開発環境は `prisma migrate dev` を使用。

### ステップ 4: 管理者ユーザーを作成（初回のみ）

本番 seed では **テスト用ユーザー・サンプルデータは作成されない**。  
`NODE_ENV=production` 時の seed 挙動:

| 条件 | 動作 |
|------|------|
| `ADMIN_EMAIL` と `ADMIN_INITIAL_PASSWORD` が両方設定済み | 管理者1名を `mustChangePassword=true` で作成 |
| どちらか未設定 | ユーザー作成スキップ（マスタデータのみ投入） |

#### オプション A: seed で初期管理者を作成（推奨）

```bash
cd /opt/property-management

# ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD を app.env に一時追記
sudo tee -a /etc/property-management/app.env > /dev/null <<'EOF'
ADMIN_EMAIL="admin@your-domain.com"
ADMIN_INITIAL_PASSWORD="<12文字以上の一時パスワード>"
EOF

# seed 実行
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data NODE_ENV=production npx tsx prisma/seed.ts
# 期待:
#   ✓ システム設定 / マスタコード / 権限テンプレート / テンプレート権限エントリ
#   ✓ 管理者ユーザー作成: admin@your-domain.com (mustChangePassword=true)
#   ✅ Seed completed successfully!

# seed 完了後: ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD を app.env から削除（必須）
sudo sed -i '/^ADMIN_EMAIL=/d;/^ADMIN_INITIAL_PASSWORD=/d' /etc/property-management/app.env
sudo grep -E "ADMIN_EMAIL|ADMIN_INITIAL_PASSWORD" /etc/property-management/app.env \
  && echo "NG: 残存あり" || echo "OK: 削除済み"
```

#### オプション B: 直接 INSERT

```bash
# bcrypt ハッシュ生成
node -e "const b=require('bcryptjs'); console.log(b.hashSync('<強固なパスワード>', 12));"
```

```sql
INSERT INTO users (id, email, name, password_hash, role, is_active, must_change_password)
VALUES (
  gen_random_uuid(),
  'admin@your-domain.com',
  '管理者',
  '<上記で生成したハッシュ>',
  'admin',
  true,
  true   -- 初回ログイン時にパスワード変更を強制
);
```

### ステップ 5: ストレージ疎通確認

**サービス起動前に**ストレージサーバーとの疎通を確認する。  
`STORAGE_SERVER_URL` / `STORAGE_SERVER_API_KEY` は実際の値に置き換えること。

```bash
STORAGE_URL="https://files.your-domain.com"
API_KEY="your-api-key"
BUCKET="property-management"

# ① upload (PUT /upload)
echo "test content" > /tmp/storage-test.txt
curl -fs -X PUT "${STORAGE_URL}/upload" \
  -H "Authorization: Bearer ${API_KEY}" \
  -F "file=@/tmp/storage-test.txt;type=text/plain" \
  -F "key=__healthcheck/test.txt" \
  -F "bucket=${BUCKET}" | tee /tmp/storage-result.json
# 期待: {"url":"...","key":"..."}  HTTP 200

# ② getUrl (GET /url)
curl -fs "${STORAGE_URL}/url?key=__healthcheck%2Ftest.txt&bucket=${BUCKET}" \
  -H "Authorization: Bearer ${API_KEY}"
# 期待: {"url":"..."} HTTP 200

# ③ ファイル直接取得（① の url で）
FILE_URL=$(cat /tmp/storage-result.json | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
curl -fs "${FILE_URL}" -o /dev/null -w "file GET: %{http_code}\n"
# 期待: 200

# ④ delete (DELETE /delete)
curl -fs -X DELETE "${STORAGE_URL}/delete" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"__healthcheck/test.txt\",\"bucket\":\"${BUCKET}\"}"
# 期待: {"deleted":true} または HTTP 404（両方 OK）

# ⑤ 不正 API キー → 401
curl -o /dev/null -w "auth check: %{http_code}\n" \
  -X PUT "${STORAGE_URL}/upload" \
  -H "Authorization: Bearer wrong-key" \
  -F "file=@/tmp/storage-test.txt" -F "key=test" -F "bucket=${BUCKET}"
# 期待: 401
```

いずれかが失敗した場合はストレージサーバーのログを確認し、解消してからビルドを進めること。

### ステップ 6: プロダクションビルド

```bash
cd /opt/property-management
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data npm run build
# 期待:
#   ✓ Compiled successfully
#   警告ゼロ
#   ƒ Proxy (Middleware) が表示されること
```

### ステップ 7: systemd サービス起動

```bash
# node のフルパスを確認してからサービスファイルを作成
NODE_BIN=$(which node)
echo "node: ${NODE_BIN}"   # /usr/bin/node または /usr/local/bin/node

sudo tee /etc/systemd/system/property-management.service > /dev/null << EOF
[Unit]
Description=Property Management App
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/property-management
EnvironmentFile=/etc/property-management/app.env
ExecStart=${NODE_BIN} /opt/property-management/node_modules/.bin/next start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable property-management
sudo systemctl start property-management

# 起動確認（3秒待って確認）
sleep 3
sudo systemctl status property-management --no-pager
# 期待: Active: active (running)

sudo journalctl -u property-management -n 10 --no-pager
# 期待: ✓ Ready in Xms
```

> **PM2 の場合（代替）:**
> ```bash
> cd /opt/property-management
> set -a && source /etc/property-management/app.env && set +a
> pm2 start node --name property-management \
>   -- /opt/property-management/node_modules/.bin/next start
> pm2 save && pm2 startup
> ```

### ステップ 8: ストレージ移行（既存 local データがある場合のみ）

```bash
# 既存の public/uploads/ ファイルをサーバーストレージに移行
cd /opt/property-management
set -a && source /etc/property-management/app.env && set +a
npm run storage:migrate
```

> 移行後は app.env の `STORAGE_BACKEND=local` を `server` に変更し、サービスを再起動。
> ```bash
> sudo systemctl restart property-management
> ```

---

## 5. 本番確認項目

デプロイ後に以下を順に確認する。

### 基本動作

- [ ] `https://your-domain.com/login` にアクセスできること
- [ ] admin ユーザーでログインできること
- [ ] `/properties` 物件一覧が表示されること
- [ ] ログアウトが正常に機能すること

### CRUD

- [ ] 物件の新規登録ができること（CSV import または手動）
- [ ] 物件詳細を開けること
- [ ] フィールド編集（PATCH: version 付き）が正常に保存されること
- [ ] 変更ログ（`/api/properties/[id]/change-logs`）に記録されること

### ファイルアップロード

> 前提: ステップ 5 のストレージ疎通確認（curl 5項目）が完了していること

- [ ] 写真アップロードが成功し、`STORAGE_SERVER_URL` のファイルとして保存されること
- [ ] 添付ファイルアップロードが成功すること
- [ ] アップロードした画像が画面上で表示されること（`url` フィールドが到達可能な URL であること）
- [ ] delete 後に画像 URL にアクセスすると 404 になること

### import

- [ ] CSV import（`/import`）でプレビュー・取込ができること
- [ ] 登記PDF import（`/import/registry-pdf`）で parse・取込ができること
  - `realEstateNumber` / `lotNumber` / `landCategory` / `area` が取得できること

### 調査情報（KSJ を設定した場合）

- [ ] 物件に座標（gpsLat / gpsLng）を設定した状態で investigation を実行
- [ ] `providers` に `ksj-zoning: success` が返ること
- [ ] confirm で DB に反映されること（`zoningDistrict` 等のフィールド）

### 管理機能

- [ ] Admin → ユーザー管理で一覧・詳細が表示されること
- [ ] Admin → 権限テンプレートが表示されること
- [ ] Admin → 監査ログが記録・表示されること
- [ ] field_staff アカウントで `/admin` が 403 になること（権限分離）

### セキュリティ

- [ ] 未認証で `/properties` にアクセスすると `/login?callbackUrl=...` にリダイレクトされること
- [ ] `_rawTextPreview` フィールドが API レスポンスに含まれないこと
  ```bash
  curl -X POST https://your-domain.com/api/import/registry-pdf/parse \
    -H "Cookie: <session>" -F "file=@test.pdf" | grep rawTextPreview
  # 出力なしであること
  ```

---

## 6. 既存 VPS への差分適用（アップデート手順）

初回デプロイ済みの VPS にコード変更を反映する場合:

```bash
cd /opt/property-management

# 1. 最新コードを取得
sudo -u www-data git pull origin main

# 2. 依存を再インストール（package-lock.json が更新されている場合）
sudo -u www-data npm ci --omit=dev

# 3. Prisma クライアント再生成（スキーマ変更がある場合）
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data npx prisma generate

# 4. マイグレーション（スキーマ変更がある場合）
sudo -E -u www-data npx prisma migrate deploy

# 5. 再ビルド
sudo -E -u www-data npm run build

# 6. サービス再起動
sudo systemctl restart property-management
sudo systemctl status property-management --no-pager
```

> **注意**: `@tailwindcss/postcss` と `tailwindcss` を `devDependencies` から `dependencies` に移動した
> コミット以降を反映する場合は、必ず `npm ci --omit=dev` を再実行してください。
> 旧バージョンのまま `npm run build` すると `Cannot find module '@tailwindcss/postcss'` が発生します。

---

## 8. ロールバック手順

```bash
cd /opt/property-management
set -a && source /etc/property-management/app.env && set +a

# 1. 旧バージョンに戻す
git checkout <previous-tag>
# ⚠ ロールバック先が @tailwindcss/postcss を devDependencies に置いていたコミット以前の場合は
#   npm ci --omit=dev だと tailwindcss 系がインストールされず build が失敗する。
#   その場合は npm ci（--omit=dev なし）で全パッケージをインストールする。
npm ci --omit=dev
npx prisma generate

# 2. DB マイグレーションを巻き戻す（スキーマ変更があった場合のみ）
npx prisma migrate resolve --rolled-back <migration-name>

# 3. ビルド
npm run build

# 4. サービス再起動
sudo systemctl restart property-management
sudo systemctl status property-management --no-pager
```

> スキーマ変更がない場合はステップ 2 不要。  
> デプロイ前に `pg_dump` でバックアップを取っておくこと。

---

## 9. デプロイ資材テンプレート

リポジトリの `deploy/` にサーバー設定テンプレートを用意している。

| ファイル | 用途 |
|---------|------|
| `deploy/systemd/property-management.service.example` | systemd ユニットファイル雛形 |
| `deploy/nginx/property-management.conf.example` | nginx リバースプロキシ設定雛形 |
| `deploy/env/app.env.example` | 本番 `app.env` 雛形（シークレットなし） |

### systemd

```bash
sudo cp deploy/systemd/property-management.service.example \
         /etc/systemd/system/property-management.service
# ExecStart の node パスを `which node` の結果に書き換える
sudo systemctl daemon-reload && sudo systemctl enable --now property-management
```

### nginx

```bash
sudo cp deploy/nginx/property-management.conf.example \
         /etc/nginx/sites-available/property-management
# <YOUR_DOMAIN> を実際のドメインに置き換える
sudo ln -s /etc/nginx/sites-available/property-management \
           /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### app.env

```bash
sudo cp deploy/env/app.env.example /etc/property-management/app.env
sudo chmod 600 /etc/property-management/app.env
sudo chown root:root /etc/property-management/app.env
# プレースホルダーを実値に書き換える
sudo vim /etc/property-management/app.env
```

---

## 10. 定期メンテナンス

| タスク | 頻度 | コマンド |
|--------|------|---------|
| DB バックアップ | 毎日 | `bash scripts/backup-db.sh` |
| 監査ログ確認 | 週次 | Admin → 監査ログ |
| 権限変更履歴確認 | 月次 | Admin → 権限変更履歴 |
| ストレージ使用量確認 | 月次 | ストレージサーバー管理画面 |
| パッケージ更新 | 月次 | `npm outdated` → `npm update` |

### バックアップ / リストア

```bash
# バックアップ実行（/var/backups/property-management/ に保存、30日保持）
bash scripts/backup-db.sh

# cron 設定（毎日 2:00）
echo "0 2 * * * www-data bash /opt/property-management/scripts/backup-db.sh \
  >> /var/log/pm-backup.log 2>&1" \
  | sudo tee /etc/cron.d/property-management-backup

# リストア（アプリ停止 → リストア → 再起動）
sudo systemctl stop property-management
bash scripts/restore-db.sh /var/backups/property-management/db_<TIMESTAMP>.sql.gz
sudo systemctl start property-management
```
