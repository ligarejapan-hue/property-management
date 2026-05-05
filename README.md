# 物件情報一元管理システム

物件情報を中心に、現地確認・登記取得状況・DM送付判断・所有者情報・調査情報を一元管理する社内業務システム。

> **本番デプロイ手順 → [docs/deploy.md](./docs/deploy.md)**

---

## 技術構成

| カテゴリ | 技術 |
|---------|------|
| フレームワーク | Next.js 16 (App Router) + TypeScript |
| UI | Tailwind CSS v4 + lucide-react |
| ORM | Prisma 7 |
| DB | PostgreSQL 15+ |
| 認証 | NextAuth v5 (Auth.js) - Credentials |
| バリデーション | Zod + React Hook Form |
| PDF 解析 | pdf-parse v2 |

---

## ローカル開発 起動手順

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して DATABASE_URL と NEXTAUTH_SECRET を設定
```

### 3. PostgreSQL の起動

**オプション A: embedded-postgres（Docker 不要・推奨）**

```bash
node scripts/start-db.mjs
```

初回のみクラスタを初期化。データは `./tmp/pg-data/` に永続保存される。
別ターミナルで起動したまま、以降の手順を進めること。

**オプション B: Docker**

```bash
docker run -d --name pg-property \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=property_management \
  -p 5432:5432 \
  postgres:15
```

**オプション C: docker-compose**

```bash
docker compose up -d
```

### 4. DB マイグレーション

```bash
npx prisma migrate dev --name init
```

### 5. シードデータの投入

```bash
npm run db:seed
```

テストユーザー:

| メール | パスワード | ロール |
|--------|-----------|--------|
| admin@example.com | password123 | admin |
| office@example.com | password123 | office_staff |
| field@example.com | password123 | field_staff |

### 6. 開発サーバーの起動

```bash
npm run dev
```

> `npm run dev` は `next dev --webpack` で起動（Turbopack ではなく webpack）。

http://localhost:3000 でアクセス。

---

## npm スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run dev` | 開発サーバー起動（webpack 固定） |
| `npm run build` | プロダクションビルド |
| `npm run start` | プロダクションサーバー起動 |
| `npm run lint` | ESLint 実行 |
| `npm run format` | Prettier で整形 |
| `npm run db:generate` | Prisma Client 生成 |
| `npm run db:migrate` | マイグレーション実行 |
| `npm run db:seed` | シードデータ投入 |
| `npm run db:reset` | DB リセット（開発用） |
| `npm run db:studio` | Prisma Studio 起動 |
| `npm run ksj:mock` | KSJ 調査情報モックサーバー起動（port 9000） |
| `npm run storage:mock` | ストレージモックサーバー起動（port 4000） |
| `npm run storage:migrate` | ローカル → サーバーストレージ移行 |

---

## ディレクトリ構成

```
property-management/
├── docs/
│   └── deploy.md              # 本番デプロイガイド
├── prisma/
│   ├── schema.prisma          # 全テーブル定義
│   ├── seed.ts                # シードデータ
│   └── migrations/            # マイグレーションファイル
├── public/
│   └── uploads/               # ローカルストレージ (STORAGE_BACKEND=local 時)
├── scripts/
│   ├── start-db.mjs           # embedded-postgres 起動
│   ├── mock-ksj-server.mjs    # KSJ 調査情報モック
│   ├── mock-storage-server.mjs # ストレージモック
│   └── migrate-storage.mjs    # ストレージ移行スクリプト
├── src/
│   ├── app/
│   │   ├── (auth)/login/      # ログイン画面
│   │   ├── (dashboard)/
│   │   │   ├── properties/    # 物件一覧・詳細
│   │   │   ├── buildings/     # 棟一覧・詳細（区分物件）
│   │   │   ├── import/        # CSV / 登記PDF 取込
│   │   │   ├── admin/         # ユーザー・権限・ログ管理
│   │   │   └── help/          # ヘルプ
│   │   └── api/               # API ルート
│   ├── lib/
│   │   ├── storage/           # ストレージ抽象層 (local / server adapter)
│   │   ├── investigation/     # 調査情報プロバイダ (KSJ + stub)
│   │   ├── csv-parser.ts      # CSV パーサー
│   │   ├── pdf-extract.ts     # PDF テキスト抽出
│   │   ├── pdf-registry-parser.ts  # 登記謄本テキスト解析
│   │   ├── auth.ts            # NextAuth 設定
│   │   ├── permissions.ts     # 権限判定
│   │   └── audit.ts           # 監査ログ書き込み
│   └── proxy.ts               # 認証プロキシ（Next.js 16 Proxy）
├── .env.example               # 環境変数テンプレート
└── package.json
```

