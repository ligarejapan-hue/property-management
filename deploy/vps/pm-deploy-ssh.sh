#!/usr/bin/env bash
# 反映専用ユーザー deploy の SSH 強制コマンド（authorized_keys の command= で指定する）
#
# - VPS に root 所有で /usr/local/sbin/pm-deploy-ssh として置く。
# - SSH で送られてきたコマンドのうち、決まった形だけを pm-deploy に渡す。それ以外は拒否する。
#   許可する形:
#     deploy [--migrate] [--expect-sha <40桁>]
#     status
set -euo pipefail

read -r -a ARGS <<< "${SSH_ORIGINAL_COMMAND:-}"

case "${ARGS[0]:-}" in
  deploy)
    PASS=()
    i=1
    while [ "$i" -lt "${#ARGS[@]}" ]; do
      case "${ARGS[$i]}" in
        --migrate) PASS+=("--migrate") ;;
        --expect-sha)
          i=$((i + 1))
          [[ "${ARGS[$i]:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "不正な引数です" >&2; exit 2; }
          PASS+=("--expect-sha" "${ARGS[$i]}")
          ;;
        *) echo "不正な引数です" >&2; exit 2 ;;
      esac
      i=$((i + 1))
    done
    exec sudo -n /usr/local/sbin/pm-deploy "${PASS[@]}"
    ;;
  status)
    [ "${#ARGS[@]}" -eq 1 ] || { echo "不正な引数です" >&2; exit 2; }
    exec sudo -n /usr/local/sbin/pm-deploy --status
    ;;
  *)
    echo "許可されていないコマンドです" >&2
    exit 2
    ;;
esac
