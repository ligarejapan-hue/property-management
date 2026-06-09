# VPS まとめ反映チェックリスト（`fb3e930` → `d1cb908`）

VPS 最終反映済み HEAD `fb3e930`（= PR #155 merge・Approach A で反映済み）以降に main へ merge された
**PR #154 / #156 / #157 / #158 / #159** を、VPS（本番）へ安全に**まとめて反映**するための手順書。

これは手順書（docs-only）であり、**本ファイルの作成時点で VPS 操作は一切行っていない**。
実際の反映は、ユーザーが `systemctl restart` 等を**明示承認**した後に別タスクで実行する。

- 反映元: `fb3e930`（VPS 現 HEAD・記録上 = PR #155 merge commit）
- 反映先: `d1cb908`（= local main == origin/main・現時点・PR #159 merge commit、full SHA `d1cb9087ac72d7f3059846aa329ba42fed97364b`）
- 反映元 full SHA: `fb3e9301bc249d89628e4aaa71ae38437300a2f4`
- 基準ルール: CLAUDE.md §13・`docs/deploy.md`・運用知見（本書はそれらを今回バッチ向けに具体化する索引）
- **先行 runbook `docs/vps-release-checklist-08af869-to-fb3e930.md` は完了済み（`08af869→fb3e930` 反映用）であり、本書はその参考資料扱い。再利用ではなく新規。**

> ⚠ 本書の手順・コマンド例は**載せるが実行しない**。read-only 確認すら**root では行わない**（§4）。

---

## 1. 反映範囲

- **from**: `fb3e930`（`fb3e9301bc249d89628e4aaa71ae38437300a2f4`）
- **to**: `d1cb908`（`d1cb9087ac72d7f3059846aa329ba42fed97364b`）
- 範囲: `fb3e930..d1cb908`（= `fb3e930..origin/main`・現時点で一致。実測 16 ファイル / +3107 / −262）
- 対象 PR（merge 順・新しい→古い）:

  | PR | merge commit | 種別 | 内容 |
  |---|---|---|---|
  | **#159** | `d1cb908` | feat（CLI/tooling） | retro EXIF strip **cleanup dry-run 列挙**（PR-R2c-i）。20-C で merge / cleanup / post-merge 裏取り済み |
  | **#158** | `9516967` | docs-only | CLAUDE.md §23（疑似ツール呼び出し例の生タグ列を散文化） |
  | **#157** | `ab4312f` | feat（**Web runtime UI**） | `properties/[id]` permissions を ScreenProtectionProvider 経由へ移行（F12 third impl・19-A） |
  | **#156** | `4a65ad0` | feat（CLI/tooling） | retro EXIF strip **`--apply`** 実装（PR-R2b） |
  | **#154** | `cbcdfe2` | docs-only | `08af869→fb3e930` 反映 release checklist（= *先行反映の完了記録*） |

- **#156 / #159 は CLI / tooling**（`scripts/*` + `src/lib/field-survey/retro-exif-strip*`）。app / components から **未配線**で、**手動 `tsx` 起動しない限り Web runtime 経路では一切動かない**。ビルドに同梱されるだけで本番リクエスト挙動には影響しない。
- **#157 が本範囲で唯一の Web runtime UI 変更**。`properties/[id]` の権限取得を直接 fetch → `useScreenProtection` 経由へ移行（既存 UX 維持が前提）。これに伴い直接 fetch allowlist は **canonical provider のみへ減少**（#153=map / #155=admin owners / #157=properties detail で 3 画面の移行が完了）。

---

## 2. 対象 PR 別 変更ファイル（`fb3e930..d1cb908`・`git diff --name-status`）

