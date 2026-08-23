import { describe, expect, it } from "vitest";
import { decidePurchaseLock } from "@/lib/registry-fetch/duplicate-guard";

/**
 * 「承認したときに警告が無かったもの」を、課金を直列化するロックと**同じ一文**で検査する条件。
 *
 * ⚠なぜ要るか(@codex #399 R5 P2): 画面で取り直した警告は**別の問い合わせ**なので、
 *   相手の処理がまだ確定していない一瞬に読むと「警告なし」と返り、その直後に確定されると
 *   **既にある謄本をもう一度買ってしまう**。ロックを取る一文に条件を混ぜれば、
 *   相手が物件行を押さえている間はこちらが待たされ、確定後に再評価されて弾ける。
 * ⚠**承認した項目だけ**を条件にする。警告を見たうえで意図して買い直す運用は従来どおり許す。
 */
describe("decidePurchaseLock (@codex #402 Blocker)", () => {
  const base = {
    found: true,
    registryStatus: "unconfirmed",
    versionMatches: true,
    fingerprintRequired: false,
    fingerprintMatches: true,
    approved: null as import("../duplicate-guard").ApprovedPreflightFlags | null,
    obtainedNow: false,
    hasRegistryAttachmentNow: false,
    hasOwnersNow: false,
  };

  it("何も問題がなければ proceed", () => {
    expect(decidePurchaseLock(base).kind).toBe("proceed");
  });

  it("承認時に無かった謄本PDFが、ロック後に見えたら duplicate_appeared", () => {
    // ⚠これが本PRの核心。ロックを取ってから**新しい文**で読んだ値だから、
    //   待っている間にコミットされた添付が必ず見える。
    expect(
      decidePurchaseLock({
        ...base,
        approved: { registryObtained: false, hasRegistryAttachment: false, hasOwners: true },
        hasRegistryAttachmentNow: true,
      }).kind,
    ).toBe("duplicate_appeared");
  });

  it("承認時に警告を見て買い直す運用は従来どおり通す(approvedがtrueの項目は検査しない)", () => {
    expect(
      decidePurchaseLock({
        ...base,
        approved: { registryObtained: true, hasRegistryAttachment: true, hasOwners: true },
        obtainedNow: true,
        hasRegistryAttachmentNow: true,
        hasOwnersNow: true,
        registryStatus: "obtained",
      }).kind,
    ).toBe("proceed");
  });

  it("approved が null(番号購入・回収)なら重複検査はしない", () => {
    expect(
      decidePurchaseLock({ ...base, hasRegistryAttachmentNow: true }).kind,
    ).toBe("proceed");
  });

  it("指紋が要るのに合わなければ fingerprint_changed", () => {
    expect(
      decidePurchaseLock({
        ...base,
        fingerprintRequired: true,
        fingerprintMatches: false,
      }).kind,
    ).toBe("fingerprint_changed");
  });

  it("行が消えていたら、指紋が要るなら fingerprint_changed / 要らないなら already_running", () => {
    expect(
      decidePurchaseLock({ ...base, found: false, fingerprintRequired: true }).kind,
    ).toBe("fingerprint_changed");
    expect(
      decidePurchaseLock({ ...base, found: false }).kind,
    ).toBe("already_running");
  });

  it("scheduled / version不一致 は already_running", () => {
    expect(
      decidePurchaseLock({ ...base, registryStatus: "scheduled" }).kind,
    ).toBe("already_running");
    expect(decidePurchaseLock({ ...base, versionMatches: false }).kind).toBe(
      "already_running",
    );
  });

  it("⚠優先順位: 重複 > 指紋 > 実行中(重複を『実行中です』と誤案内しない)", () => {
    // 「実行中です」と言われた利用者は待って押し直すが、実際はもう持っている。
    expect(
      decidePurchaseLock({
        ...base,
        registryStatus: "scheduled",
        versionMatches: false,
        fingerprintRequired: true,
        fingerprintMatches: false,
        approved: { registryObtained: false, hasRegistryAttachment: false, hasOwners: false },
        hasRegistryAttachmentNow: true,
      }).kind,
    ).toBe("duplicate_appeared");
    expect(
      decidePurchaseLock({
        ...base,
        registryStatus: "scheduled",
        fingerprintRequired: true,
        fingerprintMatches: false,
      }).kind,
    ).toBe("fingerprint_changed");
  });

  it("総当たり: どの入力でも必ず4種のどれかに決まり、proceed の条件は1通りに絞れる", () => {
    const bools = [true, false];
    const approvedOpts = [
      null,
      { registryObtained: false, hasRegistryAttachment: false, hasOwners: false },
      { registryObtained: true, hasRegistryAttachment: true, hasOwners: true },
    ];
    let proceedCount = 0;
    let total = 0;
    for (const found of bools)
      for (const status of ["unconfirmed", "scheduled", "obtained"])
        for (const versionMatches of bools)
          for (const fingerprintRequired of bools)
            for (const fingerprintMatches of bools)
              for (const approved of approvedOpts)
                for (const obtainedNow of bools)
                  for (const att of bools)
                    for (const own of bools) {
                      total += 1;
                      const d = decidePurchaseLock({
                        found,
                        registryStatus: status,
                        versionMatches,
                        fingerprintRequired,
                        fingerprintMatches,
                        approved,
                        obtainedNow,
                        hasRegistryAttachmentNow: att,
                        hasOwnersNow: own,
                      });
                      expect(["proceed", "duplicate_appeared", "fingerprint_changed", "already_running"]).toContain(d.kind);
                      if (d.kind === "proceed") {
                        proceedCount += 1;
                        // proceed できるのは: 行があり・scheduled でなく・version一致・
                        // 指紋OK(不要含む)・重複の新規出現なし のときだけ。
                        expect(found).toBe(true);
                        expect(status).not.toBe("scheduled");
                        expect(versionMatches).toBe(true);
                        if (fingerprintRequired) expect(fingerprintMatches).toBe(true);
                      }
                    }
    expect(total).toBe(2 * 3 * 2 * 2 * 2 * 3 * 2 * 2 * 2);
    expect(proceedCount).toBeGreaterThan(0);
  });
});
