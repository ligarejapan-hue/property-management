# VPS まとめ反映チェックリスト（`08af869` → `59c03b7`）

VPS 最終反映済み HEAD `08af869`（2026-06-07）以降に main へ merge された **PR #147〜#153** を、
VPS（本番）へ安全に**まとめて反映**するための手順書。

これは手順書（docs-only）であり、**本ファイルの作成時点で VPS 操作は一切行っていない**。
実際の反映は、ユーザーが (a) `systemctl restart` / (b) 必要時の DB 操作を**明示承認**した後に別タスクで実行する。

- 反映元: `08af869`（VPS 現 HEAD・記録上）/ 反映先: `59c03b7`（= local main == origin/main・現時点）
- 基準ルール: CLAUDE.md §13・`docs/deploy.md`・運用知見（本書はそれらを今回バッチ向けに具体化する索引）

> ⚠ 本書の手順・コマンド例は**載せるが実行しない**。read-only 確認すら**root では行わない**（§4）。

---

## 1. 目的

- `08af869` 以降の main 差分（PR #147〜#153）を VPS へ**まとめて反映**する。
- 本番 DB / storage / 権限 / アップロードに影響し得る変更を整理し、**今回バッチの実リスクを確定**する。
- 反映前・反映中・反映後の**停止条件**を明確にし、異常時は止めて報告する。

今回バッチの結論（差分実測・§2/§3 参照）:

- **schema / migration / package.json / package-lock.json / env の差分は 0** → `prisma migrate deploy` は**不要（no-op／実行しない）**。
- 本番**ランタイム挙動**を変えるのは **`field-survey-map.tsx`（#153 provider 移行）1 ファイルのみ**。
- 新規 production lib（retro EXIF strip core / CLI）と script は **app / components から未配線 = 本番実行導線なし**。

---

## 2. 対象 PR 一覧（`08af869..59c03b7`・merge 順）

| PR | merge commit | 種別 | 内容 | 本番ランタイム影響 |
|---|---|---|---|---|
| **#147**（19-A） | `330c562` | **test-only** | uploads 認可・キャッシュ回帰テスト（401 / registry ETag 不発行ロック） | なし |
| **#148**（19-C） | `a304501` | **production code・本番実行導線なし** | retro EXIF strip **core lib**（`src/lib/field-survey/retro-exif-strip.ts`）+ test | なし（未配線） |
| **#149**（19-B） | `6cc2e3c` | **docs-only** | field-survey 実機検証チェックリスト | なし |
| **#150**（19-A） | `be4bda2` | **test-only** | permissions direct fetch allowlist source assertion | なし |
| **#151**（19-B） | `6b1a53e` | **docs-only** | permissions provider migration runbook | なし |
| **#152**（19-C） | `977e491` | **dry-run CLI 導線**（apply なし） | retro EXIF strip **dry-run CLI**（`scripts/retro-exif-strip-field-survey.ts` + `src/lib/field-survey/retro-exif-strip-cli.ts`）+ test + runbook | なし（手動 tsx 起動のみ・`--apply` は parse error） |
| **#153**（19-A） | `59c03b7` | **production UI / provider 移行** | field-survey-map の provider 移行（`field-survey-map.tsx` の直接 fetch 撤去 → `useScreenProtection`） | **あり（唯一）** |

変更ファイル全体（`08af869..59c03b7`・`git diff --name-status`）:

```
A docs/field-survey-photo-device-verification-checklist.md       (#149 docs)
A docs/field-survey-retro-exif-strip-runbook.md                  (#152 docs)
A docs/permissions-provider-migration-checklist.md               (#151 docs)
A scripts/retro-exif-strip-field-survey.ts                       (#152 dry-run CLI entry・235/0)
M src/components/field-survey/field-survey-map.tsx               (#153 provider 移行・87/58)★唯一のランタイム変更
M src/lib/__tests__/field-survey-pin-ui-source.test.ts           (#153 test)
A src/lib/__tests__/field-survey-retro-exif-strip-cli.test.ts    (#152 test)
A src/lib/__tests__/field-survey-retro-exif-strip.test.ts        (#148 test)
A src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts   (#150 で追加・#153 で allowlist 4→3 更新・test)
M src/lib/__tests__/permissions-provider-distribution.test.ts    (#153 test・distribution 配列から field-survey-map 除外)
A src/lib/field-survey/retro-exif-strip-cli.ts                   (#152 lib・413/0・未配線)
A src/lib/field-survey/retro-exif-strip.ts                       (#148 で追加・#152 でも更新・485/0 net・未配線)
M src/lib/storage/__tests__/uploads-route.test.ts                (#147 test)
```

