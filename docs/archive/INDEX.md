# docs/archive — 完了済みドキュメント アーカイブ索引

このディレクトリは、**完了済みの実装計画・作業ログ・運用 runbook** を保管する場所である。

- ここにある文書は **履歴参照用**であり、対応する作業は既に完了（PR merged 等）している。
- **現行作業で最初に読む必要はない**。現役の運用ルールは `CLAUDE.md` / `AGENTS.md`、デプロイ手順は `docs/deploy.md`、運用フローは `docs/ai-workflow.md` を参照すること。
- 文書は削除せず `git mv` で移動して保管しており、git 履歴は保持されている。

## plans/ — 完了済み実装計画

| ファイル | 内容（何の作業ログか） | 状態 |
|---|---|---|
| `plans/2026-06-13-corporate-number-cleanup.md` | 法人番号 混入除去（local cleanup）実装計画（21-D タスク11 / P1）。owner の name/address/note に紛れ込んだ会社法人等番号の検出・移送・除去の preview→apply 設計と Codex 対応ログ。 | **完了**（対応 PR は merge 済み）。履歴参照用。 |
| `plans/2026-06-13-property-address-dm-export.md` | 物件宛 DM export 新設の実装計画（21-D タスク7）。物件住所宛 DM 差込 CSV の新 route/lib 設計と Codex 対応ログ。 | **完了**（対応 PR は merge 済み）。履歴参照用。 |

> 上記2文書は repo 全体で被リンク0（ソース/テスト/他 docs からの参照なし）を確認したうえでアーカイブした。
> 被リンクのある完了済み文書（field-survey 系 runbook / 権限移行 checklist / uploads 配信負荷 plan 等）は、参照元の更新を伴うため本アーカイブには含めていない（別途検討）。
