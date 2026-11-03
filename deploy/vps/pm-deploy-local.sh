#!/bin/bash
# property-management 本番反映(手元からの経路)。docs/deploy.md §6.2a。
# 取得 → 依存の入れ直し → prisma → (migration があればバックアップ → migrate) → build → prune → 再起動 → smoke。
#
# - ユーザーが「反映して」と指示したときだけ、その指示を受けた 1 つのセッションが使う(CLAUDE.md §13)。
# - VPS 上で root が実行する。手元(Git Bash)から:
#     scp deploy/vps/pm-deploy-local.sh root@133.117.72.225:/root/pm-deploy.sh
#     ssh root@133.117.72.225 'chmod 700 /root/pm-deploy.sh; nohup /root/pm-deploy.sh <想定SHA先頭8桁> > /root/pm-deploy.log 2>&1 & echo started'
#   終わったかは /root/pm-deploy.log の最後の行で見る
#   (DEPLOY_DONE / BUILD_OK_NO_RESTART / SMOKE_NG / FAILED_AT / LOCKED / UNEXPECTED_SHA / WORKTREE_DIRTY)。
# - 鍵は GitHub Actions 側(/usr/local/sbin/pm-deploy)と同じ /run/pm-deploy.lock。どちらの経路でも同時に 1 本だけ動く。
#   こちらは鍵が取れなければ最大 LOCK_WAIT 秒(既定 1800)待ち、待ちきれなければ何も変えずに LOCKED で終わる。
#   Actions 側は鍵が取れなければすぐに止まる(「別の反映が実行中です」)。
#
# 引数: $1 = 想定する origin/main の SHA 先頭8桁(必須・前方一致で検査=手打ちの取り違えを止める)
#       $2 = "norestart" を渡すと build までで止める(restart を別に行いたいとき)
# 環境: LOCK_WAIT = 鍵を待つ秒数(既定 1800)
set -euo pipefail
EXPECT="${1:?想定SHA(先頭8桁)を渡してください}"
MODE="${2:-}"
LOCK_WAIT="${LOCK_WAIT:-1800}"
BAK=""; RESTARTED=0
on_err() {
  echo "FAILED_AT line $1 (restart 前なら本番は旧プロセスのまま動いている)"
  # build が途中で落ちると .next が半端に壊れる=次の restart で壊れた版が使われないよう、退避を戻しておく
  if [ -n "$BAK" ] && [ "$RESTARTED" = 0 ] && [ -d "/opt/property-management/$BAK" ]; then
    sudo -n -u www-data bash -c "cd /opt/property-management && rm -rf .next && cp -a '$BAK' .next" \
      && echo "RESTORED_NEXT from $BAK(HEAD は新しい版のまま・.next は旧版の build)"
  fi
}
trap 'on_err $LINENO' ERR

# ★排他の鍵(Actions 側と共通)。別の反映と同時に依存を入れ直すと node_modules が壊れる(2026-10-11)。
#   鍵を取るまでは本番を何も変えない。鍵ファイルは消さない(/run は再起動で消えるが、次に作り直される)。
LOCK=/run/pm-deploy.lock
WAITED=0
exec 9>"$LOCK"
flock -n 9 || {
  echo "WAITING_LOCK(別の反映が実行中・最大 ${LOCK_WAIT} 秒待つ。相手は fuser -v $LOCK で見る)"
  WAITED=1
  flock -w "$LOCK_WAIT" 9 || { echo "LOCKED(${LOCK_WAIT} 秒待っても鍵が空かない・何も変えていない)"; exit 1; }
  echo "LOCK_ACQUIRED"
}
# 移行の間の守り: 鍵を /root/pm-deploy.lock に置いていた古い写しが動いていても重ならないよう、古い鍵も取る
# (取る順はいつも新しい鍵 → 古い鍵。Actions 側は新しい鍵だけ・古い写しは古い鍵だけなので、待ち合いで止まらない)。
exec 8>/root/pm-deploy.lock
flock -w "$LOCK_WAIT" 8 || { echo "LOCKED(古い鍵 /root/pm-deploy.lock が空かない・何も変えていない)"; exit 1; }

cd /opt/property-management
G="sudo -n -u www-data env HOME=/var/www git -C /opt/property-management"   # git は必ず www-data(root だと .git/index が root 所有になり次から壊れる)
W="sudo -n -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"