---

## 機能一覧

### 物件管理

| 機能 | 状態 |
|------|------|
| 物件一覧・検索 | ✅ |
| 物件詳細・編集（楽観的ロック） | ✅ |
| 物件 quality-check | ✅ |
| 変更ログ（フィールド単位） | ✅ |
| 候補マッチング（距離判定） | ✅ |
| 一括更新 | ✅ |

### 区分・棟管理

| 機能 | 状態 |
|------|------|
| 棟一覧・詳細 | ✅ |
| 棟に紐付く区分一覧 | ✅ |

### 取込（import）

| 機能 | 状態 |
|------|------|
| 物件 CSV 取込（プレビュー → 取込） | ✅ |
| 所有者 CSV 取込 | ✅ |
| 登記 PDF parse（謄本テキスト解析） | ✅ |
| 登記 PDF import（DB 書き込み） | ✅ |
| 取込ジョブ履歴・行単位リトライ | ✅ |

### 調査情報（investigation）

| 機能 | 状態 |
|------|------|
| 調査情報取得（KSJ 用途地域・建蔽率・容積率・防火地域） | ✅ |
| 調査結果確定（confirm → DB 反映） | ✅ |
| KSJ モックサーバー（開発用） | ✅ |
| GeoServer 本番対応 | ✅（KSJ_API_URL 設定で有効） |

### ファイル管理

| 機能 | 状態 |
|------|------|
| 写真アップロード・削除 | ✅ |
| 添付ファイルアップロード・削除 | ✅ |
| ローカルストレージ（開発） | ✅ |
| サーバーストレージ（本番） | ✅（STORAGE_BACKEND=server） |
| local → server 移行スクリプト | ✅ |

### 所有者管理

| 機能 | 状態 |
|------|------|
| 所有者一覧・検索・詳細 | ✅ |
| 物件↔所有者紐付け | ✅ |
| 個人情報表示レベル制御 | ✅ |

### 管理機能

| 機能 | 状態 |
|------|------|
| ユーザー管理（CRUD） | ✅ |
| 権限テンプレート管理 | ✅ |
| ユーザー個別権限設定 | ✅ |
| 監査ログ（操作証跡） | ✅ |
| 権限変更履歴 | ✅ |

### 将来実装

| 機能 | 予定フェーズ |
|------|------------|
| Google Maps 地図表示 | Phase 2 |
| 2FA (TOTP) | Phase 1後半 |
| パスワードリセット（メール） | Phase 1後半 |
| 路線価 API 本接続 | Phase 3 |
| 道路台帳 API 本接続 | Phase 3 |
| PostGIS 空間クエリ最適化 | Phase 2 |

---

## 環境変数 (概要)

詳細は [`.env.example`](./.env.example) および [`docs/deploy.md`](./docs/deploy.md) を参照。