```
M CLAUDE.md                                                      (#158 docs)
M docs/field-survey-retro-exif-strip-runbook.md                  (#156 / #159 で更新・docs)
A docs/vps-release-checklist-08af869-to-fb3e930.md               (#154 docs・先行反映の完了記録)
A scripts/retro-exif-strip-cleanup-field-survey.ts               (#159 CLI entry・未配線)
M scripts/retro-exif-strip-field-survey.ts                       (#156 --apply 追加・未配線)
M src/app/(dashboard)/properties/[id]/page.tsx                   (#157 provider 移行)★Web runtime 変更
M src/lib/__tests__/corporate-lookup-ui.test.ts                  (#157 test)
A src/lib/__tests__/field-survey-retro-exif-strip-cleanup.test.ts(#159 test)
M src/lib/__tests__/field-survey-retro-exif-strip-cli.test.ts    (#156 test)
M src/lib/__tests__/owner-edit.test.ts                           (#157 test)
M src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts   (#157 test・allowlist 縮小)
M src/lib/__tests__/permissions-provider-distribution.test.ts    (#157 test)
A src/lib/__tests__/properties-detail-permissions-provider.test.ts(#157 test)
M src/lib/__tests__/registry-auto-fetch-ui.test.ts               (#157 test)
A src/lib/field-survey/retro-exif-strip-cleanup.ts               (#159 lib・未配線)
M src/lib/field-survey/retro-exif-strip-cli.ts                   (#156 lib・未配線)
```

> ⚠ `prisma/**` / `*.prisma` / `prisma.config.ts` / `package.json` / `package-lock.json` / `.env` 系の差分は
> **この一覧に存在しない**（`git diff --name-only fb3e930..d1cb908 -- <sensitive paths>` が空＝実測 0 件）。

---

## 3. 反映リスク分類

| 分類 | ファイル数 | 対象 | 反映時の扱い |
|---|---|---|---|
| **Web runtime（配信経路・UI）** | 1 | `src/app/(dashboard)/properties/[id]/page.tsx`（#157） | **本範囲唯一の実行時挙動変更**。権限取得を直接 fetch → `useScreenProtection` 経由へ。挙動同等を狙った移行（§6 でスポット確認）。build + restart 必須 |
| **CLI / tooling（production code だが本番実行導線なし）** | 4 | `scripts/retro-exif-strip-field-survey.ts`・`src/lib/field-survey/retro-exif-strip-cli.ts`（#156）/ `scripts/retro-exif-strip-cleanup-field-survey.ts`・`src/lib/field-survey/retro-exif-strip-cleanup.ts`（#159） | app / components から未 import・ルートに載らない。**ビルドに含まれるが実行されない**。手動 `tsx` 起動でのみ動く（実行は別承認＝§7） |
| **docs-only** | 3 | CLAUDE.md（#158）/ `docs/field-survey-retro-exif-strip-runbook.md`（#156/#159）/ `docs/vps-release-checklist-08af869-to-fb3e930.md`（#154） | 本番ランタイム不変。VPS 反映自体は本来不要（バッチに同梱されるだけ・§13） |
| **tests-only** | 8 | `src/lib/__tests__/...`（#156=1・#157=6・#159=1） | 配信成果物に含まれず、本番ランタイム不変。build 対象だが挙動変更なし |

**結論**: 本番ランタイム挙動を変えるのは **#157 の 1 ファイルのみ**。schema / migration / package / lock / env 差分 0 のため `prisma migrate deploy` は不要（§5）。

---

## 4. VPS 運用 絶対ルール（必読・厳守）

- **VPS 上で root による git コマンドは禁止**（`git status` / `git rev-parse` 等の read-only 確認も含む）。
  - 理由: root で git を実行すると stat-cache refresh で **`.git/index` が root 所有で再生成**され、以降の www-data の git 操作が `insufficient permission` で壊れる（過去に再発・対策確立済み）。
- **read-only 確認も含め、すべての git コマンドは www-data で実行する**:

  ```
  sudo -u www-data HOME=/var/www git -C /opt/property-management <subcommand> ...
  ```

- **npm / npx / prisma / build / prune も app user で実行**（root 実行すると npm cache / build artifacts / generated Prisma / node_modules が root 所有になる）。
  - **app.env 取り扱い（重要）**: `/etc/property-management/app.env` は **`root:root 600`** で **www-data からは読めない**。
    **app.env は root 側で先に source し、`sudo -E` で env を www-data 実行コマンドへ引き継ぐ**（www-data シェル内で直接 `source` しない）。
  - **build にも app.env を渡す（必須）**: `NEXT_PUBLIC_*`（map key / map ID / billing flag 等）は **`npm run build` 時に bundle へ埋め込まれる**。
    build 時に env が無いと、systemd restart 時に env が正しくても **bundle 側で欠落**し得る。
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
  git / npm / npx / prisma / build / prune を root で実行しない。