OLD=$($G rev-parse --short=8 HEAD)
$G restore package-lock.json            # 前回の prune が残す lock の揺れで ff が弾かれるのを防ぐ
$G fetch origin                          # GitHub が遅いと失敗することがある=そのまま再実行してよい(まだ何も変えていない)
NEW=$($G rev-parse --short=8 origin/main)
case "$NEW" in "$EXPECT"*) ;; *) echo "UNEXPECTED_SHA origin/main=$NEW 想定=$EXPECT"; exit 1;; esac
# 待っている間にもう一方の経路が同じ版まで進めていても、作り直す(相手が build や再起動の途中で失敗していても直るように)
if [ "$WAITED" = 1 ] && [ "$OLD" = "$NEW" ]; then
  echo "SAME_VERSION_AFTER_WAIT $NEW(待っている間に別の反映がこの版まで進めた・念のため作り直す)"
fi
$G merge-base --is-ancestor HEAD origin/main
BAK=".next.bak-$OLD-$(date +%Y%m%d-%H%M%S)"
sudo -n -u www-data cp -a .next "$BAK"
echo "BAK=$BAK"
$G merge --ff-only origin/main           # 対象は必ず origin/main(full SHA の手打ちは捏造事故の実績あり)

$W npm ci --include=dev                  # devDeps 込み(build が vitest.config.ts を型チェックする)
set -a; . /etc/property-management/app.env; set +a
# heap 3072 が無いと build が heap 不足で落ちる(2026-10-15)。npx ではなく .bin を直に呼ぶ(npx は別の版を取りに行く)。
WE="sudo -E -n -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_OPTIONS=--max-old-space-size=3072"
$WE ./node_modules/.bin/prisma generate
# ★migration がある回は直前に DB のバックアップ(足すだけでも取る・ユーザー指示 2026-11-01・docs/deploy.md §6 の手順 3.5)。
#   取れない・読めないときは ERR で止まり、migrate へ進まない(restart 前=本番は旧版のまま)。
PRE_DIR=/var/backups/property-management/pre-migration
if [ -n "$($G diff --name-only "$OLD" HEAD -- prisma/migrations)" ]; then
  install -d -m 700 -o root -g root "$PRE_DIR"
  PRE_DUMP="$PRE_DIR/db-$OLD-$(date +%Y%m%d-%H%M%S).dump"
  ( umask 077; pg_dump "${DATABASE_URL%%\?*}" -Fc --no-owner --no-privileges -f "$PRE_DUMP" )
  pg_restore --list "$PRE_DUMP" > /dev/null
  echo "PRE_MIGRATION_BACKUP=$PRE_DUMP $(du -h "$PRE_DUMP" | cut -f1)"
fi
$WE ./node_modules/.bin/prisma migrate deploy   # migrate status を前のゲートにしない(pending だと exit 1)
$WE npm run build
$W npm prune --omit=dev
$G restore package-lock.json
DIRTY=$($G status --porcelain | grep -v '^??' || true)   # grep の空一致(exit 1)で set -e が止まらないよう || true
[ -z "$DIRTY" ] || { echo "WORKTREE_DIRTY:"; echo "$DIRTY"; exit 1; }
echo "BUILD_OK $OLD -> $NEW"

if [ "$MODE" = "norestart" ]; then echo BUILD_OK_NO_RESTART; exit 0; fi

PID_OLD=$(systemctl show -p MainPID --value property-management)
RESTARTED=1
systemctl restart property-management    # 鍵(fd 9)を持ったまま=もう一方の経路の restart と重ならない
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/login || true)
  [ "$code" = 200 ] && break; sleep 2
done
PID_NEW=$(systemctl show -p MainPID --value property-management)
echo "PID $PID_OLD -> $PID_NEW $(systemctl is-active property-management)"
journalctl -u property-management --since "3 min ago" --no-pager | grep -E "Ready in" | tail -1 || true
echo "--- err(3分):"; journalctl -u property-management -p err --since "3 min ago" --no-pager | tail -5 || true

# smoke: 期待コードと違えば SMOKE_NG。/uploads/probe=401 が最重要(200 なら認可の回帰=即異常)
NG=0
for pair in "/:307" "/login:200" "/uploads/probe:401" "/t/probe:302" "/help:307" "/properties:307" "/admin/sale-dm-settings:307"; do
  p=${pair%%:*}; want=${pair##*:}
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3000$p" || true)
  echo "$p -> $got (期待 $want)"; [ "$got" = "$want" ] || NG=1
done

# 退避は最新3世代だけ残す(migration 前の DB の控えも、smoke まで通ったあとで3世代に)
[ $NG = 0 ] && { ls -1t "$PRE_DIR"/db-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -- ; } || true
sudo -n -u www-data bash -c 'ls -1dt .next.bak* | tail -n +4 | xargs -r rm -rf'
$G status --porcelain | grep -v '^??' || echo "git clean"
[ $NG = 0 ] && echo "DEPLOY_DONE $OLD -> $NEW pid=$PID_NEW bak=$BAK" || echo "SMOKE_NG $OLD -> $NEW(ロールバック手順を検討)"
