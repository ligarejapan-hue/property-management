/**
 * source-assertion: DELETE /api/properties/[id] が
 * Property.delete (cascade で PropertyPhoto を消す) の前に同一 transaction 内で
 * fileUrl を捕捉し、transaction 成功後に各 PropertyPhoto の実体ファイルを
 * best-effort で削除し、失敗しても DB を rollback せず既存成功レスポンスを
 * 維持し、fileUrl / key を console / AuditLog に生値で残さないことを保証する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const routeSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/properties/[id]/route.ts"),
  "utf8",
);

describe("Property DELETE — storage cleanup (cascade)", () => {
  it("getStorage と extractStorageKeyFromUrl を import している", () => {
    expect(routeSrc).toMatch(/from\s+"@\/lib\/storage"/);
    expect(routeSrc).toMatch(/from\s+"@\/lib\/storage\/url-to-key"/);
    expect(routeSrc).toMatch(/extractStorageKeyFromUrl/);
    expect(routeSrc).toMatch(/getStorage/);
  });

  it("Property.delete を $transaction で囲み、同一 tx 内で propertyPhoto.findMany している", () => {
    // ネストブレースで非貪欲マッチが破綻するため、構造の存在と順序を index で確認する
    expect(routeSrc).toMatch(/await\s+prisma\.\$transaction\(async\s*\(tx\)\s*=>/);
    const findIdx = routeSrc.search(/tx\.propertyPhoto\.findMany\(/);
    const delIdx = routeSrc.search(/tx\.property\.delete\(/);
    expect(findIdx).toBeGreaterThan(0);
    expect(delIdx).toBeGreaterThan(findIdx);
    expect(routeSrc).toMatch(/select:\s*\{\s*fileUrl:\s*true\s*\}/);
  });

  it("findMany が delete より先に走る順序", () => {
    const findIdx = routeSrc.search(/tx\.propertyPhoto\.findMany\(/);
    const delIdx = routeSrc.search(/tx\.property\.delete\(/);
    expect(findIdx).toBeGreaterThan(0);
    expect(delIdx).toBeGreaterThan(findIdx);
  });

  it("transaction 成功後に storage.delete をループで呼ぶ", () => {
    const txCloseIdx = routeSrc.search(/\}\);\s*\n[\s\S]*?storageDeleteAttempted/);
    expect(txCloseIdx).toBeGreaterThan(0);
    expect(routeSrc).toMatch(/for\s*\(\s*const\s+fileUrl\s+of\s+photoFileUrls\s*\)/);
    expect(routeSrc).toMatch(/getStorage\(\)\.delete\(/);
  });

  it("storage.delete を try/catch で囲み、1 件失敗しても他は続ける", () => {
    const loopMatch = routeSrc.match(
      /for\s*\(\s*const\s+fileUrl[\s\S]*?\{[\s\S]*?try\s*\{[\s\S]*?getStorage\(\)\.delete\([\s\S]*?\}\s*catch[\s\S]*?\}\s*\}/,
    );
    expect(loopMatch).not.toBeNull();
  });

  it("storage.delete 失敗で DB delete を rollback しない (tx の外で呼ぶ)", () => {
    // $transaction 内で getStorage().delete を呼んでいない構造を、
    // tx 終了後に置かれた storageDeleteAttempted 宣言とのインデックス順で担保する。
    const txStart = routeSrc.search(/await\s+prisma\.\$transaction\(/);
    const storageAttemptedIdx = routeSrc.search(/let\s+storageDeleteAttempted/);
    const storageDeleteIdx = routeSrc.search(/getStorage\(\)\.delete\(/);
    expect(txStart).toBeGreaterThan(0);
    expect(storageAttemptedIdx).toBeGreaterThan(txStart);
    expect(storageDeleteIdx).toBeGreaterThan(storageAttemptedIdx);
  });

  it("失敗件数集計とアグリゲートログ", () => {
    expect(routeSrc).toMatch(/storageDeleteAttempted/);
    expect(routeSrc).toMatch(/storageDeleteFailed/);
    expect(routeSrc).toMatch(
      /console\.error\([\s\S]*?photo storage cleanup partial failure/,
    );
  });

  it("console.error に fileUrl / key 生値を埋め込まない", () => {
    const errMatches = routeSrc.match(/console\.error\([\s\S]*?\}\);/g) ?? [];
    expect(errMatches.length).toBeGreaterThan(0);
    for (const body of errMatches) {
      expect(body).not.toMatch(/fileUrl\s*:/);
      expect(body).not.toMatch(/storageKey/);
      expect(body).not.toMatch(/\bkey\s*:/);
    }
  });

  it("AuditLog detail に fileUrl / storageKey / photoFileUrls を入れない", () => {
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?action:\s*"delete"[\s\S]*?detail:\s*\{([\s\S]*?)\}/,
    );
    expect(detailMatch).not.toBeNull();
    const body = detailMatch![1];
    expect(body).not.toMatch(/fileUrl/);
    expect(body).not.toMatch(/storageKey/);
    expect(body).not.toMatch(/photoFileUrls/);
  });

  it("既存成功レスポンス (apiResponse with id+deleted) を維持", () => {
    expect(routeSrc).toMatch(/apiResponse\(\{\s*id,\s*deleted:\s*true\s*\}\)/);
  });

  it("extractStorageKeyFromUrl が null の場合は storage.delete を呼ばない (skip ガード)", () => {
    expect(routeSrc).toMatch(/if\s*\(key\s*==\s*null\)\s*continue/);
  });
});
