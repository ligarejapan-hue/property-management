/**
 * 所有者に列を足したときの「配線し忘れ」を自動検出する走査型ガード。
 *
 * ## なぜ画面名・項目名を手で並べないのか
 * 2026-08 の現住所対応で分かったのは、**列を1本足すと直す場所が10箇所以上ある**こと。
 * 手で並べたテストは「新しく足した列」を見張れない（テストにも足し忘れるから）。
 * ここでは **schema.prisma の Owner モデルを走査**し、
 * 各列が次の3点に入っているかを検査する:
 *
 * 1. 変更履歴の対象（`OWNER_TRACKED_FIELDS`）— 抜けると「誰がいつ変えたか」が追えない
 * 2. 表示レベル（`display-level` の表）— 抜けると **マスク利用者に生値が見える（fail-open）**
 * 3. 書込権限（`owner-create` の対応表）— 抜けると **項目ごとの権限を素通りして書ける**
 *
 * 新しい列を足すと、3点のどれかが欠けている限りこのテストが落ちる。
 * 「入れなくてよい列」は下の EXCLUDED に**理由付きで**書く（黙って外さない）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_TRACKED_FIELDS } from "@/lib/property-field-constants";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** schema.prisma の Owner モデルから、スカラー列の名前を取り出す。 */
function ownerScalarFields(): string[] {
  const schema = read("prisma/schema.prisma");
  const m = /^model Owner \{$([\s\S]*?)^\}$/m.exec(schema);
  if (!m) throw new Error("schema.prisma に model Owner が見つかりません");
  const scalarTypes = new Set([
    "String",
    "String?",
    "Int",
    "Int?",
    "Boolean",
    "Boolean?",
    "DateTime",
    "DateTime?",
    "Float",
    "Float?",
    "Json",
    "Json?",
  ]);
  const fields: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("//") || t.startsWith("///") || t.startsWith("@@")) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    if (!scalarTypes.has(parts[1])) continue; // リレーションは対象外
    fields.push(parts[0]);
  }
  return fields;
}

/**
 * 3点の配線が要らない列と、その理由。
 * ⚠ここへ足すのは「人が入力する値ではない」と説明できるときだけ。
 */
const EXCLUDED: Record<string, string> = {
  id: "主キー。人が編集しない",
  version: "楽観ロック用の内部値",
  isArchived: "アーカイブ状態。専用の route と履歴を持つ",
  createdAt: "作成時刻。システムが入れる",
  updatedAt: "更新時刻。システムが入れる",
  externalLinkKey: "取込の突合キー。表示レベルは全項目非マスク時のみ返す別扱い",
};

describe("所有者の列は3点に配線されている（走査型ガード）", () => {
  const fields = ownerScalarFields().filter((f) => !(f in EXCLUDED));

  it("走査対象の列が取れている（正規表現が空振りしていない）", () => {
    // 代表的な列が拾えていることで、走査そのものが機能していると確認する。
    expect(fields).toContain("name");
    expect(fields).toContain("address");
    expect(fields).toContain("currentAddress");
    expect(fields.length).toBeGreaterThan(8);
  });

  it("変更履歴の対象に入っている", () => {
    const missing = fields.filter((f) => !OWNER_TRACKED_FIELDS.includes(f));
    expect(missing, `OWNER_TRACKED_FIELDS への追加漏れ: ${missing.join(", ")}`).toEqual([]);
  });

  it("⚠表示レベルの表に入っている（抜けるとマスク利用者に生値が見える）", () => {
    const src = read("src/lib/display-level.ts");
    const keys = [...src.matchAll(/\{\s*key:\s*"([A-Za-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    const missing = fields.filter((f) => !keys.includes(f));
    expect(missing, `display-level の fieldMap への追加漏れ: ${missing.join(", ")}`).toEqual([]);
  });

  it("⚠書込権限の対応表に入っている（抜けると項目ごとの権限を素通りする）", () => {
    const src = read("src/lib/owner-create.ts");
    const block = /OWNER_FIELD_WRITE_RESOURCES[\s\S]*?\n\];/.exec(src);
    expect(block, "OWNER_FIELD_WRITE_RESOURCES が見つかりません").not.toBeNull();
    const keys = [...block![0].matchAll(/key:\s*"([A-Za-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    const missing = fields.filter((f) => !keys.includes(f));
    expect(missing, `owner-create の書込権限表への追加漏れ: ${missing.join(", ")}`).toEqual([]);
  });

  it("除外した列には理由が書いてある", () => {
    for (const [field, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${field} の除外理由が空`).toBeGreaterThan(0);
    }
  });
});

describe("宛先の解決は1か所に集約されている", () => {
  /**
   * ⚠DM を出す系統が `resolveMailingAddress` を通らずに `owner.address` を直接読むと、
   * その系統だけ登記上の住所へ送る（現住所を入れた意味が消える）。
   */
  const MAILING_CALLERS = [
    "src/lib/dm-export.ts",
    "src/lib/sale-dm-letter/recipients.ts",
  ];

  it.each(MAILING_CALLERS)("%s が宛先の解決を共通処理に任せている", (file) => {
    expect(read(file)).toContain("resolveMailingAddress");
  });

  it("宛先をまとめる鍵に郵便番号を入れていない（同じ場所へ2通出さない）", () => {
    const src = read("src/lib/dm-export.ts");
    expect(src).toContain("void zip;");
  });
});
