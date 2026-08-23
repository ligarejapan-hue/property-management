/**
 * 添付(Attachment)の作成は、**親の物件行をロックした同一トランザクション内**で行う。
 *
 * 背景 (@codex #399 R7 P2 → 発注者判断 2026-08-21 で別PRに切り出し):
 *   謄本の有料取得は課金の直前に「この物件に謄本PDFが無いこと」を
 *   購入ロックの where で検査する (duplicate-guard.ts)。ところが添付を作る側が
 *   親の物件行を押さえていないため、**作成が確定する直前のミリ秒**にこの検査が
 *   通ると二重課金の余地が残っていた (実測: 全4経路がロック無しの単独 create)。
 *
 * 直し方 (全経路共通の型):
 *   外部ストレージへの保存 (ロック外) → $transaction { lockPropertyRow → create }
 *   - ロックを持つのは作成の一瞬だけ (外部I/Oをロック内に入れない)
 *   - 順序は常に**親→子** (デッドロック回避の既存規則 [authz-pii 横断監査 #364] と同方向)
 *
 * ⚠このテストは**全出現を機械的に洗う**。1か所だけ直して他を忘れる事故
 *   ([[fix-all-call-sites-not-one]] の実例が複数ある) を構造的に防ぐ。
 *   新しい作成箇所を足すと、ロック無しでは**このテストが名指しで落ちる**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** src 配下の .ts/.tsx を列挙 (生成物とテストを除く)。 */
function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "generated" || name === "__tests__" || name === "node_modules") continue;
      listSources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = listSources(join(process.cwd(), "src"));

describe("attachment.create の親行ロック (@codex #399 R7 P2)", () => {
  it("素の prisma.attachment.create はリポに存在しない(全て tx 経由)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (src.includes("prisma.attachment.create")) offenders.push(f);
    }
    // 違反ファイルを名指しで出す(どこを直すべきかが一目で分かるように)。
    expect(offenders, `ロック無しの作成が残っている:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("すべての tx.attachment.create は、直前に親の物件行ロックを取っている", () => {
    const offenders: string[] = [];
    let found = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let at = src.indexOf("tx.attachment.create");
      while (at !== -1) {
        found += 1;
        // 同一 tx コールバック内で lockPropertyRow(tx, ...) が先行していること。
        // 遡る範囲は「$transaction の開始」まで(別の tx のロックを誤って数えない)。
        const txStart = src.lastIndexOf("$transaction", at);
        const scope = txStart === -1 ? "" : src.slice(txStart, at);
        if (!scope.includes("lockPropertyRow(tx")) {
          offenders.push(`${f} (offset ${at})`);
        }
        at = src.indexOf("tx.attachment.create", at + 1);
      }
    }
    // ⚠空振り防止: 作成箇所そのものが見つからないなら、このテストは何も守っていない。
    //   実測 2026-08-23: 作成は4経路(汎用attachments route / registry-pdf process /
    //   manual-attach-registry-pdf / registry-pdf-bulk process-row)。
    expect(found).toBeGreaterThanOrEqual(4);
    expect(offenders, `ロックの無い tx 作成:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("duplicate-guard の限界コメントは「閉じた」ことを記す(嘘の警告を残さない)", () => {
    const guard = readFileSync(
      join(process.cwd(), "src/lib/registry-fetch/duplicate-guard.ts"),
      "utf8",
    );
    // 「ロックしない」という記述を**現在形の限界**として残さない
    // (直したのに警告が残っていると、次の変更者が誤った前提で設計する)。
    expect(guard).not.toContain("ミリ秒単位ですり抜ける余地が残る");
    expect(guard).toContain("親の物件行を先にロック");
  });
});
