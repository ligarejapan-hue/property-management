# 本番デプロイガイド

対象: Node.js（CI では Node.js 24 で検証） / PostgreSQL 15+ / Linux サーバー（または同等の PaaS）

---

## 1. リリース前チェックリスト

### 実行環境

- [ ] Node.js のバージョンが CI と揃っていること（CI では **Node.js 24** で検証。本番・検証環境は CI の Node 版数に合わせることを推奨。Next.js 16 の正確な最小要件は本ガイドでは断定しない）
  ```bash
  node --version   # CI 検証版数（Node.js 24）に合わせることを推奨
  npm --version
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

# 7. サービス再起動
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

### リリース同梱の一回限り作業（one-shot）

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