- **target は full SHA で pin する**。`origin/main` を無条件追従しない（§6-2）。
- **reset / clean / force-push は使わない**（rollback も checkout ベース・§7）。
- `.git/index` が root:root 混在になっていたら、**ユーザー明示承認を得てから** `chown www-data:www-data .git/index` で単体修復（自動実行しない）。
- VPS path `/opt/property-management` / service `property-management`（pm2 不使用）/ env `/etc/property-management/app.env`（root:root 600・読み取りのみ）/ HOME `/var/www` / npm cache `/var/www/.npm`。

---

## 5. npm / prisma 方針（依存・migration の確定）

`fb3e930..d1cb908` の実測に基づく確定方針:

- **package / lock 差分**: **0 件**（`git diff --name-only fb3e930..d1cb908 -- package.json package-lock.json` が空）。→ **依存変更なし**。
- **`npm ci` の要否**: 依存差分が 0 のため厳密には新規依存導入はないが、**build が devDeps を要求**（`vitest.config.ts` の型チェックを通すため `--omit=dev` build は失敗する既知の落とし穴）し、node_modules を lock と完全一致させる安全策として **`npm ci --include=dev` を推奨**。lock 不変のため新規依存は入らない。
- **`prisma migrate deploy`**: **絶対に実行しない**（新規 migration 0 件。実行しても no-op だが、運用上 deploy 自体を入れない）。
- **`prisma generate` の要否（根拠つき）**: `schema.prisma` 差分 0 のため Prisma client の生成結果は**機能的に不変**。ただし `npm ci` で `@prisma/client` が再インストールされた後の client 生成を確実化するため、**安全側で `npx prisma generate` を実行**してよい（DB 操作ではない・schema 不変なら出力同等）。省略しても機能差は出ないが、迷う場合は実行する。
- **`prisma migrate status`（read-only 確認）**: 安全側で実行してよい。**pending migration が出たら想定外＝停止（§8）**。今回は「up to date」想定。
- 上記いずれも **DB への書き込みは発生しない**（generate = client 生成、migrate status = 参照、migrate deploy = 不実行）。

---

## 6. 反映手順案（コマンド例は参考・**実行はしない**）

> コピペ用コマンド自体に app user wrapper を含めてある（root SSH 後にそのまま貼っても root 実行にならない形）。
> 実行はユーザー承認後に別タスクで行う（本書では実行しない）。

1. **fetch**（www-data）:
   ```
   sudo -u www-data HOME=/var/www git -C /opt/property-management fetch origin --prune
   ```
2. **target を full SHA `d1cb908` に pin して ff-only merge**（`origin/main` を直接 merge しない）:
   ```
   sudo -u www-data HOME=/var/www git -C /opt/property-management rev-parse origin/main
   # 出力が d1cb9087ac72d7f3059846aa329ba42fed97364b と一致することを確認。違えば停止（§8）
   sudo -u www-data HOME=/var/www git -C /opt/property-management merge --ff-only d1cb9087ac72d7f3059846aa329ba42fed97364b
   ```
   （`fb3e930` は `d1cb908` の祖先＝ff 可を実測済み。`origin/main` が `d1cb908` より先に進んでいたら**停止し、新差分範囲でチェックリストを作り直す**）
3. **npm ci**（devDeps 込み・lock 不変前提。EBADENGINE warning は既知非致命）:
   ```
   sudo -u www-data HOME=/var/www npm_config_cache=/var/www/.npm npm -C /opt/property-management ci --include=dev
   ```
4. **prisma generate**（client 再生成＝DB 操作ではない・schema 不変でも安全・§5）。cwd 固定 + app.env を root source → `sudo -E`:
   ```
   set -a
   source /etc/property-management/app.env
   set +a
   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npx prisma generate'
   ```
5. **prisma migrate status**（read-only 確認のみ。pending が出たら停止＝§8）。**migrate deploy は実行しない**:
   ```
   set -a
   source /etc/property-management/app.env
   set +a
   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npx prisma migrate status'
   ```
6. **build**（exit 0 を確認）。**build にも app.env が必須**（`NEXT_PUBLIC_*` は build 時に bundle へ埋め込まれる）。root で source → `sudo -E`:
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
   - その後 **package-lock.json のみ dirty**（npm メタデータ churn）になりがち →
     `sudo -u www-data HOME=/var/www git -C /opt/property-management restore package-lock.json` で clean に戻す（lock の実依存は不変）
