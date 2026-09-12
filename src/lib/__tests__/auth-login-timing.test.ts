/**
 * ログインのタイミング差(アカウント有無の推測)を塞ぐ配線テスト。
 *
 * auth.ts は next-auth を実体 import するため vitest(env=node)では実行できない。
 * リポ慣行(auth-session-config.test.ts と同じ)に従いソース文字列で検証する。
 *
 * 塞ぎたい穴: 存在しない/無効/ロック中のメールは即 return null(速い)、実在アカウント
 * だけ bcrypt.compare(遅い)＝応答時間で実在メールを判別できる。否定パスでも必ず
 * ダミーハッシュと compare を走らせ、応答時間を揃える。
 */
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../auth.ts"), "utf-8");
const authorize = src.slice(
  src.indexOf("async authorize"),
  src.indexOf("session:"),
);

describe("ログインのタイミング差を塞ぐ(アカウント列挙対策)", () => {
  it("ダミーの bcrypt ハッシュ定数を持つ($2 で始まる本物のハッシュ)", () => {
    expect(src).toMatch(/DUMMY_PASSWORD_HASH\s*=\s*["'`]\$2[aby]\$\d\d\$/);
  });

  it("存在しない/無効ユーザーの否定パスでもダミーと compare してから return null", () => {
    // `if (!user || !user.isActive) { ... }` ブロックに compare(.., DUMMY) がある。
    const block = authorize.match(
      /if\s*\(\s*!user\s*\|\|\s*!user\.isActive\s*\)\s*\{[\s\S]*?\}/,
    );
    expect(block, "!user||!isActive ブロックが見つからない").not.toBeNull();
    expect(block![0]).toMatch(/await\s+compare\([^)]*DUMMY_PASSWORD_HASH/);
    expect(block![0]).toContain("return null");
  });

  it("ロック中の否定パスでもダミーと compare してから return null", () => {
    // lockedUntil のブロックにも compare(.., DUMMY) がある。
    const block = authorize.match(
      /if\s*\(\s*user\.lockedUntil[\s\S]*?\}/,
    );
    expect(block, "lockedUntil ブロックが見つからない").not.toBeNull();
    expect(block![0]).toMatch(/await\s+compare\([^)]*DUMMY_PASSWORD_HASH/);
    expect(block![0]).toContain("return null");
  });

  it("正規パスの実ハッシュ比較(user.passwordHash)は従来どおり残る", () => {
    expect(authorize).toMatch(/await\s+compare\(\s*password\s*,\s*user\.passwordHash\s*\)/);
  });

  it("全ての bcrypt ハッシュが cost=10(ダミーと同一)＝タイミング対策の前提を守る", () => {
    // タイミング対策は「実ハッシュと DUMMY_PASSWORD_HASH のコストが同一」を前提にする。
    // どこかで別コストで hash すると、その口だけ compare が速く/遅くなり穴が再発する
    // (@review: seed.ts が admin を cost12 で作っていた実例)。src と prisma を走査して固定。
    const roots = [
      resolve(__dirname, "../.."),
      resolve(__dirname, "../../../prisma"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const files = readdirSync(root, {
        recursive: true,
        encoding: "utf-8",
      }).filter((f) => typeof f === "string" && f.endsWith(".ts"));
      for (const rel of files) {
        const text = readFileSync(join(root, rel as string), "utf-8");
        for (const m of text.matchAll(/hashSync\([^,]+,\s*(\d+)\s*\)/g)) {
          if (m[1] !== "10") offenders.push(`${rel}: cost=${m[1]}`);
        }
      }
    }
    expect(offenders, `cost!=10 の hashSync: ${offenders.join(", ")}`).toEqual([]);
  });

  it("ログイン成功時に旧コストのハッシュを現行(10)へ焼き直す(rehash-on-login)", () => {
    // BCRYPT_COST を唯一の基準にしている。
    expect(src).toMatch(/BCRYPT_COST\s*=\s*10\b/);
    // 成功パスで、保存済みハッシュのコストが現行と違えば hashSync で焼き直す。
    expect(authorize).toMatch(
      /getRounds\(\s*user\.passwordHash\s*\)\s*!==\s*BCRYPT_COST/,
    );
    expect(authorize).toMatch(
      /passwordHash\s*=\s*hashSync\(\s*password\s*,\s*BCRYPT_COST\s*\)/,
    );
    // 追加のDB往復を作らない=成功時の既存 update に相乗りする(別の prisma.user.update を足さない)。
    const updates = authorize.match(/prisma\.user\.update/g) ?? [];
    expect(updates.length).toBe(2); // 失敗時の1回 + 成功時の1回のみ
  });

  it("既存のロックアウト(5回で30分)を壊していない", () => {
    expect(src).toMatch(/MAX_LOGIN_FAILURES\s*=\s*5\b/);
    expect(src).toMatch(/LOCK_DURATION_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
    expect(authorize).toMatch(/newFailedCount\s*>=\s*MAX_LOGIN_FAILURES/);
    // 成功時のリセットも残っている。
    expect(authorize).toMatch(/loginFailedCount:\s*0/);
  });
});