> ⚠ `prisma/**` / `package.json` / `package-lock.json` / `.env` 系の差分は**この一覧に存在しない**（実測で 0 件）。

---

## 3. 反映リスク分類

| 分類 | 対象 | 反映時の扱い |
|---|---|---|
| **test-only** | #147 / #150（+ 各 PR の test 追加） | 本番ランタイム不変。build 対象だが挙動変更なし |
| **docs-only** | #149 / #151（+ #152 の runbook） | 本番ランタイム不変。VPS 反映自体は本来不要（バッチに同梱されるだけ） |
| **production code だが本番実行導線なし** | #148（core lib）/ #152（CLI lib） | app / components から import されず、ルートにも載らない。**ビルドに含まれるが実行されない**。手動 `tsx` 起動でのみ動く（dry-run・別承認） |
| **production UI / provider 移行** | **#153 field-survey-map.tsx** | **唯一のランタイム変更**。field-survey マップの権限取得を直接 fetch → `useScreenProtection` 経由へ。挙動同等を狙った移行（§7 で要スポット確認） |
| **dry-run CLI 導線** | #152 `scripts/retro-exif-strip-field-survey.ts` | 反映後も**存在確認のみ**。本番 dry-run 実行は別承認（§9）。`--apply` は未実装で parse error |

---

## 4. VPS 運用 絶対ルール（必読・厳守）

- **VPS 上で root による git コマンドは禁止**（`git status` / `git rev-parse` 等の read-only 確認も含む）。
  - 理由: root で git を実行すると、stat-cache refresh により **`.git/index` が root 所有で再生成**され、
    以降の www-data の git 操作が `insufficient permission` 等で壊れる（過去に再発・対策確立済み）。
- **read-only 確認も含め、すべての git コマンドは www-data で実行する**:

  ```
  sudo -u www-data HOME=/var/www git <subcommand> ...
  ```

- **npm / npx / prisma / build / prune も app user で実行**（root 実行すると npm cache / build artifacts / generated Prisma / node_modules 生成物が root 所有になる）。
  - **app.env 取り扱い（重要）**: `/etc/property-management/app.env` は **`root:root 600`** で **www-data からは読めない**。
    **app.env は root 側で先に source し、`sudo -E` で env を www-data 実行コマンドへ引き継ぐ**（www-data シェル内で直接 `source` しない）。
  - **build にも app.env を渡す（必須）**: `FieldSurveyMapClient` が読む `NEXT_PUBLIC_GOOGLE_MAPS_*` は **build 時に bundle へ埋め込まれる**。
    build 時に env が無いと、systemd restart 時に env が正しくても **bundle 側の map key / map ID / billing flag が欠落**し得る。
  - **npm ci / prune**（app.env 不要・cache/artifacts を root 所有にしないため app user 固定）:

  ```
  sudo -u www-data HOME=/var/www npm_config_cache=/var/www/.npm npm -C /opt/property-management <args>
  ```

  - **Prisma 系 / build**（cwd 固定 + app.env を root source → `sudo -E` で引き継ぎ）。
    `npx --prefix` はバイナリ解決のみで `prisma/schema.prisma` / `DATABASE_URL` を保証しないため使わない:

  ```
  set -a
  source /etc/property-management/app.env   # root:root 600 → root で source（www-data から直接 source しない）
  set +a
  sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && <cmd>'
  ```

- **root で実行してよいのは管理・確認系のみ**: `systemctl` / `journalctl` / `curl` / `ls -l .git/index`。
  git / npm / npx / prisma / build / prune を root で実行しない（コピペ用コマンドは §6 で wrapper 付き）。
- `.git/index` が root:root 混在になっていたら、**ユーザー明示承認を得てから** `chown www-data:www-data .git/index` で単体修復
  （「権限変更」に該当・自動実行しない）。`.git/objects` が www-data 所有なら index 単体混在は ff merge の atomic rename で自己修復することもある。