8. **systemd restart**（root 可）: `systemctl restart property-management`（OLD→NEW MainPID を控える。停止時 journal の `status=143` は SIGTERM 正常 graceful）
9. **journal 確認**（root 可）: `journalctl -u property-management -n 50` で「✓ Ready in …ms」、`journalctl -u property-management -p err -n 50` が 0 件
10. **curl / スポット確認**（§7）

---

## 7. 反映後 smoke check

無認証で到達確認できるもの（307 / 200 / 401 の期待値）と、認証付きが要るものを分けて記す。
**root で `curl` 可。git 系は www-data。**

- [ ] **`/`**: 307 → `/login?callbackUrl=%2F` — `curl -I http://localhost:3000/`
- [ ] **`/login`**: 200（ログイン画面表示）
- [ ] **`/properties`**: 307 → `/login`（無認証ゲート）
- [ ] **`/properties/<id>`（#157 = 本範囲唯一の runtime 変更・要重点）**: 無認証は 307 → `/login`（認証前 redirect を確認）。
      認証後（別途実機）に property 詳細の権限依存 UI が従来どおりか確認 —
      provider 移行で**権限取得が直接 fetch → `useScreenProtection` 経由**に変わったため、
      **owner 情報の表示/編集（owner-edit）・登記簿自動取得（registry-auto-fetch）・法人番号 lookup（corporate-lookup）**が stale 権限で一瞬でも露出/不動作しないこと（変更テストの対象 UI）
- [ ] **`/api/me/permissions`**: 無認証 307 → `/login`（認証時は `{ permissions, capabilities }` を返す）
- [ ] **`/field-survey/map`**: 無認証 307 → `/login`（#153 で反映済み・回帰確認。HTTPS 未構成のため位置情報 N/A は既知別件）
- [ ] **`/admin/owners/1`**: 無認証 307 → `/login`（#155 で反映済み・回帰確認）
- [ ] **`/uploads/probe`**: 到達確認（status を記録）。`/uploads` 系は**無認証で認可前に弾く設計（401 を基本期待値）**。probe が意図的に public なら期待値が異なるため、反映タスク時に実機期待値を確定する
- [ ] **`/uploads`（`If-None-Match` 付き・無認証）**: **401**（認可前に弾くため無認証では 304 を返さない）
- [ ] **journal 新規 error**: restart 後 `journalctl -u property-management -p err -n 50` が 0 件（`status=143` SIGTERM・旧 PID の probe は良性）

> 認証付き確認（property 詳細・field-survey map・admin 画面・upload 成功系の実権限挙動）は資格情報が要るため、
> 反映タスク内で資格情報がなければ**テストロック済み**を根拠に「未実施」と明記し、**20-A の spot check 整理またはユーザー実機**へ委ねる（§8 末尾・別管理）。

---

## 8. 停止条件（1 つでも該当したら反映を止めて報告）

- [ ] **VPS HEAD が `fb3e930` でない**（`rev-parse HEAD` が `fb3e9301...` で始まらない）
- [ ] **working tree が clean でない**（`git status --short` に未コミット差分・想定外ファイル）
- [ ] **`.git/index` 所有者が想定外**（root:root 混在）→ §4 のとおり承認を得るまで進めない
- [ ] **target `d1cb908` が存在しない**（fetch 後も `rev-parse d1cb9087...` が解決しない）
- [ ] **`fb3e930` が `d1cb908` の祖先でない**（ff-only 不可＝VPS が想定外に分岐/先行）
- [ ] **`origin/main` が `d1cb908` 以外**（fetch 後 `rev-parse origin/main` が `d1cb9087...` でない）。後続 commit を未レビューで入れないため停止し、新差分範囲で作り直す。**本 runbook は `fb3e930..d1cb908` 専用**
- [ ] **schema / migration / package / lock / env 差分が出る**（今回は 0 のはず。`npm ci` 後に lock が実依存レベルで変わる等）
- [ ] **app.env を build に渡せない**（`/etc/property-management/app.env` を root で source できない・`sudo -E` で引き継げない）
- [ ] **build 失敗**（`npm run build` exit≠0。`--omit=dev` build になっていないか先に疑う）
- [ ] **migrate status に pending**（想定外。今回は 0 件のはず）
- [ ] **service restart 失敗**（active/running にならない・MainPID が立たない）
- [ ] **smoke check 失敗**（`/` が 307→`/login` にならない・5xx・`/uploads` 無認証で 200＝認可バイパス・property 詳細の権限 UI 異常）
- [ ] **想定外の dirty diff**（反映中に対象外ファイルが変化）

