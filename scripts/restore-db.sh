#!/usr/bin/env bash
# =============================================================================
# DB リストアスクリプト
# =============================================================================
# 使い方:
#   bash scripts/restore-db.sh <backup-file.sql.gz>
#
# 例:
#   bash scripts/restore-db.sh /var/backups/property-management/db_20260101_020000.sql.gz
#
# 環境変数:
#   ENV_FILE - app.env のパス（デフォルト: /etc/property-management/app.env）
#
# 注意:
#   - リストア前に現在の DB を pg_dump でバックアップしておくこと
#   - 実行中はアプリを停止することを推奨:
#       sudo systemctl stop property-management
#       bash scripts/restore-db.sh <file>
#       sudo systemctl start property-management
# =============================================================================
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/property-management/app.env}"
BACKUP_FILE="${1:-}"

# 引数チェック
if [ -z "$BACKUP_FILE" ]; then
  echo "使い方: $0 <backup-file.sql.gz>"
  echo "例:     $0 /var/backups/property-management/db_20260101_020000.sql.gz"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[ERROR] ファイルが見つかりません: $BACKUP_FILE" >&2
  exit 1
fi

# app.env から DATABASE_URL を読み込む
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  echo "[ERROR] ENV_FILE が見つかりません: $ENV_FILE" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[ERROR] DATABASE_URL が設定されていません" >&2
  exit 1
fi

# 確認プロンプト
echo "================================================================"
echo "  リストア対象ファイル: $BACKUP_FILE"
echo "  リストア先 DB:        $(echo "$DATABASE_URL" | sed 's|postgresql://[^:]*:[^@]*@||')"
echo "  ※ 現在の DB データは上書きされます"
echo "================================================================"
printf "続行しますか？ [y/N]: "
read -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "キャンセルしました"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] リストア開始: $BACKUP_FILE"

gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" --no-password -v ON_ERROR_STOP=1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] リストア完了"
echo ""
echo "次のステップ:"
echo "  sudo systemctl start property-management   # アプリを再起動"
echo "  npx prisma migrate deploy                  # 未適用マイグレーションがあれば実行"
