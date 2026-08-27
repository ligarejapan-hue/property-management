/**
 * PIIキャッシュ方針(発注者決定 2026-08-28・案B)の意図を固定する走査。
 *
 * 決めたこと:
 *   - 非 registry の `/uploads` は **`private, no-cache`**。
 *     `no-cache` は「キャッシュ禁止」ではなく「毎回サーバーへ再検証」。
 *     → 権限を剥奪された本人のブラウザでも**次の1回で 401/403/404 になる**(即時失効)。
 *     → ETag/304 は残るので、変わっていなければ本文は送らない(帯域は従来どおり)。
 *   - 保護対象(registry 謄本 / referral 反響資料)は従来どおり **`no-store`**。
 *
 * なぜ走査で固定するか:
 *   `max-age=3600` に戻す変更は**テストを1つも壊さずに**入れられてしまう(ヘッダ文字列を
 *   変えるだけで、機能は何も壊れない)。しかしそれは「権限剥奪後、最大1時間 PII が
 *   見え続ける」という**認可の穴**の再導入にあたる。文字列そのものを名指しで守る。
 *
 * ⚠この走査が見るのは配信ルートの Cache-Control 文字列だけ。
 *   認可判定そのものは uploads-authorization 側のテストが担保する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = join(
  process.cwd(),
  "src",
  "app",
  "uploads",
  "[...path]",
  "route.ts",
);

const raw = readFileSync(ROUTE, "utf8").replace(/\r\n/g, "\n");

/**
 * コメント行を除いた本文。
 * ⚠この方針の**理由**はコード内のコメントに書いてあり(なぜ max-age を捨てたのか)、
 *   そこには当然 `max-age` の語が出てくる。走査が説明文に反応すると
 *   「説明を書くと落ちる」という本末転倒になるため、判定は実コードだけを見る。
 */
const src = raw
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

describe("PIIキャッシュ方針(案B) — 非 registry は private, no-cache", () => {
  it("配信ルートに `private, no-cache` が実在する", () => {
    expect(src).toContain('"private, no-cache"');
  });

  it("⚠`max-age` を使っていない(1時間の失効遅延を作らない)", () => {
    // 戻し変更を名指しで落とすための固定。`max-age=3600` に限らず
    // あらゆる max-age を禁じる(1秒でも「再検証しない窓」が空くため)。
    expect(src).not.toMatch(/max-age/);
  });

  it("200 と 304 の両方に同じ Cache-Control が付く(片方だけ戻す変更を防ぐ)", () => {
    const hits = src.match(/"private, no-cache"/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it("保護対象(registry / referral)の `no-store` は残っている", () => {
    // no-cache と no-store の取り違えを防ぐ。no-store 側を消すと
    // 謄本・反響資料がキャッシュされうる。
    expect(src).toContain('"no-store"');
  });

  it("ETag は残っている(本文転送の削減を捨てていない)", () => {
    // no-cache の要点は「毎回問い合わせるが、変わっていなければ送らない」。
    // ETag を消すと毎回全量転送になり、案Bの前提が崩れる。
    expect(src).toContain("ETag");
    expect(src).toContain("if-none-match");
  });
});