異常時は §7 を中断し、現状（HEAD・status・journal 要点）を添えて報告する。

---

## 9. rollback

- **migration 0 件のため DB rollback は不要**（schema 不変・データ書き込みなし）。
- **rollback 先 = `fb3e930`**（`fb3e9301bc249d89628e4aaa71ae38437300a2f4`）。
- **方針（reset / clean / force を使わない・checkout ベース）**:
  1. www-data で `fb3e930` を checkout（detached HEAD）。**`git reset` は使わない**:
     ```
     sudo -u www-data HOME=/var/www git -C /opt/property-management checkout fb3e9301bc249d89628e4aaa71ae38437300a2f4
     ```
     （main ブランチは `d1cb908` のまま。緊急 rollback は detached で運用し、再前進時に改めて ff-only）
  2. **rollback 時も build に app.env を渡す**（`NEXT_PUBLIC_*` の bundle 埋め込みのため）。root source → `sudo -E`:
     ```
     set -a
     source /etc/property-management/app.env
     set +a
     sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm bash -lc 'cd /opt/property-management && npm run build'
     ```
  3. `systemctl restart property-management`（root 可）→ §7 の smoke check を再実行
- DB / storage の巻き戻しは**しない**（そもそも書き込んでいない）。

---

## 10. 未実施・別承認事項（このバッチ反映に含めない）

- **本番 retro EXIF `--apply` 実行はしない**（#156 の実書き込み・別承認 = PR-R2b 運用承認待ち）
- **cleanup dry-run / delete 実行はしない**（#159 の cleanup 列挙・実削除いずれも別承認 = PR-R2c 系運用承認待ち）
- **storage delete はしない**（旧 key 削除・本番 storage 走査を含め一切しない）
- **本番 dry-run inventory 実行はしない**（`scripts/retro-exif-strip-*` の実走査は read であっても本番 storage / DB 走査のため別承認）
- **認証付き spot check は 20-A または ユーザー実機で別管理**（property 詳細・field-survey map 実権限挙動・admin 画面・upload 成功系）。本書では無認証到達確認とテストロックまで。
- **HTTPS 構成**（field-survey の位置情報・カメラ前提）= 別タスク

---

## 11. 報告テンプレート（反映タスク実行時）

```markdown
## VPS まとめ反映 報告（fb3e930 → d1cb908）

- 反映前 HEAD:（例 fb3e930・www-data git で確認）
- origin/main 一致確認:（rev-parse origin/main == d1cb9087... か。違えば停止した旨）
- 反映後 HEAD:（例 d1cb908・full SHA pin で merge --ff-only）
- 実行コマンド:（www-data wrapper 付き: fetch / merge d1cb908 / npm ci --include=dev / prisma generate / migrate status / build / prune / git restore lock / restart の要点）
- build 結果:（exit code・所要）
- service 結果:（OLD→NEW MainPID・active/running）
- smoke check 結果:（§7 各パスの status。認証付き未実施分は明記）
- journal 結果:（Ready in …ms ・ -p err 件数・良性 status=143 の有無）
- migration:（今回 0 件・migrate deploy 未実行 / migrate status = up to date）
- package/lock:（差分 0・prune 後 lock churn は git restore で clean）
- 未実施:（§10 該当・retro --apply / cleanup / dry-run 実行 / 認証付き確認 等）
- rollback 要否:（不要 / 要・理由）
- 停止条件 該当有無:（なし / 該当項目）
```

---

## 付録: 関連ドキュメント

- 先行 runbook（完了済み・参考資料）: `docs/vps-release-checklist-08af869-to-fb3e930.md`（#154）
- 標準 deploy 手順: `docs/deploy.md`（Option C = devDeps 込み ci → generate → build → prune）
- retro EXIF strip runbook（#156/#159 で更新）: `docs/field-survey-retro-exif-strip-runbook.md`
- permissions provider 移行 runbook: `docs/permissions-provider-migration-checklist.md`（#151）
- field-survey 実機検証（HTTPS 後）: `docs/field-survey-photo-device-verification-checklist.md`（#149）
