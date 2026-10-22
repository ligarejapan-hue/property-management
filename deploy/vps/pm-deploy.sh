#!/usr/bin/env bash
# 本番反映スクリプト（docs/deploy.md §6 の手順を1本にしたもの）
#
# - VPS に root 所有で /usr/local/sbin/pm-deploy として置き、反映専用ユーザー deploy から sudo で呼ぶ。
#   （リポジトリ内のこのファイルを直接 sudo で実行しない。更新時は §6.1 の手順で置き直す）
# - GitHub Actions（.github/workflows/deploy.yml）から SSH 経由で呼ばれる。
# - リポジトリが公開のため Actions のログは誰でも読める。標準出力には工程名と結果だけを出し、
#   各コマンドの出力は /var/log/pm-deploy/ （root のみ読める）に残す。
#
# 使い方:
#   pm-deploy [--migrate] [--expect-sha <40桁>]   反映する
#   pm-deploy --status                            今の版とサービス状態を表示する
set -euo pipefail

APP_DIR=/opt/property-management
ENV_FILE=/etc/property-management/app.env
SERVICE=property-management
HEALTH_URL=http://127.0.0.1:3000/
LOG_DIR=/var/log/pm-deploy

usage() { echo "usage: pm-deploy [--migrate] [--expect-sha <40桁>] | --status" >&2; exit 2; }

MIGRATE=0
EXPECT_SHA=""
STATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) MIGRATE=1 ;;
    --status) STATUS=1 ;;
    --expect-sha)
      shift
      [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || usage
      EXPECT_SHA="$1"
      ;;
    *) usage ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "root で実行してください（sudo 経由）" >&2; exit 2; }
cd "$APP_DIR"

asw() { sudo -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm "$@"; }
aswe() { sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm "$@"; }

if [ "$STATUS" -eq 1 ]; then
  echo "version: $(asw git rev-parse HEAD)"
  echo "service: $(systemctl is-active "$SERVICE" || true)"
  exit 0
fi

exec 9>/run/pm-deploy.lock
flock -n 9 || { echo "別の反映が実行中です" >&2; exit 3; }

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
chmod 600 "$LOG"

CURRENT_STEP=""
on_error() {
  echo "NG: 「${CURRENT_STEP}」で失敗しました。詳細は VPS の ${LOG} を確認してください。" >&2
  echo "    サービスは再起動していません（build 後に失敗した場合は、手動で §6 の手順を確認してください）。" >&2
}
trap on_error ERR

step() {
  CURRENT_STEP="$1"; shift
  echo "==> ${CURRENT_STEP}"
  echo "===== ${CURRENT_STEP} =====" >> "$LOG"
  "$@" >> "$LOG" 2>&1
}

BEFORE=$(asw git rev-parse HEAD)
echo "反映前の版: ${BEFORE}"

CURRENT_STEP="作業ツリーの確認"
if [ -n "$(asw git status --porcelain --untracked-files=no)" ]; then
  echo "NG: VPS の作業ツリーに未コミットの変更があります。手で確認してください。" >&2
  exit 4
fi

step "最新コードの取得" asw git fetch origin main
TARGET=origin/main
if [ -n "$EXPECT_SHA" ]; then
  CURRENT_STEP="反映する版の確認"
  if ! asw git merge-base --is-ancestor "$EXPECT_SHA" origin/main; then
    echo "NG: 指定の版 ${EXPECT_SHA} が origin/main に含まれていません。" >&2
    exit 5
  fi
  TARGET="$EXPECT_SHA"
fi
step "コードの更新（fast-forward のみ）" asw git merge --ff-only "$TARGET"
AFTER=$(asw git rev-parse HEAD)
if [ -n "$EXPECT_SHA" ] && [ "$AFTER" != "$EXPECT_SHA" ]; then
  # 古い版を指定して再実行した場合など: --ff-only は後ろへは戻さず「Already up to date」で成功するため、
  # CI を確認した版と実際に build する版がずれる。依存の入れ直し・DB に触る前に止める。
  trap - ERR
  echo "NG: VPS の版（${AFTER}）が指定の版（${EXPECT_SHA}）と一致しません。" >&2
  echo "    VPS がすでに新しい版です。最新の main で反映し直してください。何も変更していません。" >&2
  exit 8
fi

mkdir -p /var/www/.npm
chown www-data:www-data /var/www/.npm
step "依存のインストール" asw npm ci --include=dev --no-audit --no-fund

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

step "Prisma クライアントの生成" aswe npx prisma generate

if [ "$MIGRATE" -eq 1 ]; then
  step "マイグレーション" aswe npx prisma migrate deploy
else
  CURRENT_STEP="未適用マイグレーションの確認"
  echo "==> ${CURRENT_STEP}"
  echo "===== ${CURRENT_STEP} =====" >> "$LOG"
  if ! aswe npx prisma migrate status >> "$LOG" 2>&1; then
    trap - ERR
    echo "NG: 未適用の migration があるか、状態を確認できません。build と再起動はしていません。" >&2
    echo "    migration を流す場合は migrate を有効にして反映し直してください。詳細: ${LOG}" >&2
    exit 6
  fi
fi

step "ビルド" aswe npm run build
step "本番依存へ戻す（devDependencies を削除）" asw npm prune --omit=dev

CURRENT_STEP="PDF 圧縮の自己診断"
echo "==> ${CURRENT_STEP}"
if ! sudo -u www-data python3 "$APP_DIR/scripts/pdf-compress.py" --self-test >> "$LOG" 2>&1; then
  echo "WARN: PDF 圧縮の自己診断に失敗しました（反映は続けます。§6 手順 7 を確認してください）"
fi

step "サービスの再起動" systemctl restart "$SERVICE"
sleep 5
CURRENT_STEP="サービスの起動確認"
systemctl is-active --quiet "$SERVICE"

CURRENT_STEP="応答の確認"
echo "==> ${CURRENT_STEP}"
CODE=000
for _ in $(seq 1 24); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
  if [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 500 ]; then break; fi
  sleep 5
done
if ! { [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 500 ]; }; then
  echo "NG: 再起動後にアプリが応答しません（HTTP ${CODE}）。詳細: ${LOG}" >&2
  exit 7
fi

trap - ERR
echo "OK: 反映しました"
echo "  反映前: ${BEFORE}"
echo "  反映後: ${AFTER}"
echo "  migration: $([ "$MIGRATE" -eq 1 ] && echo '実行' || echo 'なし')"
echo "  応答: HTTP ${CODE}"
