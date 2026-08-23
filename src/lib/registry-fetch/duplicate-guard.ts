/**
 * 有料取得の**二重課金ガード**。
 *
 * 方式 (@codex #402 Blocker で確立):
 *   親の物件行を FOR UPDATE でロック → **新しい文**で現況を読む →
 *   `decidePurchaseLock`(純関数)で判定 → 同一 tx 内で予約(scheduled)を立てる。
 *
 * ⚠かつては条件を updateMany の一文(where 断片)に埋め込んでいたが、
 *   PostgreSQL の READ COMMITTED では「待ちの後の再評価は相手が行を書き換えた
 *   場合にしか起きない」「副問い合わせは文の開始時点のスナップショットで評価される」
 *   ため、待っている間にコミットされた添付が**原理的に見えなかった**
 *   (レビューが PostgreSQL 18 で実再現)。その方式(buildApprovedDuplicateGuard)は
 *   誤って再利用されないよう**削除済み**。
 * ⚠この方式が成立する前提=**添付を登録する全経路が親の物件行を先にロックする**
 *   (#402・走査テスト attachment-create-parent-lock.test.ts が全出現を守る)。
 * ⚠**承認した項目だけ**を検査する。警告を見たうえで意図して買い直す運用は許す
 *   (事前警告は「警告のみ・実行はブロックしない」設計)。
 */
export interface ApprovedPreflightFlags {
  /** 承認時、登記状況が「取得済」だったか。 */
  registryObtained: boolean;
  /** 承認時、謄本PDF(未削除)が添付されていたか。 */
  hasRegistryAttachment: boolean;
  /** 承認時、所有者が1名以上いたか。 */
  hasOwners: boolean;
}

/** 購入ロックの判定結果。 */
export type PurchaseLockDecision =
  /** 進んでよい(予約を立てる)。 */
  | { kind: "proceed" }
  /** 承認時に無かったもの(取得済/謄本PDF/所有者)が現れた=もう持っている。 */
  | { kind: "duplicate_appeared" }
  /** 検索キー項目(指紋)が変わった=別の対象になった。 */
  | { kind: "fingerprint_changed" }
  /** 予約中 or 並行更新(version 不一致) or 行が無い。 */
  | { kind: "already_running" };

/**
 * 購入の予約を立ててよいかの判定 (@codex #402 Blocker)。
 *
 * ⚠**入力は「親の物件行を FOR UPDATE でロックした後に、新しい文で読んだ値」**で
 *   なければならない。かつての実装は条件を UPDATE の一文に埋め込んでいたが、
 *   PostgreSQL の READ COMMITTED では:
 *   (1) 待ちの後の再評価(EvalPlanQual)は**相手が行を書き換えた場合**にしか起きない
 *       (添付側はロックするだけ=書き換えない)
 *   (2) 起きたとしても、別テーブルへの副問い合わせ(添付の有無)は
 *       **文の開始時点のスナップショット**で評価される
 *   ため、待っている間にコミットされた添付が**原理的に見えなかった**
 *   (レビューが PostgreSQL 18 で再現)。ロック→**新しい文**で読む→この関数で判定→
 *   同一 tx 内で更新、の順なら必ず見える。
 *
 * ⚠**判定の優先順位**: 重複 > 指紋 > 実行中。
 *   「実行中です」と言われた利用者は待って押し直すが、重複なら**もう持っている**
 *   のだから待っても解決しない(@codex #399 R5 P2 の弁別を引き継ぐ)。
 * ⚠approved が null(番号購入・回収)なら重複検査はしない(従来どおり)。
 *   approved=true の項目も検査しない(警告を見て意図して買い直す運用を許す)。
 */
export function decidePurchaseLock(input: {
  /** ロック後の読み直しで行が見つかったか。 */
  found: boolean;
  /** ロック後の registryStatus。 */
  registryStatus: string | null;
  /** ロック後の version が、事前読みの version と一致するか。 */
  versionMatches: boolean;
  /** 検索キー項目(指紋)の一致が要求されているか。 */
  fingerprintRequired: boolean;
  /** ロック後の指紋が期待値と一致するか(要求されていない場合は無視)。 */
  fingerprintMatches: boolean;
  /** 承認時の警告状態(null = 重複検査をしない経路)。 */
  approved: ApprovedPreflightFlags | null;
  /** ロック後: 登記状況が「取得済」か。 */
  obtainedNow: boolean;
  /** ロック後: 謄本PDF(未削除)が添付されているか。 */
  hasRegistryAttachmentNow: boolean;
  /** ロック後: 所有者が1名以上いるか。 */
  hasOwnersNow: boolean;
}): PurchaseLockDecision {
  if (input.approved) {
    const appeared =
      (!input.approved.registryObtained && input.obtainedNow) ||
      (!input.approved.hasRegistryAttachment && input.hasRegistryAttachmentNow) ||
      (!input.approved.hasOwners && input.hasOwnersNow);
    if (appeared) return { kind: "duplicate_appeared" };
  }
  if (input.fingerprintRequired && (!input.found || !input.fingerprintMatches)) {
    return { kind: "fingerprint_changed" };
  }
  if (
    !input.found ||
    input.registryStatus === "scheduled" ||
    !input.versionMatches
  ) {
    return { kind: "already_running" };
  }
  return { kind: "proceed" };
}
