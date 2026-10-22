# 本番デプロイガイド

対象: Node.js（CI では Node.js 24 で検証） / PostgreSQL 15+ / Linux サーバー（または同等の PaaS）

---

## 1. リリース前チェックリスト

### 実行環境

- [ ] Node.js のバージョンが CI と揃っていること（CI では **Node.js 24** で検証。本番・検証環境は CI の Node 版数に合わせることを推奨。Next.js 16 の正確な最小要件は本ガイドでは断定しない）
  ```bash
  node --version   # CI 検証版数（Node.js 24）に合わせることを推奨。2026-10-21 のセキュリティリリース以降は v24.22.1 以上（§6.2）
  npm --version
  ```
- [ ] PostgreSQL **15 以上**であること
- [ ] 大きいPDFの自動圧縮の部品(OS パッケージ `python3-pikepdf` `python3-pil`)が入っていて、自己診断が通ること(→ [ステップ 0.5](#ステップ-05-大きいpdfの自動圧縮の部品を入れる))
  ```bash
  sudo -u www-data python3 /opt/property-management/scripts/pdf-compress.py --self-test
  # 期待: {"selfTest": "ok", "level": "jpeg85", "pikepdf": "8.7.1"} (pikepdf の版は環境による)
  ```

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

> **本プロジェクトは systemd service `property-management` で運用し、PM2 は使用しない（CLAUDE.md §13）。**
> env は systemd の `EnvironmentFile`（`/etc/property-management/app.env`）から読み込む。

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
node --version   # CI 検証版数（Node.js 24）に合わせることを推奨
npm --version
psql --version   # PostgreSQL 15 以上であること
systemctl --version | head -1
```

### ステップ 0.5: 大きいPDFの自動圧縮の部品を入れる

物件の添付(謄本以外)と貼り付けて物件化の PDF は、8MB を超えると `scripts/pdf-compress.py` で
自動で縮めて保存する(2026-10-10)。この部品は npm ではなく **OS のパッケージ**なので、npm の依存インストールでは入らない。
入っていないと 8MB を超える PDF はすべて「大きなPDFを圧縮できませんでした」で断られる(アプリは動く)。

```bash
sudo apt-get install -y python3-pikepdf python3-pil
# 部品が読み込めること(スクリプトはまだ無いので、ここでは読み込みだけ)
sudo -u www-data python3 -c "import pikepdf, PIL; print(pikepdf.__version__)"
```

⚠実際に縮めてみる自己診断は、リポジトリを取得した**後**(ステップ 2 の最後)で行う。

- Ubuntu 24.04 の `python3-pikepdf` は 8.7.1(MPL-2.0)。AGPL の MuPDF は使わない
- 使う Python を変えるときは app.env に `PDF_COMPRESS_PYTHON=/path/to/python3`(既定 `python3`)
- 一時ファイルは systemd の `PrivateTmp` の /tmp に作り、毎回消す
- ⚠**nginx でアプリ全体を出す構成**では、`deploy/nginx/property-management.conf.example` の
  「大きいPDFを受け取る4つの口」の location(上限 52MB・待ち 300 秒)も入れること。全体の上限 12MB・
  待ち 60 秒のままだと、大きい PDF が手前で断られるか、圧縮の順番待ちの途中で 504 になる。
  社内の画面・API を Tailscale の入口から出し、nginx では公開の道だけを出す構成(本番 2026-10)では不要

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

> 本ガイドで `www-data` として `npm` / `npx` を実行する際は、`HOME=/var/www` と
> `npm_config_cache=/var/www/.npm` を指定する（npm キャッシュは `/var/www/.npm`）。CLAUDE.md §13。
> 例: `sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm ci --include=dev`
> （DB 接続が必要な `npx prisma` / `npm run build` 等は `-E` を残して `sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm ...` とする）

```bash
sudo git clone <repository-url> /opt/property-management
cd /opt/property-management
sudo chown -R www-data:www-data /opt/property-management

# www-data の npm キャッシュディレクトリを作成（初回のみ・未作成の場合）
sudo mkdir -p /var/www/.npm
sudo chown www-data:www-data /var/www/.npm

# 依存インストール（build に devDependencies が必要。起動前に prune する → ステップ 6）
# ⚠ next build は TypeScript 型チェックを行い、typescript / @types/* や
#   ルートの vitest.config.ts（`import "vitest/config"`）の解決に devDependencies を必要とする。
#   `npm ci --omit=dev`、および NODE_ENV=production 下の素の `npm ci` はいずれも devDependencies を
#   省くため `Cannot find module 'vitest/config'` 等で build が失敗する。
#   → build 時は `npm ci --include=dev`（NODE_ENV=production でも devDependencies を明示的に含める）、
#     build 成功後に `npm prune --omit=dev` で本番依存へ戻す（ステップ 6）。
# ⚠ @tailwindcss/postcss・tailwindcss はビルド時に必要なため dependencies に入っており、prune 後も残る。
sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm ci --include=dev

# 大きいPDFの自動圧縮の自己診断(ステップ 0.5 の部品+取得したスクリプト・www-data で実際に縮める)
sudo -u www-data python3 /opt/property-management/scripts/pdf-compress.py --self-test
# 期待: {"selfTest": "ok", "level": "jpeg85", "pikepdf": "…"} と終了コード 0

# Prisma クライアント生成（src/generated/prisma/ に出力）
# ⚠ postinstall では自動実行されないため必須
set -a && sudo cat /etc/property-management/app.env | grep DATABASE_URL | source /dev/stdin ; set +a
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx prisma generate
# 期待: ✓ Generated Prisma Client into ../src/generated/prisma
```

### ステップ 3: DB マイグレーション

```bash
cd /opt/property-management

# app.env を読み込んでからマイグレーション実行
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx prisma migrate deploy
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
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm NODE_ENV=production npx tsx prisma/seed.ts
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
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm run build
# 期待:
#   ✓ Compiled successfully
#   警告ゼロ
#   ƒ Proxy (Middleware) が表示されること

# build 成功後: devDependencies を落として本番依存へ戻す
# next / @prisma/client は dependencies のため prune 後も残る（起動に必要なものは消えない）
sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm prune --omit=dev
# 確認: next / @prisma/client が残っていること
sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm ls next @prisma/client --omit=dev --depth=0
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

# 2. 依存を再インストール（build に devDependencies が必要。NODE_ENV=production でも明示的に含める）
# www-data の npm キャッシュディレクトリを作成（未作成の場合）
sudo mkdir -p /var/www/.npm
sudo chown www-data:www-data /var/www/.npm
sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm ci --include=dev

# 3. Prisma クライアント再生成（スキーマ変更がある場合）
set -a && source /etc/property-management/app.env && set +a
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx prisma generate

# 4. マイグレーション（スキーマ変更がある場合）
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx prisma migrate deploy

# 5. 再ビルド
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm run build

# 6. devDependencies を落として本番依存へ戻す（next / @prisma/client は dependencies のため残る）
sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npm prune --omit=dev

# 7. 大きいPDFの自動圧縮の部品(OS パッケージ・npm では入らない)と自己診断
#    ⚠この機能を含む版へ初めて上げるときは必須(入っていないと 8MB 超の PDF がすべて断られる)。
#    入っていれば apt は何もしない。自己診断は毎回流してよい(数秒)。
#    nginx でアプリ全体を出す構成なら、nginx の見本の「大きいPDFを受け取る4つの口」も反映する(ステップ 0.5 の注)。
sudo apt-get install -y python3-pikepdf python3-pil
sudo -u www-data python3 /opt/property-management/scripts/pdf-compress.py --self-test
# 期待: {"selfTest": "ok", "level": "jpeg85", "pikepdf": "…"} と終了コード 0

# 8. サービス再起動
sudo systemctl restart property-management
sudo systemctl status property-management --no-pager
```

> **注意（build と devDependencies）**: `next build` は TypeScript 型チェックを行い、`typescript` / `@types/*`
> やルートの `vitest.config.ts`（`import "vitest/config"`）の解決に **devDependencies を必要とする**。
> このため build 時は **`npm ci --include=dev`** で入れる。`app.env` を source 済みの環境では
> `NODE_ENV=production` により素の `npm ci`／`npm ci --omit=dev` が devDependencies を省くため、
> **必ず `--include=dev` を付ける**こと。**build 成功後に `npm prune --omit=dev`** で本番依存へ戻す。
> `next` / `@prisma/client` は `dependencies` のため prune 後も残る。
> （`@tailwindcss/postcss` / `tailwindcss` も build 時必須だが `dependencies` 側にあるため prune の影響を受けない。）

### 6.1 GitHub Actions からの反映（`.github/workflows/deploy.yml`）

§6 の手順を 1 本のスクリプト（`deploy/vps/pm-deploy.sh`）にまとめ、GitHub Actions の手動起動から実行できるようにしたもの。§6 を手で流す方法もそのまま使える。

**しくみ**

```
起動（Actions の画面 or Claude Code が REST API で起動）
  → main の最新 commit の CI（ci / db-integration）が成功しているか確認（未成功なら中止）
  → GitHub の実行環境が一時的に Tailscale に参加（tag:ci）
  → tailnet 経由で VPS の反映専用ユーザー deploy に SSH
  → 強制コマンド pm-deploy-ssh が引数を検査し、sudo で pm-deploy だけを実行
  → git fetch → fast-forward → npm ci --include=dev → prisma generate →（migration 確認 or 実行）→ build → prune → 再起動 → 応答確認（`/api/health` が 200）
```

- **起動してよいのはユーザーが本番反映を明示指示したときだけ**（CLAUDE.md §13）。push・PR では動かない。
- SSH をインターネットに開けない（Tailscale 内だけで接続）。
- deploy ユーザーは `pm-deploy` 以外を実行できない（authorized_keys の `command=` と sudoers で二重に制限）。
- migration は既定で流さない。未適用の migration があると、build と再起動の前に止まる（`migrate` を有効にして起動し直す）。
- **リポジトリが公開のため Actions のログは誰でも読める。** ログには工程名と結果だけを出し、各コマンドの出力は VPS の `/var/log/pm-deploy/<日時>.log`（root のみ）に残す。失敗時はそのファイルを見る。
- 失敗時はサービスを再起動しない。ただし build 後（再起動・応答確認）で失敗した場合は、§6・§8 を見て手で確認する。

#### 一回だけの準備

**A. Tailscale（管理画面）**

1. Access controls（ポリシー）に、CI 用のタグと、CI から VPS の SSH への接続許可を足す。`<VPS のタグ or ホスト>` は今の VPS の指定に合わせる。
   ```jsonc
   "tagOwners": {
     "tag:ci": ["autogroup:admin"]
   },
   "grants": [
     { "src": ["tag:ci"], "dst": ["<VPS のタグ or ホスト>"], "ip": ["tcp:22"] }
   ]
   ```
   （ポリシーが `acls` 形式なら `{ "action": "accept", "src": ["tag:ci"], "dst": ["<VPS のタグ or ホスト>:22"] }`）
2. Settings → OAuth clients（Trust credentials）で OAuth クライアントを作る。権限は **Keys → Auth Keys（write）** と **Devices → Core（write）**、どちらもタグは **tag:ci**（Auth Keys が無いと参加用の鍵を作れず、Actions のログに `404 not found` が出る）。OAuth クライアントは後から権限を変えられないので、足りなければ作り直して secrets を差し替え、古い方を Revoke する。表示される Client ID と Secret を控える（Secret は一度しか表示されない）。

**B. VPS**

```bash
# 反映専用ユーザー（ログインシェルあり・パスワードなし）
sudo adduser --disabled-password --gecos "" deploy

# スクリプトを root 所有で置く（リポジトリ内のファイルは直接 sudo で実行しない）
sudo install -o root -g root -m 755 /opt/property-management/deploy/vps/pm-deploy.sh     /usr/local/sbin/pm-deploy
sudo install -o root -g root -m 755 /opt/property-management/deploy/vps/pm-deploy-ssh.sh /usr/local/sbin/pm-deploy-ssh

# sudo で許すのは pm-deploy だけ
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/pm-deploy' | sudo tee /etc/sudoers.d/pm-deploy
sudo chmod 440 /etc/sudoers.d/pm-deploy
sudo visudo -cf /etc/sudoers.d/pm-deploy   # 期待: parsed OK

# 反映専用の鍵を作る（VPS 上で作り、秘密鍵は GitHub の Secret に入れたら消す）
sudo -u deploy ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f /home/deploy/deploy_key
sudo -u deploy install -m 700 -d /home/deploy/.ssh
echo "command=\"/usr/local/sbin/pm-deploy-ssh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(sudo cat /home/deploy/deploy_key.pub)" \
  | sudo -u deploy tee /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys

# GitHub の Secret に入れる値を表示（このあと C で登録）
sudo cat /home/deploy/deploy_key                                   # → DEPLOY_SSH_KEY
ssh-keyscan -t ed25519 <VPS の Tailscale IP（100.x.y.z）> 2>/dev/null   # → DEPLOY_KNOWN_HOSTS

# 登録が済んだら秘密鍵を VPS から消す
sudo rm /home/deploy/deploy_key /home/deploy/deploy_key.pub
```

- sshd で `AllowUsers` / `AllowGroups` を使っている場合は deploy を足して `sudo systemctl reload ssh`。
- 動作確認（VPS 上で）: `sudo -u deploy sudo -n /usr/local/sbin/pm-deploy --status` → `version: <hash>` と `service: active`。

**C. GitHub（Settings → Environments）**

1. Environment `production` を作る（保護ルールは付けない。付けると承認待ちで止まり、Claude Code から起動できない）。
2. `production` の Environment secrets に 5 つ登録する:

| 名前 | 値 |
|------|-----|
| `TS_OAUTH_CLIENT_ID` | A-2 の Client ID |
| `TS_OAUTH_SECRET` | A-2 の Secret |
| `DEPLOY_HOST` | VPS の Tailscale IP（`100.x.y.z`。管理画面の Machines で確認。Actions の実行環境では `….ts.net` の名前が引けず `Could not resolve hostname` になるため IP を使う） |
| `DEPLOY_SSH_KEY` | B の秘密鍵（`-----BEGIN OPENSSH PRIVATE KEY-----` から末尾まで） |
| `DEPLOY_KNOWN_HOSTS` | B の `ssh-keyscan` の出力 1 行（先頭が `DEPLOY_HOST` と同じ IP であること） |

#### 反映のしかた

- 画面から: Actions → **Deploy (production)** → Run workflow（branch は `main`）→ confirm に `deploy`、migration があるときだけ `migrate` にチェック → Run。
- Claude Code から（ユーザーの明示指示があるときだけ）:
  ```bash
  gh api repos/ligarejapan-hue/property-management/actions/workflows/deploy.yml/dispatches \
    -X POST -f ref=main -f 'inputs[confirm]=deploy' -F 'inputs[migrate]=false'
  ```
  起動後は実行結果（各工程の OK/NG・反映前後の版・HTTP 応答）を確認して報告する。

#### スクリプトを変えたとき

`deploy/vps/` を変えた PR を反映したら、B の `install` 2 行を流し直して `/usr/local/sbin/` を置き直す（置き直すまでは古いスクリプトで動く）。

### 6.2 Node.js 本体のセキュリティ更新（VPS）

npm の依存とは別に、VPS に入っている Node.js 本体も更新が要る。反映（pm-deploy）では更新されない。

- 2026-10-21 の Node.js セキュリティリリース（Brotli の境界外書き込み CVE-2026-111497、TLS のホスト名確認の抜け CVE-2026-105483 / 106069 / 106072、`dns.resolve` の NUL 切り詰め CVE-2026-105482 ほか計10件）の修正版は **v24.22.1 / v22.23.4 / v26.12.1**。この系統（24.x）では **v24.22.1 以上**にする。
- 確認: `node --version`（`/usr/bin/node` か `which node` の先を見る）
- NodeSource（apt）で入れている場合:
  ```bash
  sudo apt-get update
  sudo apt-get install -y nodejs   # 24.x の最新パッチに上がる
  node --version                   # v24.22.1 以上になったか
  sudo systemctl restart property-management
  ```
  （nvm で入れている場合は `nvm install 24 && nvm alias default 24` のあと、systemd の ExecStart のパスを新しい版に直して `daemon-reload` → restart）
- 補助のタイマー（pm-push-notify / pm-trip-auto-end / pm-agent-registry）も同じ node を使うので、上の更新で一緒に新しくなる。
- 再起動後は `/api/health` が 200 を返すことを確かめる。

### リリース同梱の一回限り作業（one-shot）

#### 売却DM 外部AI方式リリース（PR-D2）: 型の凍結印の照合

送付実績のある型（variant）の文面を後から差し替えられないようにするため、`dm_variants.template_frozen_at`
に印を入れる。**この照合を流さないと**、既に確定/送付済みの宛先を持つ型でも、割当で宛先が別の型へ
移った後に「確定の証拠」が消え、文面を差し替えられてしまう（送付済み文面の出所が失われる）。

⚠**migration では埋めていない**。`migrate deploy → restart` の窓では凍結を知らない旧ルート
（型の設定 PATCH / DELETE）がまだ動いており、印を先に立てると**凍結済みの型を書き換え・削除**
できてしまい、照合では復元できない。**新コードが動き始めた後（再起動のステップの後）に1回**流す。

```bash
# root で app.env を source して DATABASE_URL を通し、www-data で実行（devDeps の tsx が要る＝prune 前）
npx tsx scripts/reconcile-sale-dm-template-freeze.ts           # dry-run（件数だけ）
npx tsx scripts/reconcile-sale-dm-template-freeze.ts --apply   # 実書込
```

冪等（印がまだ無い型だけを拾う）なので、何度流しても結果は変わらない。
⚠**このリリース自体に migration は無い**（列は PR-D1 で追加済み）。

⚠**実行の順番（重要・@codex #376）**: このスクリプトは `tsx`（devDependencies）で動く。
通常手順どおり先に `npm prune --omit=dev` してしまうと **`tsx` が消えて実行できない**。
このリリースでは、**依存の後片付け（prune）を最後へ回す**:

1. `npm ci --include=dev`
2. build
3. restart
4. 照合（下のコマンド）
5. 依存の後片付け（prune）

反響の照合（PR-B）と同じ並びで、実績のある手順。

その数分間は売却DMの操作をしないこと（旧ルートと新ルートが混ざる窓を作らない）。

#### 売却DM LP型の土台(2026-09): migration

`20260909000000_add_dm_lp_variants` は additive のみ(表 `dm_lp_variants` 新設・`dm_recipient_drafts.lp_variant_id` 追加・FK は SET NULL)。バックフィル無し。既存キャンペーンは LP型0件=従来どおり(割当・集計・QR転送の結果は変わらない)。rollback は列と表の DROP で戻せる(enum の追加なし)。

#### 売却DM LP型「写真と図」(2026-09): migration

`20260910100000_add_dm_lp_assets` は additive のみ(表 `dm_lp_assets` 新設=写真ライブラリ、`dm_lp_variant_media` 新設=LP型の枠)。バックフィル無し。FK は `dm_lp_variant_media.asset_id → dm_lp_assets.id` が `ON DELETE RESTRICT`(使用中の写真は消せない=アプリ側でも先に枠から外させる)、`dm_lp_variant_media.lp_variant_id → dm_lp_variants.id` が `ON DELETE CASCADE`(LP型を消せば枠も一緒に消える)。rollback は2表の DROP で戻せる(enum の追加なし)。

公開口 `/lp-assets/<publicId>` は認証なし(`src/proxy.ts` の `PUBLIC_PATHS` に追加済み)。`publicId` は32桁の乱数で、いずれかのLP型が参照している写真だけを返す(ライブラリに入れただけ・削除済みは404)。レート制限は300/分。`Cache-Control: immutable` で1年キャッシュするため、**削除しても配布済みのキャッシュ（閲覧者のブラウザやCDN）にはしばらく残る**運用上の注意がある(差し替えは新しい `publicId` で行う設計)。⚠**nginx のアクセスログ除外は `/lp-assets/` にも必須**(`publicId` 自体は乱数でPIIではなく、公開ページの `Referrer-Policy: strict-origin`(オリジンのみ・パスは送らない)により `/lp-assets/<publicId>` へのリクエストの `Referer` に `/t/<token>` が載ることは無いが、多層防御としてアクセスログ除外は維持する。詳細と設定箇所は下の「売却DM LP型「公開LP」」節を参照)。

`STORAGE_BACKEND=server` の環境では `lp-assets/` 配下にファイルが増える(uploads と同じストレージ層を共用)。写真は**端末側で例外なく canvas 再エンコード**して長辺1600pxのJPEGにしてから送る(`src/lib/lp-asset-prepare.ts`。JPEGを含め無変換で送る道は無い=向きを画素に焼き込むため)ので、この機能で新規に追加したサーバー側の依存パッケージは無い。

公開配信する画像なので、**付随情報(メタデータ)はサーバー側で許可リスト方式により全て除去する**(`src/lib/lp-asset-metadata-strip.ts`)。メタデータのセグメント/チャンクは許可リスト方式で全て除去する(JPEG は SOI/DQT/DHT/DAC/DRI/DNL/SOFn/SOS〜EOI のみ、PNG は IHDR/PLTE/IDAT/IEND と固定長の色情報チャンク(gAMA/cHRM/sRGB/pHYs)のみ、WebP は VP8/VP8L/VP8X/ALPH のみ・アニメーションは拒否)。残るのは画素データそのもの(IDAT/エントロピー符号/VP8 ビットストリーム)だけで、そこに任意のバイトを載せることは形式上防げない(画像として表示される内容と同じ)。したがって JPEG の APPn(JFIF APP0・Exif APP1・IPTC APP13 等)と COM、PNG の tEXt/zTXt/iTXt/tIME/eXIf/iCCP と未知チャンク、WebP の EXIF/XMP /ICCP と未知チャンクは全て落ちる(VP8X の ICC/EXIF/XMP フラグも消し、RIFF サイズを数え直す)。⚠**PNG の `sBIT`/`bKGD`/`hIST`/`tRNS` は残さない**(@codex P2): これらは colour type ごとに厳密な固定長を持つため範囲チェックだけでは余りバイトを隠せてしまう。direct API 経由の PNG は透過情報を失うが、UI 経路は必ず JPEG に再エンコードされる(透過を持たない)ため実害はない。⚠**残す器の中身も検査する**: 固定長の PNG チャンク(IHDR=13/gAMA=4/cHRM=32/sRGB=1/pHYs=9)と PLTE(3の倍数かつ 3〜768=1〜256エントリ・0は malformed・colour type 0/4 には現れてはならない)、JPEG の SOFn/DQT/DHT/DAC/DRI/DNL/SOS の内部構造をぴったり使い切るかまで確かめ、余りバイトが出るものは 422 にする(許可した器の余白に情報を隠されないため)。⚠**アニメーション WebP(ANIM/ANMF チャンク・VP8X の Anim フラグ)は受け付けない**(ANMF は入れ子のサブチャンクを持てるため抜け道になる。画面側は静止JPEGしか作らないので実害なし)。⚠この段で **Exif の向き(Orientation)も落ちる**(画面側が全ての画像を canvas で再エンコードし向きを画素に焼き込んでから送るため保持しない)。⚠**器の形だけでなく構造の完全性(実データの有無)も検査する**(@codex P2): PNG は IDAT(合計 payload 長 > 0)が最低1つ必須・colour type=3(インデックス)なら最初の IDAT より前の PLTE が必須・IHDR の値域(幅高さ>0/bit depth/colour type/compression/filter/interlace)を検査・**残す chunk 全ての CRC32 を検算**し合わなければ 422、JPEG は DQT 最低1つ・DHT/DAC 最低1つ・最初の SOS の前の SOFn(幅高さ>0)・SOS〜EOI の entropy-coded data が1byte以上を必須にし、WebP は VP8/VP8L のどちらか1つ(key-frame start code / signature byte 込み)を必須にする。構造が読み切れない画像は保存せず 422 にする(fail-closed)。

前回反映分の本文に上限超えの小見出しがあっても写真の保存はできる(照合は本文との一致で行う)。バックフィルは不要。

#### 売却DM LP型「公開LP」(2026-09): migration

`20260911100000_add_dm_phone_tap` は additive のみ(`dm_recipient_drafts` に `phone_tap_count`(既定0)・`phone_tap_first_at`(nullable)を追加)。バックフィル無し。rollback は2列の DROP で戻せる(enum の追加なし)。

`20260912100000_add_dm_lp_page_view` も additive のみ(`dm_recipient_drafts` に `lp_page_first_at`(nullable)・`lp_page_view_count`(既定0)を追加)。バックフィル無し。rollback は2列の DROP で戻せる(enum の追加なし)。

**⚠「閲覧」は2種類あり、表によって使い分ける(@codex R10)**: `lp_first_access_at` は**QRを読み取られた**時刻で、飛び先がアプリ内ページでも外部LPでも立つ(計数 `recordTrackingHit` はページを出すかどうかの判定より前に走るため)。`lp_page_first_at` は**アプリ内のご案内ページを実際に返せた**時刻で、公開スイッチ未投入・LP型に文章なし・読み出し失敗のときは立たない。**DM型ごとの表(文面の成績)は前者**、**LP型ごと/組み合わせの表(ページの成績)と電話タップ率の分母は後者**を使う。前者だけで LP型を比べると、全員が同じ外部LPへ飛んでいる期間の訪問が「LP型別のページ成績」として出てしまう。

**⚠LP型ごと/組み合わせの集計は公開スイッチと同じ `SALE_DM_LP_PUBLIC_ENABLED` で出し分ける**: 未投入のうちは集計API が `byLpVariant`/`byPair` を返さず(応答の `lpMetricsEnabled: false`)、画面も表を出さない(「次の段階から表示します」の注記のみ)。画面(ブラウザ側)は env を読めないため、判定はサーバーで行い応答の `lpMetricsEnabled` を画面が見る。`DM型ごと`の閲覧率と反響の表はスイッチに関係なく従来どおり出る。

`/t/<token>` は今回から HTML を返す**経路を持つ**ようになる(公開ロールアウトゲート `SALE_DM_LP_PUBLIC_ENABLED` が有効かつ宛先に付いたLP型に文章が保存されていればアプリ内のご案内ページ、それ以外(ゲート無効・LP型なし)は従来どおり302で外部LPへ転送。未知tokenは従来どおり302(有効なtokenはゲート有効時のみページが出るため応答は当然異なる。tokenは11桁の base64url・60/分の制限))。レスポンスヘッダは `Cache-Control: no-store`・`X-Robots-Tag: noindex`・CSP `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`(外部読み込みなし・インラインCSSとscript1本のみ。`connect-src 'self'` は電話タップの送信が自分自身宛のときだけ通るようにするもので、これが無いと送信ごと遮断される)。電話ボタンのタップは `POST /t/<token>/phone-tap` で受け(常に204を返す=宛先の存在有無を漏らさない・レート制限60/分)、送付済み(`sent`)の宛先のときだけ `phone_tap_count`/`phone_tap_first_at` を更新する(反響としては数えない=反響は引き続き手入力)。社内プレビュー(LP型編集画面のプレビュー)はこのゲートの対象外で常に見える。

公開経路の設定読み出しは新設の `loadSaleDmPublicPageConfig`(会社案内・電話番号・公開ゲートの有無など表示判定に要る列/envだけを読み、謄本取得等の課金用APIキー列には触れない)。**⚠nginx のアクセスログ除外は `/u/` だけでなく `/t/` と `/lp-assets/` にも必須**(@codex PR#434 P1是正: 以前の版はここで `/t/` をアクセスログ除外の対象外としていたが誤りだった)。`/t/<token>` は査定申込フォーム(`POST /t/<token>/inquiry`)を送信できる権限そのものであり、URL を読めた者はトークンを再生して申込を送信できてしまう(`/t/` のアクセスログ除外はこれだけで必須=リクエスト行そのものに token が載る)。公開ページの `Referrer-Policy` は `strict-origin`(Referer はオリジンのみ・パスは送らない)に変更済みで、同一オリジンの自動サブリクエスト(favicon・`/lp-assets/<publicId>` の画像読み込みなど)が `Referer` に `/t/<token>` を載せて運ぶことは無くなった(@codex R10 是正)。それでも **`/lp-assets/` のアクセスログ除外は多層防御として維持する**(`publicId` 自体はPIIではないが、nginx の版差やログ形式の変更・将来のブラウザ挙動の変化など単一の仕組みに守りを委ねない)。したがって **`/t/` を中継する nginx の server ブロック全て**(公開ホスト `app.ligarejapan.com` の vhost・`deploy/nginx/property-management.conf.example` を元にした既定の `property-management` server・今後 `/t/` を中継する他の vhost を含む)で、`location ^~ /t/` と `location ^~ /lp-assets/` の両方に `/u/` と同じ `access_log off;` と `error_log /dev/null crit;` を設定すること(`deploy/nginx/property-management.conf.example` は反映済み・本番の `/etc/nginx/sites-available/app.ligarejapan.com` にも同じ location を足すこと)。

**広告用の公開ページ(`/lp/<公開名>`・設計 `docs/superpowers/specs/2026-10-20-lp-public-page-design.md`)**: DMの種類ごとに管理者が付けた公開名で開く、宛先を持たないご案内ページ(`GET /lp/<公開名>`)と、その申込の受け口(`POST /lp/<公開名>/inquiry`)。`src/proxy.ts` の `PUBLIC_PATHS` に `"/lp/"` を追加済み。**公開ホストの nginx(`/etc/nginx/sites-available/app.ligarejapan.com`)に `location ^~ /lp/` を足すこと**(`deploy/nginx/property-management.conf.example` の同名ブロックをそのまま写す。URL に資格情報は載らないが、query の `utm_*`/`gclid` は訪問者が自由に書ける文字列で既定のログ形式は query まで記録するため、`/t/` と同じく `access_log off;` と `error_log /dev/null crit;` を付ける=@codex #535 P2)。反映は `nginx -t` → `systemctl reload nginx` → `curl -s -o /dev/null -w '%{http_code}' https://app.ligarejapan.com/lp/<公開名>` が 200(公開名未設定なら 404)で確認する。公開ゲートは `/t/` と同じ `SALE_DM_LP_PUBLIC_ENABLED`。Google のタグ(gtag.js)はこのページだけ、LPの設定の「Googleタグ ID」が入っているときだけ読み込む(CSP の `script-src`/`connect-src`/`img-src`/`frame-src` を Google の配信元に限って広げる・DM 用の `/t/` は今までどおり外部読み込みなし)。

反映後の確認: `grep -c " /t/" /var/log/nginx/<vhost名>.access.log` を reload の前後で実行し、reload 後にカウントが増え続けていないことを確認する(増え続けていれば location の適用漏れ)。⚠**既存ログの点検も必要**: 本番は2026-09-16に点検済みで、ローテーション済みの古いログに実在のトークンが1行だけ記録されていたが、その時点までそのトークン宛の手紙は未送付(`status` が `sent` でない)だったため申込は記録され得ない状態だった(実害なし)。新たに `/t/` を公開ホストへ足す環境では反映前に同様の点検を行うこと。

監査ログの action は2つ追加(社内プレビュー表示=`sale_dm_lp_preview_view`・電話タップ=`sale_dm_lp_phone_tap`)。公開LP表示は既存の `sale_dm_tracking_hit` をそのまま使う(この action は allowlist に載っていなかったので補完した=漏れの是正)。

**⚠公開ロールアウトゲート`SALE_DM_LP_PUBLIC_ENABLED`が無いと、本番反映と同時に既存の印刷済みQRがそのまま公開LPになる**: 公開LPのホストは `app.ligarejapan.com`(nginx の server ブロックで `/t/` `/u/` `/lp-assets/` だけを公開し、それ以外は 404。443 は公開アドレス限定で listen=tailscaled が 443 を保持しているため)で、このアプリに届く経路が既にあるため、このゲートが無ければ反映した瞬間に「送付済み・LP型に文章あり」の宛先へ以前印刷済みの `/t/<token>` が(HTTPS 切替前の平文HTTPのままでも)アプリ内ページとして出てしまう。そのためゲートの既定値は無効(未設定)で、下の切替手順の最後で明示的に有効化するまで `/t/` は従来どおり外部LPへ転送し続ける。

**所有者に実際に見せるための切替: 2026-09-16 切替完了(公開ホスト=`app.ligarejapan.com`)**。やり直し・拡張するときの記録(本番で確認済みの事実のみ):

1. DNS: `ligarejapan.com` のネームサーバーを Xserver(`ns1`〜`ns5.xserver.jp`)から お名前.com(`01`〜`04.dnsv.jp`)へ移した(ドメインは発注者のお名前.com アカウントで登録されており、Xserver の DNS は発注者が編集できないため)。移す前に既存レコードを全てお名前.com のゾーン取込で写し、Xserver の応答と照合済み(apex A `183.181.89.111`・ワイルドカード `*` A `183.181.89.111`・MX `0 ligarejapan.com`・SPF TXT・`lp` A と `www.lp` A `103.169.142.0`・`lp` TXT `canva-domain-verify`=Canva サイト)。会社サイト・メール・Canva は止まっていない。
2. 公開LPのホスト: お名前.com に A レコード `app` → `133.117.72.225` を追加。
3. 証明書: `certbot --nginx -d app.ligarejapan.com`(Let's Encrypt・自動更新。期限の通知は info@ligarejapan.com)。
4. nginx: `/etc/nginx/sites-available/app.ligarejapan.com`(有効化済み)。`/t/` `/u/` `/lp-assets/` だけを `proxy_set_header Host $host;` 付きで中継し、それ以外は 404(ログイン画面・社内API はこのホストに出さない)。**公開の口を新しく足したら、ここにも location を足す**。
5. 設定: `sale_dm_config.tracking_base_url` = `https://app.ligarejapan.com`、予備の `lp_url` = `https://ligarejapan.com/`(会社ホームページ=アプリ内LPの文章が無い手紙はここへ転送)。
6. `SALE_DM_LP_PUBLIC_ENABLED=1` を `/etc/property-management/app.env` に追加して restart 済み。
7. 切替前に印刷した手紙のQRは古いURLのまま(切替時点の送付済みは0通)。

⚠**nginx の 443 の罠**: certbot は `listen 443 ssl;`(全アドレス)を書くが、このサーバーでは tailscaled が tailnet 側アドレスで 443 を持っているため**黙って bind に失敗する**。`nginx -t` は通り reload も「成功」するのに、nginx は古い設定のまま動き続ける。エラーは `/var/log/nginx/error.log` の `bind() to 0.0.0.0:443 failed (98: Address already in use)` と `ss -tlnp | grep :443` でしか見えない。直し方=公開アドレスだけで listen する: `listen 133.117.72.225:443 ssl;` と `listen [2400:8500:2002:3371:133:117:72:225]:443 ssl;`。**今後ほかのホストで `certbot --nginx` を使うときも同じ修正が要る**。

⚠**`lp.ligarejapan.com` は Canva のサイト(公開中)=触らない**(A/TXT を変えない・このアプリへ向けない)。

外から確かめるとき、DNS のキャッシュが古い間は `curl --resolve app.ligarejapan.com:443:133.117.72.225 https://app.ligarejapan.com/...` を使う(手元のリゾルバが古いワイルドカード `183.181.89.111`=Xserver を返すことがあり、その 404・証明書エラーはアプリではない)。

#### 売却DM 公開LP「査定申込フォーム」(2026-09): migration

`20260916100000_add_dm_inquiries` は additive のみ(表 `dm_inquiries` 新設・`dm_recipient_drafts` に `form_inquiry_count`(既定0)・`form_inquiry_first_at`(nullable)を追加・`sale_dm_config` に `privacy_text`(nullable)を追加)。バックフィル無し。**`dm_inquiries.draft_id → dm_recipient_drafts.id` の外部キーは `ON DELETE RESTRICT`**(申込の個人情報を宛先の削除に巻き込んで消さない=申込がある宛先は削除できない)、`handled_by_id → users.id` は `SET NULL`。rollback は表の DROP と3列の DROP で戻せる(enum の追加なし)。⚠一度でも申込が入ったあとに rollback する場合は、`dm_inquiries` の行(氏名・電話などの個人情報)を先に退避するか消去の判断を取ってから DROP する。

**⚠公開の書き込み口(配信停止 `/u/`・電話タップ `/t/<token>/phone-tap`・査定申込 `/t/<token>/inquiry`)の送信元判定は Host ヘッダ基準**(`src/lib/public-origin.ts`)。nginx は `proxy_set_header Host $host;` を必ず渡す(外すとアプリが自分自身からの送信を「よそ」と判定して拒否する=配信停止ボタン・申込フォームが 403、電話タップが数えられない)。**あわせて公開ホストの vhost の `/t/` `/u/` `/lp-assets/` の location には `proxy_set_header X-Real-IP $remote_addr;` と `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` も必須**: 公開の口の端末IPごとの回数制限はこの2つをキーにする(`src/lib/public-rate-limit.ts` の `clientRateKey`)。無いと全訪問者が同じキー(`unknown`)を共有し、外部の1人が連投するだけで全員の申込フォームが回数制限にかかる。また X-Real-IP を nginx 側で上書きしないと、送信者がヘッダを偽って回数制限をすり抜けられる。(本番の `app.ligarejapan.com` の vhost は両方を設定済み=2026-09-16 確認。)`Origin: null`(Referrer-Policy が厳しいページからのフォーム送信で実ブラウザが付ける)と Origin なしは拒否しない。公開ページの `Referrer-Policy` は `strict-origin`。

申込は `status=sent` の宛先だけ記録する(送付前は 409「プレビュー中」)。レート制限は端末IP 10/分・token 5/時・全体 120/時。申込者への自動返信は無く、担当者へのメール通知は次段(`notify_status` 列は次段のために作成済み・今は `pending` のまま)。

#### 売却DM 申込の通知メール(2026-09): migration・新規依存

`20260918100000_add_mail_config_and_inquiry_notify` は additive のみ(表 `mail_config` 新設[singleton・1行のみ運用]・`users` に `inquiry_notify_enabled`(既定 false)・`inquiry_notify_email`(nullable)を追加・`dm_inquiries` に `notify_claimed_at`(nullable)を追加)。バックフィル無し。rollback は表の DROP と3列の DROP で戻せる(enum の追加なし)。

`20260919100000_add_inquiry_notify_sent_user_ids` も additive のみ(`dm_inquiries` に `notify_sent_user_ids`(`UUID[]` 既定 `'{}'`・NOT NULL)を追加)。レビュー指摘対応(P2): 送信に成功した宛先の user id をこの列へ逐次 push で追記し、手動の「再送」ボタン・サーバー再起動後の再開が同じ宛先へ二重送信しないための唯一の正本にする。バックフィル無し(既存行は空配列のまま=過去分は再送の対象になり得るが個人情報の重複送信ではなく実害はメール1通の再送のみ)。列は user id のみで個人情報を含まず、申込一覧の API/画面には出さない内部メタデータ。rollback は列の DROP で戻せる(enum の追加なし)。

新規の npm 依存 `nodemailer`(`@types/nodemailer` は devDependencies)。
> **注意(新規依存の到達性)**: 依存の取得コマンドが npm レジストリ(`registry.npmjs.org`)に到達できることが、このリリースの hard gate(他リリースの `cdn.sheetjs.com` 到達確認と同様に、反映前に到達を確認すること)。

送信設定(サーバー名・ポート・ユーザー名・パスワード・送信元・アプリのURL)は **DB(`mail_config`)へ保存する方式**で、env ではない。したがって新しい環境変数は無い。パスワードの暗号化には既存の `SALE_DM_SETTINGS_ENC_KEY`(売却DM設定と共用・本番に設定済み)を使うため、鍵の追加設定も不要。

反映後、次の手順で通知メールを有効化する(管理者の作業。**パスワードはこの手順の管理画面にだけ入力し、チャットや資料に書かない**):

1. 管理画面の「メール送信設定」(サイドバー「DM」グループ→`/admin/mail-settings`)を開き、Xserver のメールボックスの値を入力して保存する:
   - 送信サーバー: `sv****.xserver.jp`(Xserver サーバーパネルの「サーバー情報」で確認できる実際のホスト名)
   - ポート: `465`・接続方式: `SSL`
   - ユーザー名: メールボックスのメールアドレス全体(例 `info@ligarejapan.com`)
   - パスワード: そのメールボックスのパスワード(保存後は画面に戻らない=空欄のまま保存すると変更しない)
   - 送信元アドレス: 通知メールの From(通常はユーザー名と同じ)
   - アプリのURL: 通知メールのリンクに使う、社内から開ける https のアドレス(Tailscale の HTTPS アドレス)
   - 通知の詳しさ: 最小(既定)/詳しく
2. 「テスト送信」を押し、操作者自身の通知先にテストメールが届くことを確認する。届かない場合は画面に出るSMTPコード(許可リスト一致の短い符号)とヒントを見る(パスワードの値自体は成功時・失敗時ともに画面へ返らない)。
3. 利用者一覧の各行の「通知」ボタンから、査定申込の通知を受け取る人を個別にONにする(既定は全員OFF=このステップまでは誰にも届かない)。代替の通知先アドレスも設定できる(空欄なら本人のログインメールへ届く)。
4. Xserver のサーバーパネルで SPF と DKIM を有効化する(迷惑メールフォルダ対策。アプリ側の変更は不要)。
5. VPS から Xserver の SMTP ポートへ外向きに接続できることを確認する: `nc -vz sv****.xserver.jp 465`(ブロックされていると「テスト送信」が接続エラーで失敗する)。

通知の送信は申込の記録が終わった後にバックグラウンドで始まり、申込者への応答(フォーム送信の結果表示)を待たせない。送信は宛先ごとに最大4回(即時→30秒後→2分後→10分後)試みる。全員へ送り終えた申込は画面上とくに変化しない(「通知できていません」の帯が出ないことが成功の目印。「送付済み」のような固有の状態ラベルは画面には無い)。1人でも最終的に失敗した申込は「査定の申込」画面(`/properties/sale-dm/inquiries`)に「通知できていません」+「再送」ボタンとして残る(押すと同じ再試行を再度行う)。通知メールの内容・宛先は受信者ごとに変わる: 電話番号・メールアドレス・ご要望まで含む詳しい内容は、その受信者が画面でも所有者の電話・メールを平文で見られる権限を持つときだけ届き、それ以外の受信者には町名までの所在などの最小限だけが載る。**現場担当者(field_staff)は、自分が作成または担当している物件の申込についてのみ通知の対象になる。担当外の物件については、最小限の内容であっても通知が届かない(宛先の一覧に入らない)**。通知先が1人も設定されていない間は、申込のたびに失敗として記録され「査定の申込」画面に注意書きが出る(上記ステップ3で解消する)。

#### 反響の記録リリース（migration `add_dm_reaction_columns`）: 旧 sale_dm 送付記録の照合

この migration は既存の送付記録を全件「反応なし（no_response）」で初期化する。過去の売却DMで
返戻・LP反響が既に付いている宛先へ反響を反映するため、**このリリースの反映時に1回だけ**
照合スクリプトを実行する（冪等＝何度実行しても安全）。実行しないと、過去に返戻・返信のあった
宛先が反響なし扱いのまま DM 出力の除外対象にならない。

実行タイミング: **サービス再起動（ステップ7）で新コードが動き始めた後**。
旧プロセスが動いている間に照合を先に実行すると、照合〜再起動のあいだに旧コード
（送付記録への同期を持たない）が受けた LP アクセス・返戻の記録が draft にだけ残り、
送付記録側が「反応なし」のまま恒久的に取り残される（新コードなら以後のイベントが同期する）。

このリリースでは手順の順序を入れ替える: **ステップ5 build → ステップ7 再起動（新コードの
稼働確認）→ サービス一時停止 → スナップショット → 照合（dry-run→apply）→ サービス再開 →
ステップ6 `npm prune`**。`tsx` は devDependencies のため prune を照合の後に回す
（既に prune 済みなら `npm ci --include=dev` で入れ直してから実行し、
終わったら再度 `npm prune --omit=dev`）。

⚠**スナップショット〜apply の間はサービスを停止して書き込みを静止する**（quiesce）。稼働した
まま実行すると、スナップショットの後・apply の前に届いた正規の反響（LP アクセス・返戻・手動
編集）が、万一の巻き戻しで一緒に消えてしまう（下記ロールバックの `updated_at` ガードでも
この区間は守れない）。停止は数分・停止中は公開 LP 転送(`/t/`)も止まる点は許容する。

```bash
cd /opt/property-management
set -a && source /etc/property-management/app.env && set +a

# 0. 新プロセスの稼働を確認してから、照合ウィンドウの書き込みを静止する
sudo systemctl is-active property-management
sudo systemctl stop property-management

# 1. 実行前スナップショット（唯一の完全な巻き戻し手段・--apply 前に必ず取得）
sudo -u postgres pg_dump -Fc property_management > /root/pre-reconcile-$(date +%Y%m%d).dump

# 2. 事前確認（dry-run・書き込みなし・件数レポートのみ）
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm \
  npx tsx scripts/reconcile-sale-dm-reactions.ts

# 3. 実書込
sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm \
  npx tsx scripts/reconcile-sale-dm-reactions.ts --apply

# 4. サービス再開
sudo systemctl start property-management
```

検証: `--apply` の件数レポート（対象／ブリッジ済み同期／新規対応付け／保守的付与／対応付けなし）が
dry-run と一致すること。反映後、物件詳細の「DM 送付履歴」で過去の売却DM行に反響
（連絡あり／宛先不明）が表示される。

ロールバック: 冪等＝**再実行が安全**という意味であり、**再実行は取り消しにはならない**
（一意一致で書いた `draft_id` は残り以後そのまま同期される／曖昧行への保守的付与は証拠が
消えても残る）。また「現在の列値を条件にした初期化 SQL」も安全な巻き戻しには**ならない**
（同期が手動反響を上書きした行は手動値が `manual_reaction_shadow` にしか残っておらず初期化で
消える／`cleared` 導出で `draft_id` だけ書かれた行は `reaction_source` が null のまま＝source では
拾えない）。**巻き戻しは実行前スナップショット（上記手順1で取得済み）からの復元のみを正とする**。

戻すとき（`property_dm_logs` の反響列＋`draft_id` だけを実行前の値に書き戻す。手動反響・
shadow 含め完全に戻る。全体復元より影響範囲が小さい）。⚠**巻き戻しは apply の検証で異常を
見つけた直後に行う**。スナップショット〜apply は上記のとおり書き込み停止中に行うため、この
区間に正規の更新は存在しない。サービス再開後に入った正規の反響更新（LP アクセス・返戻・手動
編集）を守るため、（1）**巻き戻し中もサービスを停止**して書き込みを静止し、（2）**apply 完了時刻
より後に更新された行はスキップ**する（`updated_at` ガード。その行は新しい正規の状態を保つ）:

```bash
# 巻き戻し中の書き込みを止める(quiesce)
sudo systemctl stop property-management

sudo -u postgres createdb pm_undo
sudo -u postgres pg_restore -d pm_undo /root/pre-reconcile-YYYYMMDD.dump
sudo -u postgres psql -d pm_undo -c "\copy (SELECT id, draft_id, reaction_status, reacted_at, reaction_note, reaction_source, manual_reaction_shadow FROM property_dm_logs WHERE method='sale_dm') TO '/tmp/pm-undo.csv' CSV"
# <APPLY_END_UTC> は --apply 完了時刻(UTC・例 2026-08-12 03:15:00)。これより後に
# 更新された行=apply 後の正規の反響更新が入った行は書き戻さない。
sudo -u postgres psql -d property_management <<'SQL'
CREATE TEMP TABLE undo_rows (id uuid, draft_id uuid, reaction_status text, reacted_at timestamp, reaction_note text, reaction_source text, manual_reaction_shadow jsonb);
\copy undo_rows FROM '/tmp/pm-undo.csv' CSV
UPDATE property_dm_logs t
SET draft_id = u.draft_id, reaction_status = u.reaction_status, reacted_at = u.reacted_at,
    reaction_note = u.reaction_note, reaction_source = u.reaction_source,
    manual_reaction_shadow = u.manual_reaction_shadow
FROM undo_rows u
WHERE t.id = u.id
  AND t.updated_at <= '<APPLY_END_UTC>'::timestamp;
SQL
sudo -u postgres dropdb pm_undo && sudo rm -f /tmp/pm-undo.csv

sudo systemctl start property-management
```

運用前提: 照合は**本番反映直後（手動の反響入力が始まる前）に1回だけ**実行し、dry-run と apply の
件数比較・履歴表示の確認までをその場で終える（巻き戻すなら即座に）。この時点で実行すれば、
上書きされ得る手動値がそもそも存在しない。コード自体を旧版に戻す場合は反響列は読まれなく
なるため、DB の巻き戻しは必須ではない。

#### 案件ステータスの整理(2026-10-20): migration 2本+restart の後に移し直し

migration `20261020120000_case_status_reorg_values`(enum の作り直し・`ChangeSource` に `auto`)と
`20261020120001_case_status_reorg_migrate`(やめた6値の物件を移す)は、通常手順の `migrate deploy` で流れる。

⚠**物件の表を書き直すので、その間(本番 約13万件・101MB で数秒の見込み。手元の 13.1万件で 1.3秒)は物件の読み書きが
待たされる**(@codex #538 R7)。利用の少ない時間に反映する。1つ目の migration は全体を1つのトランザクションにして、
表を押さえるまでの待ちを10秒まで(`lock_timeout`)にしてある。長い問い合わせのせいで10秒で押さえられなければ、
migration は失敗して**何も変わらない**(旧コードのまま動き続ける・build へ進まない)。そのときは失敗の記録を片付けて、
空いている時に流し直す(手元で「表を25秒押さえた状態→失敗・型は元のまま→片付けて流し直し→成功」を確認済み):

```bash
npx prisma migrate resolve --rolled-back 20261020120000_case_status_reorg_values
npx prisma migrate deploy
```

⚠ただし `migrate deploy` から restart までの間(build の数分)は**旧コードが動いていて、やめた値でも保存できる**。
その間に保存された物件は migration の移し替えを取りこぼす(@codex #538 R3 P2)。新コードはやめた値を受け付けない
ので、**restart の後に1回**、同じ移し替えを流す(冪等=該当が無ければ0件)。restart からこの SQL までの間に申込や
査定報告書が来ても、自動の切り替えはやめた値を移し先の値と同じに扱うので取りこぼさない(@codex #538 R6):

```sql
UPDATE properties SET case_status = 'contacting_owner', version = version + 1
  WHERE case_status IN ('owner_contacted', 'site_checked', 'confirming_owner', 'response_received', 'waiting_registry');
UPDATE properties SET case_status = 'new_case', version = version + 1
  WHERE case_status IN ('dm_target', 'dm_sent');
UPDATE properties SET case_status = 'closed', version = version + 1
  WHERE case_status IN ('done');
```

---

## 8. ロールバック手順

```bash
cd /opt/property-management
set -a && source /etc/property-management/app.env && set +a

# 1. 旧バージョンに戻す
git checkout <previous-tag>
# build には devDependencies が必要（typescript / @types/* / vitest.config.ts の型解決）。
# ⚠ 直前で app.env を source 済み＝NODE_ENV=production のため、素の `npm ci` だと devDependencies が
#   省かれ build が失敗する。必ず `--include=dev` を付ける（build 成功後に `npm prune --omit=dev`）。
npm ci --include=dev
npx prisma generate

# 2. DB マイグレーションを巻き戻す（スキーマ変更があった場合のみ）
npx prisma migrate resolve --rolled-back <migration-name>

# 3. ビルド
npm run build

# 4. devDependencies を落として本番依存へ戻す
npm prune --omit=dev

# 5. サービス再起動
sudo systemctl restart property-management
sudo systemctl status property-management --no-pager
```

> スキーマ変更がない場合はステップ 2 不要。  
> デプロイ前に `pg_dump` でバックアップを取っておくこと。

### 8.1 広告用のご案内ページ(2026-10-20・migration `20261020090000_lp_public_page`)より前へ戻すとき

⚠この反映より前のコードは、申込(`dm_inquiries`)の宛先(`draft_id`)が必ずあるものとして読む(申込一覧の横断・通知メールの処理)。公開ページからの申込(`source='public'`・`draft_id IS NULL`)が1件でも入ったあとに旧コードへ戻すと、申込一覧が 500・その申込の通知の処理が落ちる(@codex #535 P1)。列を消す必要は無い(足した列はすべて任意)が、**旧コードを動かす前に公開ページからの申込の行を退避する**。順番が大事: **先にサービスを止めてから**退避する(動いたままだと、公開名を外す直前に受け付けた申込が退避のあとに入り得る=@codex #535 R3 P1)。

```bash
# 1. サービスを止める(受け口も止まる=この後は新しい申込が入らない)
sudo systemctl stop property-management
```

```sql
-- 2. (任意)公開名を外す(旧コードは public_slug を読まないので必須ではない。値は控えておき、再開時に付け直す)
SELECT id, name, public_slug FROM dm_scenarios WHERE public_slug IS NOT NULL;
UPDATE dm_scenarios SET public_slug = NULL WHERE public_slug IS NOT NULL;
-- 3. 公開ページからの申込を退避表へ(消さない・全列そのまま)
CREATE TABLE dm_inquiries_public_hold_<日付> AS SELECT * FROM dm_inquiries WHERE source = 'public';
DELETE FROM dm_inquiries WHERE source = 'public';
```

```bash
# 4. 旧コードへ(上の手順の 1・3・4・5)。⚠**手順 2 の `prisma migrate resolve --rolled-back` はこの migration には使わない**:
#    列は残したままなので「取り消し済み」と記録すると、次の `prisma migrate deploy` が同じ ADD COLUMN を
#    やり直して失敗する(@codex #535 R3 P1)。列を本当に消すときだけ、先に DDL を手で戻してから resolve する。
git checkout <previous-tag>
npm ci --include=dev
npx prisma generate
npm run build
npm prune --omit=dev
sudo systemctl start property-management
```

```sql
-- 5. 再び新コードへ進めたら戻す(id が同じなので二重にならない)。公開名も付け直す。
INSERT INTO dm_inquiries SELECT * FROM dm_inquiries_public_hold_<日付> ON CONFLICT (id) DO NOTHING;
```

退避した申込は旧コードの間は画面に出ない(対応中の案件があれば退避表を直接見る)。通知メール・受付メールは退避前に送信済みの分は再送されない(`notify_status`/`auto_reply_status` も退避表にそのまま残る)。

### 8.2 案件ステータスの整理(2026-10-20・migration `20261020120000_case_status_reorg_values` / `20261020120001_case_status_reorg_migrate`)より前へ戻すとき

enum `CaseStatus` に `contract_planned`(契約予定)・`contracted`(契約完了)、enum `ChangeSource` に `auto`(自動)を足し、やめた6値の物件を近い値へ移した。PostgreSQL は enum の値を消せないので値は残してよい。**古い版はこの3値を知らず、その行を読むと失敗し得る**(物件一覧・物件の変更履歴)ため、**サービスを止めてから**その行を古い版が知っている値へ退避する。やめた6値からの移し替えは戻さない(古い版も移し先の値を知っている)。

```bash
sudo systemctl stop property-management
```

```sql
-- 契約予定・契約完了の物件を、その時点の版(version)ごと控えて「商談中」へ(戻し先は控えから復元する)
CREATE TABLE case_status_reorg_backup_<日付> AS
  SELECT id, case_status::text AS case_status, version FROM properties WHERE case_status IN ('contract_planned', 'contracted');
UPDATE properties SET case_status = 'negotiating', version = version + 1
  WHERE case_status IN ('contract_planned', 'contracted');
-- 自動で書いた変更履歴を控えて「api」へ
CREATE TABLE change_logs_auto_backup_<日付> AS SELECT id FROM change_logs WHERE source = 'auto';
UPDATE change_logs SET source = 'api' WHERE source = 'auto';
```

旧コードへの切り替えは 8.1 の手順 4 と同じ(古いタグへ戻して入れ直し・build・start)。⚠`prisma migrate resolve --rolled-back` は使わない(値を残したままなので、記録が実態とずれる)。

再び新コードへ進めるときは、**旧版を止めてから**下の SQL を流し、そのあと新コードを start する(旧版は動いている間、やめた値でも保存できる=止めずに流すと取りこぼす)。

```bash
sudo systemctl stop property-management
# 新コードへ切り替えて入れ直し・build(migration は適用済みの記録があるので流れない)
```

```sql
-- 戻すのは「退避で版を1つ進めたあと、旧版の間に誰も保存していない行」
-- (版がちょうど +1)だけ=途中で別の段階に変えてから「商談中」に戻した物件なども上書きしない(@codex #538 P2)。
-- 版を進めずに書く経路は案件ステータスを書かない(版番号の走査の許可リスト)ので、版で見分けられる。
UPDATE properties p SET case_status = b.case_status::"CaseStatus", version = p.version + 1
  FROM case_status_reorg_backup_<日付> b WHERE p.id = b.id AND p.version = b.version + 1;
-- 戻せなかった行(SELECT b.*, p.case_status FROM case_status_reorg_backup_<日付> b JOIN properties p ON p.id = b.id
--   WHERE p.case_status::text <> b.case_status)は、旧版の間に保存された物件。画面で段階を確かめて必要なら手で直す。
UPDATE change_logs c SET source = 'auto' FROM change_logs_auto_backup_<日付> b WHERE c.id = b.id;
-- 旧版の間に、やめた値で保存された物件を移し直す(migration 20261020120001 と同じ対応表・@codex #538 R2 P2)。
-- migration は適用済みの記録があるので、もう一度は流れない=ここで手で流す。
UPDATE properties SET case_status = 'contacting_owner', version = version + 1
  WHERE case_status IN ('owner_contacted', 'site_checked', 'confirming_owner', 'response_received', 'waiting_registry');
UPDATE properties SET case_status = 'new_case', version = version + 1
  WHERE case_status IN ('dm_target', 'dm_sent');
UPDATE properties SET case_status = 'closed', version = version + 1
  WHERE case_status IN ('done');
```

```bash
sudo systemctl start property-management
```

### 現況「賃貸中」(`20261014090000_occupancy_rented`)より前へ戻すとき

この migration は enum `OccupancyStatus` に値 `rented`(賃貸中)を足すだけ。PostgreSQL は enum の値を消せないので、
値そのものは残してよい。ただし**古い版のアプリは `rented` を知らず、その行を読むと失敗し得る**ため、
旧版を起動する**前**に `rented` の行を古い版が知っている値へ戻す。

⚠**先にアプリを止めてから**変換する(@codex PR#512 2巡目)。動いている新しい版が変換の後に「賃貸中」を
保存すると、また `rented` の行ができて旧版が読めなくなる。順番:

1. `sudo systemctl stop property-management`(新しい版を止める=書き込みを止める)
2. 下の SQL を実行する
3. 上の手順 1・3・4(旧版へ戻してビルド)→ 手順 5 で起動(`restart` は停止中でも起動する)
   ⚠**手順 2(`prisma migrate resolve --rolled-back`)はこの migration では行わない**(@codex PR#512 4巡目)。
   `migrate resolve` は失敗した migration にしか使えず、成功済みのものには誤りを返して手順が止まる。
   enum の値も残すので、適用済みの記録はそのままでよい(再び新しい版へ進めても二重には当たらない)。

```sql
-- ① どの物件が賃貸中だったかを控える(再び新しい版へ進めたときに戻すため・@codex PR#512 5巡目)。
--    ⚠控えは消さずに**足していく**(やり直しても前回の控えが残る=10巡目・今の賃貸中も加わる=6巡目)。
--    psql は `-v ON_ERROR_STOP=1` で実行する(途中で失敗したら全体を取り消す)。
BEGIN;
CREATE TABLE IF NOT EXISTS occupancy_rented_backup (id uuid PRIMARY KEY, updated_at timestamp(3));
INSERT INTO occupancy_rented_backup (id, updated_at)
  SELECT id, updated_at FROM properties WHERE occupancy_status = 'rented'
  ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at;
-- ② 旧版の「入居中」(occupied)は賃貸中も含む意味だったので、occupied へ戻す。
-- ⚠版番号(version)も進める=開いたままの編集画面の古い保存を止める(@codex PR#512 45巡目)。
UPDATE properties SET occupancy_status = 'occupied', version = version + 1 WHERE occupancy_status = 'rented';
COMMIT;
```

再び新しい版へ進めるときは、**新しい版を起動する前**に控えから賃貸中に戻し、控えの表を消す
(起動してからだと、その間に人が直した現況を上書きしうる・6巡目)。順番: 旧版を止める →
新しい版をビルドし `prisma migrate deploy` → 下の SQL → 起動。

```sql
-- psql は `-v ON_ERROR_STOP=1` で。戻すのと控えから消すのは1つのトランザクション(片方だけ起きない・10巡目)。
-- ⚠戻した行だけを控えから消す(旧版で保存されて戻さなかった行は控えに残す=人が確かめる・13巡目)。
BEGIN;
WITH restored AS (
  UPDATE properties p SET occupancy_status = 'rented', version = p.version + 1
    FROM occupancy_rented_backup b
    WHERE p.id = b.id AND p.occupancy_status = 'occupied' AND p.updated_at = b.updated_at
    RETURNING p.id
)
DELETE FROM occupancy_rented_backup WHERE id IN (SELECT id FROM restored);
COMMIT;
-- 残った行(SELECT id FROM occupancy_rented_backup)は、旧版の間に保存された物件。
-- 画面で現況を確かめて必要なら賃貸中に直し、終わったら DROP TABLE occupancy_rented_backup;
```

(旧版で動いていた間に**一度でも保存された物件**は、`updated_at` が控えと違うので戻さない=人が直した現況を
上書きしない・@codex PR#512 8巡目。SQL の UPDATE は `updated_at` を動かさないので、控えの変換自体では変わらない。)

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

### 画面を閉じていても届く通知（Web プッシュ・通知 段階4）

設計書 `docs/superpowers/specs/2026-09-27-notifications-design.md` §7.6。**timer は最後に有効にし、戻すときは最初に止める**。

反映の順番:

1. `app.env` に `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（`npx web-push generate-vapid-keys` で作る・値は画面やログに出さない）と `NOTIFICATIONS_PUSH_RUN_SECRET`（`openssl rand -base64 32`）を追記する（追記前に `app.env.bak-<日付>` を退避・600 のまま）。まだ timer は置かない。
2. 通常の更新手順（§6 の差分適用・`prisma migrate deploy` を含む）で反映して再起動する。送信の基準のカーソルは **migration を流した時刻** で初期化される（それより前の査定申込・謄本ジョブは送らない）。migration の中身と止まるもの:
   - `20261003120000_add_next_action_time`（段階3・次回対応の時刻の欄）: **`next_actions` を押さえて**列を足し、既存の全行に `reminder_rev_at` を埋めてからトリガーを作る。⚠列の追加（`ALTER TABLE`）は最も強い押さえ（ACCESS EXCLUSIVE）を取り、COMMIT まで続くので、**その間は次回対応の読み取りも書き込みも待たされる**（ホームの一覧・次回対応タブ・お知らせの件数が数秒止まる）。押さえるのを10秒待っても取れなければ失敗して何も変わらない（やり直しの手順は migration の先頭のコメント）。本番の件数なら数秒の見込みだが、**反映前に件数を確かめ**（`SELECT count(*) FROM next_actions;`）、利用の少ない時間に流す。戻すときはアプリだけを前の版に戻し、列とトリガーは残す（前の版は列を知らないだけで動く）。
   - `20261004100500_add_registry_job_completed_index`: 謄本の一括取得の表に索引を足す（`CREATE INDEX CONCURRENTLY`＝書き込みを止めない）。失敗して INVALID の索引が残ったときのやり直しは migration の先頭のコメント。
   - `20261003130000_add_push_subscriptions` と `20261004100000_add_notification_deliveries`: 表の追加。新しい表から既存の表へ外部キーを張る瞬間だけ、`users`（と `push_subscriptions`）が**短く書き込み止め**になる（読み取りは止めない・行は書き換えない）。`20261004100000` は押さえるのを10秒待っても取れなければ失敗して何も変わらない（やり直しは `npx prisma migrate resolve --rolled-back 20261004100000_add_notification_deliveries` → `npx prisma migrate deploy`）。前の版のアプリとも両立する。
   - `20261004110000_add_edit_lock_loss_events`（段階4c）: 表の追加と、`notification_deliveries` の種類の CHECK の付け替え（行は変えない・`NOT VALID` で付けて COMMIT の後に読み書きを止めずに確かめる）。外部キーと CHECK の付け替えの一瞬だけ `users`・`notification_deliveries` が押さえられ、10秒待っても取れなければ失敗して何も変わらない（やり直しは `npx prisma migrate resolve --rolled-back 20261004110000_add_edit_lock_loss_events` → `npx prisma migrate deploy`）。⚠ただし最後の確かめ（`VALIDATE CONSTRAINT`・これも10秒まで待つ）**だけ**が失敗したときは、表と制約はもう入っているので `--rolled-back` は使わず、migration の末尾のコメントの2手順（確かめを流し直す → `migrate resolve --applied`）でやり直す。⚠この版から**編集の鍵の取り直し・管理者の解除がこの表に書く**ので、必ず migration を先に流してから再起動する（通常の手順どおり。逆にすると鍵の取得・解除が失敗する）。
3. 送信を手で1回だけ動かし、エラーなく終わることを確かめる:
   ```bash
   sudo cp deploy/systemd/pm-push-notify.service.example /etc/systemd/system/pm-push-notify.service
   sudo cp deploy/systemd/pm-push-notify.timer.example   /etc/systemd/system/pm-push-notify.timer
   sudo systemctl daemon-reload
   sudo systemctl start pm-push-notify.service
   journalctl -u pm-push-notify -n 20 --no-pager   # 件数の JSON が1行出れば成功（宛先・中身は出ない）
   ```
   鍵や合言葉が欠けている・表が無いときは送らずに失敗（503/500）で終わる。
4. timer を有効にする: `sudo systemctl enable --now pm-push-notify.timer`（確認: `systemctl list-timers pm-push-notify.timer`）。

元に戻す順番:

1. **timer を止める**: `sudo systemctl disable --now pm-push-notify.timer`（止めないまま戻すと定期実行が失敗し続ける）。
2. アプリを前の版に戻して再起動する。
3. 追加した表（`notification_deliveries`・`notification_delivery_refs`・`notification_fanout_queue`・`notification_source_events`・`notification_source_cursors`・`edit_lock_loss_events`）は前の版に影響しないので残す。消す場合はこの全部を消す（一部だけ残すと、反映し直したとき migration が「表がもうある」で失敗する。消す手順は各 migration の先頭のコメント。消したあとで反映し直すときは、消した migration ごとに `npx prisma migrate resolve --rolled-back <名前>` で適用済みの印を戻してから `migrate deploy`）。消すと送信の記録と基準のカーソルが失われ、再び反映したときはカーソルの初期化からやり直しになる。

⚠送信の口（`/api/notifications/push-run`）は合言葉で守っている。さらに nginx で外からは 404 にする（`deploy/nginx/property-management.conf.example` の `location = /api/notifications/push-run`。timer は `127.0.0.1:3000` を直接呼ぶので影響しない）。本番の nginx に足すときは `nginx -t` → `systemctl reload nginx`。

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

## 11. マンション名簿の読み込み(2026-10-18〜)

セルフイン(一都三県)から集めたマンション一覧を、裏の名簿(`mansion_catalog`)に入れる。名簿は画面の「マンション棟」一覧には並ばない(物件登録の補完と、棟の検索の2段目だけ)。

1. 合言葉とフォルダを app.env に足す(root・値は画面に出さない・追記前に `app.env.bak-<日付>` に退避):
   `MANSION_CATALOG_LOAD_SECRET`(`openssl rand -base64 32`)・`MANSION_CATALOG_DIR=/var/lib/property-management/mansion-catalog` → `flock -n /root/pm-deploy.lock systemctl restart property-management`
2. 集めたファイルを写す(root。集める側のフォルダは DynamicUser の私有フォルダでアプリから読めない):
   `install -d -o www-data -m 750 /var/lib/property-management/mansion-catalog && install -o www-data -m 640 /var/lib/selfin-collect/buildings-*.jsonl /var/lib/property-management/mansion-catalog/`
3. 読み込む(合言葉は app.env から読む=画面に出さない):
   `set -a; . /etc/property-management/app.env; set +a; printf 'x-mansion-catalog-secret: %s\n' "$MANSION_CATALOG_LOAD_SECRET" | curl -s -X POST -H @- http://127.0.0.1:3000/api/mansion-catalog/load-run`
   → `{ files, inserted, updated, skipped, duplicates, linked }` の件数だけが返る(`linked`=今ある棟のうち名簿につないだ数)。
   ⚠8万8千件を一度に読む(1回 500 件ずつ)。数分かかる。同時に2回は動かない(409)。
4. 取り直したときは 2〜3 をもう一度(名簿だけが更新され、社内の棟の値は上書きしない)。
