/**
 * 現住所を書くときの「ペアの規則」。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §6.1 / §6.1.1
 *
 * ## 規則
 * 1. `currentAddress` を書き換える処理は、**同じ操作で `currentZip` も決める**。
 *    対になる郵便番号が渡ってこなければ **`currentZip` を null にする**。
 * 2. **`currentZip` だけの更新はできない**（対になる住所が無いため）。
 *
 * ## なぜ必要か
 * 部分更新は「渡された項目だけ」を反映する。住所だけ送ると古い郵便番号が残り、
 * 宛先の解決（`resolveMailingAddress`）が**そのズレたペアを正しい宛先として採用**して
 * 「新しい住所に古い郵便番号」を刷った郵便物ができる。逆に郵便番号だけ送ると、
 * 既存の住所に**無関係な番号**が付く。
 *
 * ⚠ **形式を理由に郵便番号を捨てない**。`isValidPostalCode` は日本の7桁専用で、
 * 所有者の郵便番号は自由入力（海外の番号も入る）。構文だけでは「日本の書き損じ」と
 * 「正しい海外の番号」を区別できない。壊れた番号は品質チェックで人が直す。
 *
 * ⚠ 呼び出し側の責務: `impliesZipWrite` が true のとき、**`owner_zip` の書込権限を確認**する。
 * 暗黙のクリアも郵便番号への書き込みであり、権限が無ければ**住所の更新ごと 403 で拒否する**
 * （クリアだけ省略すると、住所が変わって古い番号が残る＝この規則が防ぎたい状態そのもの）。
 */

export interface CurrentAddressWriteInput {
  /** キーが存在すれば「指定された」とみなす（値が null でも指定扱い）。 */
  currentAddress?: string | null;
  currentZip?: string | null;
}

export type CurrentAddressWriteResult =
  | {
      ok: true;
      /** そのまま update に混ぜてよい項目。 */
      fields: { currentAddress?: string | null; currentZip?: string | null };
      /** true のとき、呼び出し側は owner_zip の書込権限を要求する。 */
      impliesZipWrite: boolean;
    }
  | { ok: false; reason: "zip_only" };

/**
 * 渡された項目からペアの規則を適用する。
 *
 * ⚠ 判定は**キーの有無**で行う（値が null でも「指定された」とみなす）。
 * `{ currentAddress: null }` は「現住所を未設定に戻す」という**明示の操作**なので、
 * 郵便番号も一緒に空にする。
 */
export function resolveCurrentAddressWrite(
  input: CurrentAddressWriteInput,
): CurrentAddressWriteResult {
  const hasAddress = "currentAddress" in input;
  const hasZip = "currentZip" in input;

  if (!hasAddress && !hasZip) {
    return { ok: true, fields: {}, impliesZipWrite: false };
  }

  // 郵便番号だけの更新は認めない（対になる住所が無い）。
  if (!hasAddress) {
    return { ok: false, reason: "zip_only" };
  }

  const currentAddress = input.currentAddress ?? null;

  if (hasZip) {
    // 明示的にペアで指定された。形式は見ない（海外の番号を捨てない）。
    return {
      ok: true,
      fields: { currentAddress, currentZip: input.currentZip ?? null },
      impliesZipWrite: true,
    };
  }

  // 住所だけ指定された → 対になる番号が無いので空にする。
  return {
    ok: true,
    fields: { currentAddress, currentZip: null },
    impliesZipWrite: true,
  };
}
