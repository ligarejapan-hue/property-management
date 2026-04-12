#!/usr/bin/env bash
# =============================================================================
# DB バックアップスクリプト
# =============================================================================
# 使い方:
#   bash scripts/backup-db.sh
#
# 環境変数（省略時はデフォルト値を使用）:
#   ENV_FILE       - app.env のパス（デフォルト: /etc/property-management/app.env）
#   BACKUP_DIR     - バックアップ保存先（デフォルト: /var/backups/property-management）
#   RETENTION_DAYS - 保持日数（デフォルト: 30）
#
# cron 設定例（毎日 2:00 に実行）:
#   0 2 * * * www-data bash /opt/property-management/scripts/backup-db.sh >> /var/log/pm-backup.log 2>&1
# =============================================================================
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/property-management/app.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/property-management}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"

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

# バックアップディレクトリ作成
mkdir -p "$BACKUP_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] バックアップ開始: $BACKUP_FILE"

pg_dump "$DATABASE_URL" \
  --no-password \
  --verbose \
  --format=plain \
  --no-owner \
  --no-privileges \
  2>/dev/null \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] バックアップ完了: $BACKUP_FILE ($SIZE)"

# 保持期間を超えた古いバックアップを削除
DELETED=$(find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 古いバックアップ削除: ${DELETED}件（${RETENTION_DAYS}日超）"