- 接続: `ssh root@133.117.72.225`（root ログインは可。ただし**git / npm / npx / prisma は必ず www-data 経由**）。
- VPS path `/opt/property-management` / service `property-management`（pm2 不使用）/ env `/etc/property-management/app.env`（root:root 600・読み取りのみ）/ HOME `/var/www` / npm cache `/var/www/.npm` / node v20 系。

---

## 5. 反映前チェック（read-only・すべて www-data git）

- [ ] **VPS HEAD** が `08af869`（記録上の最終反映）と一致 — `sudo -u www-data HOME=/var/www git -C /opt/property-management rev-parse HEAD`
- [ ] **VPS git status** が clean（未コミット差分なし） — `sudo -u www-data HOME=/var/www git -C /opt/property-management status --short`
- [ ] **`.git/index` の owner** が `www-data:www-data` — `ls -l /opt/property-management/.git/index`（root 混在なら §4 で承認後 chown）
- [ ] **service status** が active/running — `systemctl status property-management`（現 MainPID を控える）
- [ ] **curl /** が 307 → `/login?callbackUrl=%2F` — `curl -I http://localhost:3000/`
- [ ] **disk 容量**に余裕（build / node_modules 用） — `df -h /opt`
- [ ] **env 差分なし**確認: 今回バッチに `.env` 系差分は 0。`/etc/property-management/app.env` は不変・触らない（読み取りのみ）。
      ただし **app.env は `root:root 600` で www-data から読めない**ため、prisma / build は **root で source → `sudo -E` で引き継ぐ**（§4・§6）
- [ ] **このrunbookは `08af869..59c03b7` 専用**。反映時に **`origin/main` が `59c03b7` 以外なら停止**（後続 commit を未レビューで含めない・§6-2・§8）。
      後続 commit を含めたい場合は、**新しい差分範囲で本チェックリストを作り直す**
- [ ] **package / lock / migration の有無**: 今回バッチは **package.json / package-lock.json / prisma 差分が 0**（§2 で実測）
- [ ] **今回 migrate が必要か不要か**: **不要**（新規 migration 0 件。`prisma migrate deploy` は実行しない／実行しても no-op）
- [ ] **npm install 方針**: **devDeps 込み**（`--include=dev`）。build が `vitest.config.ts` を型チェックするため `--omit=dev` での build は失敗する既知の落とし穴（コマンド全体は §6）
- [ ] **build 方針**: devDeps 込みで build → 成功後に `--omit=dev` で prune（コマンド全体は §6）。
      **build には app.env を渡す**（`NEXT_PUBLIC_GOOGLE_MAPS_*` は build 時に bundle へ埋め込まれる。restart 時だけ env があっても不十分）

---

## 6. 反映手順案（コマンド例は参考・**実行はしない**）

> **コピペ用コマンド自体に app user wrapper を含めてある**（root SSH 後にそのまま貼っても root 実行にならない形）。
> - git / npm / npx / prisma / build / prune は **すべて `sudo -u www-data HOME=/var/www npm_config_cache=/var/www/.npm ...`** で実行する。
> - **root で実行してよいのは `systemctl` / `journalctl` / `curl` / `ls -l .git/index` など管理・確認系のみ**。
> - 実行はユーザー承認後に別タスクで行う（本書では実行しない）。

1. **fetch**（www-data）:
   ```
   sudo -u www-data HOME=/var/www git -C /opt/property-management fetch origin --prune
   ```
2. **反映対象の確認 → merge は明示 commit `59c03b7` に pin**（`origin/main` を直接 merge しない）:
   ```
   sudo -u www-data HOME=/var/www git -C /opt/property-management rev-parse origin/main
   # 出力が 59c03b7 で始まることを確認。違う場合は停止（§8）= 後続 commit を未レビューで含めない
   sudo -u www-data HOME=/var/www git -C /opt/property-management merge --ff-only 59c03b7
   ```
   （`08af869` は `59c03b7` の祖先なので ff 可。`origin/main` が `59c03b7` より先に進んでいたら**停止し、新差分範囲でチェックリストを作り直す**）
3. **npm ci**（devDeps 込み・lock 不変前提。EBADENGINE warning は node>=22 要求パッケージの既知非致命）:
   ```
   sudo -u www-data HOME=/var/www npm_config_cache=/var/www/.npm npm -C /opt/property-management ci --include=dev
   ```
4. **prisma generate**（client 再生成＝DB 操作ではない・schema 不変でも安全）。
   cwd 固定 + **app.env は root で source → `sudo -E` で引き継ぐ**（www-data は app.env を読めないため）:
   ```
   set -a
   source /etc/property-management/app.env
   set +a
   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npx prisma generate'
   ```
5. **prisma migrate deploy は実行しない**（新規 migration 0 件）。安全のため status のみ確認可（pending が出たら停止＝§8）。
   **`migrate status` は `DATABASE_URL` が必要**。app.env を root で source → `sudo -E` で引き継ぐ:
   ```
   set -a
   source /etc/property-management/app.env
   set +a
   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npx prisma migrate status'
   ```
6. **build**（exit 0 を確認）。**build にも app.env が必須**（`NEXT_PUBLIC_GOOGLE_MAPS_*` は build 時に bundle へ埋め込まれる。
   build 時に env が無いと restart 時に env が正しくても bundle 側で欠落し得る）。root で source → `sudo -E` で引き継ぐ:
   ```
   set -a
   source /etc/property-management/app.env
   set +a
   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npm run build'
   ```
7. **prune**:
   ```
   sudo -u www-data HOME=/var/www npm_config_cache=/var/www/.npm npm -C /opt/property-management prune --omit=dev
   ```
   - その後 **package-lock.json のみ dirty**（npm メタデータ `libc` churn 等）になりがち →
     `sudo -u www-data HOME=/var/www git -C /opt/property-management restore package-lock.json` で clean に戻す（lock の実依存は不変）
8. **systemd restart**（root 可）: `systemctl restart property-management`（OLD→NEW MainPID を控える。停止時 journal の `status=143` は SIGTERM 正常 graceful）
9. **journal 確認**（root 可）: `journalctl -u property-management -n 50` で「✓ Ready in …ms」、`journalctl -u property-management -p err -n 50` が 0 件
10. **curl 確認**（root 可）: `curl -I http://localhost:3000/` が 307 → `/login`

---

## 7. 反映後スポット確認

無認証でも到達確認できるもの（307 / 200 / 401 の期待値）と、認証付きが要るものを分けて記す。

- [ ] **`/login`**: 200（ログイン画面表示）
- [ ] **`/properties`**: 307 → `/login`（無認証ゲート）
- [ ] **`/api/me/permissions`**: 307 → `/login`（無認証ゲート。認証時は `{ permissions, capabilities }` を返す）
- [ ] **`/uploads/...`**: **401**（無認証は認可前に弾く。If-None-Match 付き無認証も 401 = 認可前 304 なし）
- [ ] **`/field-survey`（map ページ）**: 307 → `/login`（無認証）。認証後はマップ表示（HTTPS 未構成のため位置情報は N/A は既知・別件）
- [ ] **field-survey map（#153 = 唯一のランタイム変更・要重点確認）**: 認証後、ピン追加トグル・他人 pin 削除 UI が権限どおり。
      provider 移行で**権限取得が直接 fetch → `useScreenProtection` 経由**に変わったため、**add/write 系（判定不能でも押下可・最終 403）と
      delete/manage 系（`canManagePin === true` のときだけ削除 UI・stale 中も露出しない fail-closed）**が従来どおりか確認
- [ ] **admin 権限画面**: 認証後（admin）に権限テンプレート画面・透かし等が従来どおり
- [ ] **retro EXIF strip CLI**: **存在確認のみ**（`scripts/retro-exif-strip-field-survey.ts` がツリーに在る）。
      **dry-run の本番実行は別承認**（§9）。誤って `--apply` しても未実装で parse error になる

> 認証付き確認（field-survey map の実権限挙動・admin 画面・upload 成功系）は資格情報が要るため、
> 反映タスク内で資格情報がなければ**テストロック済み**を根拠に「未実施」と明記し、ユーザー実機確認を推奨する。

---

## 8. 停止条件（1 つでも該当したら反映を止めて報告）

- [ ] **VPS git status dirty**（未コミット差分・想定外ファイル）
- [ ] **`.git/index` owner 異常**（root:root 混在）→ §4 のとおり承認を得るまで進めない
- [ ] **`origin/main` が `59c03b7` 以外**（fetch 後 `rev-parse origin/main` が `59c03b7` で始まらない）。
      後続 commit を未レビューで VPS に入れないため**停止**し、新差分範囲でチェックリストを作り直す。**本runbookは `08af869..59c03b7` 専用**
- [ ] **ff-only 不可**（`08af869` が `59c03b7` の祖先でない＝VPS が想定外に進んでいる/分岐）
- [ ] **package / lock 差分が想定外**（今回は 0 のはず。`npm ci` 後に lock が実依存レベルで変わる等）
- [ ] **build 失敗**（`npm run build` exit≠0。`--omit=dev` での実行になっていないか先に疑う）
- [ ] **migration 要求が出る**（`migrate status` に pending が出る＝想定外。今回は 0 件のはず）
- [ ] **service restart 失敗**（active/running にならない・MainPID が立たない）
- [ ] **journal error**（`journalctl -p err` に非良性エラー。`status=143` SIGTERM・旧 PID の "Server Action x" probe は良性）
- [ ] **curl 異常**（`/` が 307→`/login` にならない・5xx）
- [ ] **`/uploads` 認可異常**（無認証で 200 が返る＝認可バイパス）
- [ ] **permissions provider 周りの表示異常**（field-survey map で stale 権限ボタン・削除 UI 露出・add トグル不動作 等）

異常時の rollback: `sudo -u www-data HOME=/var/www git -C /opt/property-management checkout 08af869`（**reset は使わない**）→ 再 build → restart。
今回 migration は 0 件のため DB 巻き戻しは不要。

---

## 9. 未実施・別承認事項（このバッチ反映に含めない）

- retro EXIF strip **`--apply`**（実書き込み）= **未実装・別 PR / 別承認**（PR-R2b 予定）
- **旧 key cleanup**（遡及 strip 後の旧バイト削除）= 別承認（PR-R2c 予定）
- **本番 dry-run inventory 実行**（`scripts/retro-exif-strip-field-survey.ts` の実走査）= 別承認（read のみだが本番 storage / DB 走査のため）
- **HTTPS 構成**（field-survey の位置情報・カメラ・実機検証の前提）= 別タスク
- **成功系アップロード検証**（実画像 upload → EXIF strip → 配信）= 認証付き実機・別タスク
- **認証付き手動チェック未完了分**（field-survey map 実権限挙動・admin 画面・CSV/DM・watermark・ETag/304 実挙動）= 資格情報が要る・ユーザー実機

---

## 10. 報告テンプレート（反映タスク実行時）

```markdown
## VPS まとめ反映 報告（08af869 → 59c03b7）

- 反映前 HEAD:（例 08af869・www-data git で確認）
- origin/main 一致確認:（rev-parse origin/main == 59c03b7 か。違えば停止した旨）
- 反映後 HEAD:（例 59c03b7・明示 commit pin で merge）
- 実行コマンド:（www-data wrapper 付き: fetch / merge 59c03b7 / npm ci --include=dev / prisma generate / build / prune / git restore lock / restart の要点）
- build 結果:（exit code・所要）
- service 結果:（OLD→NEW MainPID・active/running）
- curl 結果:（/ → 307 /login ・主要パスの status）
- journal 結果:（Ready in …ms ・ -p err 件数・良性 status=143 の有無）
- migration:（今回 0 件・migrate deploy 未実行 / no-op）
- package/lock:（差分 0・prune 後 lock churn は git restore で clean）
- スポット確認:（§7 の各項目の結果。認証付き未実施分は明記）
- 未実施:（§9 該当・retro --apply / dry-run 実行 / 認証付き確認 等）
- rollback 要否:（不要 / 要・理由）
- 停止条件 該当有無:（なし / 該当項目）
```

---

## 付録: 関連ドキュメント

- 標準 deploy 手順: `docs/deploy.md`（Option C = devDeps 込み ci → generate → build → prune）
- field-survey 実機検証（HTTPS 後）: `docs/field-survey-photo-device-verification-checklist.md`（#149）
- permissions provider 移行 runbook: `docs/permissions-provider-migration-checklist.md`（#151）
- retro EXIF strip dry-run runbook: `docs/field-survey-retro-exif-strip-runbook.md`（#152）
