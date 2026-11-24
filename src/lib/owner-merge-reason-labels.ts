/**
 * 所有者の統合が止まった理由（OwnerMergeBlockReason）→ 画面の日本語。
 *
 * 統合プレビューのボタンと「この1人に全部まとめる」の結果表示で同じ文言を使う（1か所に持つ）。
 * ⚠旧コード name_address_normalize_mismatch は、古い画面・古いサーバーの応答が混ざっても
 *   読めるよう残す（2026-11-24 に owner_identity_mismatch へ置き換え）。
 */
const MERGE_BLOCK_REASON_LABELS: Record<string, string> = {
  same_owner_id: "master と source が同一です",
  master_not_found: "master 所有者が存在しません",
  source_not_found: "source 所有者が存在しません",
  master_archived: "master 所有者がアーカイブ済みです",
  source_archived: "source 所有者がアーカイブ済みです",
  source_has_changelog: "source に手動編集履歴があります",
  source_has_note: "source に備考が入力されています",
  source_has_external_link_key: "source に外部リンクキーが設定されています",
  source_version_gt_1: "source に編集履歴があります（version > 1）",
  owner_identity_mismatch:
    "同じ所有者と確かめられません（氏名と住所・法人番号・法人名のどれも一致しません。別人の可能性）",
  corporate_number_conflict:
    "法人番号が食い違っています（別の法人の可能性。法人番号を確かめてください）",
  name_address_normalize_mismatch:
    "氏名・住所の正規化結果が一致しません（別人の可能性）",
  current_address_conflict:
    "現住所が食い違っています（どちらが新しいか決められません）",
  current_zip_conflict: "同じ現住所なのに郵便番号が食い違っています",
  version_mismatch:
    "他のユーザーが先に更新しました（version が変わっています）",
};

export function mergeBlockReasonLabel(reason: string): string {
  return MERGE_BLOCK_REASON_LABELS[reason] ?? reason;
}