| 変数 | 必須 | 説明 |
|------|------|------|
| `DATABASE_URL` | ✅ | PostgreSQL 接続文字列 |
| `NEXTAUTH_SECRET` | ✅ | セッション暗号化キー（本番は 32 文字以上） |
| `NEXTAUTH_URL` | ✅ | アプリの公開 URL |
| `STORAGE_BACKEND` | 本番必須 | `local`（開発）/ `server`（本番） |
| `STORAGE_SERVER_URL` | server 時必須 | ストレージサーバー Base URL |
| `STORAGE_SERVER_API_KEY` | server 時必須 | ストレージサーバー認証キー |
| `KSJ_API_URL` | 推奨 | GeoServer WFS エンドポイント（未設定で KSJ 無効） |

---

## 認証・権限の実装方針

### 認証フロー

1. NextAuth v5 Credentials プロバイダーでメール/パスワード認証
2. ログイン 5 回失敗で 30 分アカウントロック
3. JWT セッション（30 分タイムアウト）
4. 未認証アクセスは `/login?callbackUrl=...` にリダイレクト（`src/proxy.ts`）

### 権限解決ロジック

```
最終権限 = user_permissions > template_permissions > deny (デフォルト拒否)
```

- `PermissionTemplate`: ロール別の標準権限セット
- `UserPermission`: ユーザー個別の上書き（許可追加 / 権限剥奪の両方が可能）

### 個人情報表示レベル

| レベル | 説明 |
|-------|------|
| `hidden` | 非表示（フィールド自体を API レスポンスから除去） |
| `masked` | マスク（電話: `***-****-5678`） |
| `partial` | 部分表示（住所: 都道府県・市区町村まで） |
| `full` | 全表示 |

---

## KSJ 調査情報プロバイダ

`KsjZoningProvider` を使って用途地域・建蔽率・容積率・防火地域を取得。

### 開発: モックサーバー（推奨）

```bash
npm run ksj:mock   # port 9000 で起動
```

`.env` に設定:

```dotenv
KSJ_API_URL=http://localhost:9000/geoserver/ksj/ows
```

### 本番: GeoServer

詳細は [docs/deploy.md](./docs/deploy.md#ksj) または README の「KSJ ローカル確認手順」セクションを参照。

---

## Prisma スキーマ - テーブル一覧

### 認証・権限

| テーブル | 説明 |
|---------|------|
| users | ユーザー（ロール・ロック） |
| permission_templates | 権限テンプレート定義 |
| template_permissions | テンプレート個別権限 |
| user_permissions | ユーザー個別権限上書き |
| permission_change_logs | 権限変更監査ログ |

### 物件・所有者

| テーブル | 説明 |
|---------|------|
| properties | 物件情報（調査確定値を含む） |
| buildings | 棟情報 |
| owners | 所有者情報 |
| property_owners | 物件↔所有者 多対多 |
| property_photos | 物件写真 |
| property_investigation_logs | 調査情報スナップショット履歴 |

### 運用

| テーブル | 説明 |
|---------|------|
| attachments | 汎用添付ファイル |
| comments | コメント・申し送り |
| change_logs | フィールド単位変更履歴 |
| audit_logs | 操作監査ログ |
| next_actions | 次回対応管理 |

### 取込

| テーブル | 説明 |
|---------|------|
| import_jobs | 取込ジョブメタ情報 |
| import_job_rows | 取込行単位処理結果 |

---

## GeoServer セットアップ（本番用KSJ）

詳細は [docs/deploy.md](./docs/deploy.md) を参照。
以下は開発時の簡易確認手順の概要。

```bash
# GeoServer を Docker で起動
docker compose up -d geoserver

# WFS 疎通確認
curl "http://localhost:8080/geoserver/ksj/ows?service=WFS&request=GetFeature&typeName=ksj:A29&outputFormat=application/json&CQL_FILTER=CONTAINS(the_geom,POINT(139.767%2035.681))&maxFeatures=1"
```

## 運用メモ

GitHub workflow check: PRs to main are validated by CI (build + test) before merge.
Codex review check: PR comments may request `@codex review` after CI passes.
