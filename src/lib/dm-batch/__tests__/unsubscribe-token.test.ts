import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  buildBatchItemUnsubscribeToken,
  buildBatchItemUnsubscribeUrl,
  isBatchItemUnsubscribeToken,
  verifyBatchItemUnsubscribeToken,
} from "../unsubscribe-token";
import {
  buildUnsubscribeToken,
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/sale-dm-letter/unsubscribe-token";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";

describe("宛名CSVの1通の配信停止トークン", () => {
  it("c+32桁16進.署名22文字 の形で、既存の形式門前払いを通る", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(t).toMatch(/^c[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(parseUnsubscribeToken(t)).not.toBeNull();
    expect(isBatchItemUnsubscribeToken(t)).toBe(true);
  });

  it("往復で itemId(ハイフン付き小文字)が戻る・大文字のUUIDでも同じトークン", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(verifyBatchItemUnsubscribeToken(t, KEY)).toBe(ITEM);
    expect(buildBatchItemUnsubscribeToken(ITEM.toUpperCase(), KEY)).toBe(t);
  });

  it("別の鍵・別の itemId の署名・改ざんは無効", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(verifyBatchItemUnsubscribeToken(t, OTHER_KEY)).toBeNull();
    const other = buildBatchItemUnsubscribeToken("11111111-2222-4333-8444-555555555555", KEY);
    const swapped = `${t.split(".")[0]}.${other.split(".")[1]}`;
    expect(verifyBatchItemUnsubscribeToken(swapped, KEY)).toBeNull();
    expect(verifyBatchItemUnsubscribeToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), KEY)).toBeNull();
  });

  it("売却DMのトークンとは判別でき、互いの検証を通らない(用途ラベルが違う)", () => {
    const sale = buildUnsubscribeToken("AbCdEfGhIjK", KEY); // 売却DMの追跡トークンは11文字
    expect(isBatchItemUnsubscribeToken(sale)).toBe(false);
    expect(verifyBatchItemUnsubscribeToken(sale, KEY)).toBeNull();
    const batch = buildBatchItemUnsubscribeToken(ITEM, KEY);
    // 売却DMの検証は形だけなら通り得るので、署名で必ず落ちることを確かめる。
    expect(verifyUnsubscribeToken(batch, KEY)).toBeNull();
  });

  it("形が違うものは判別で false(大文字の16進・長さ違い・接頭辞違い)", () => {
    const sig = "A".repeat(22);
    expect(isBatchItemUnsubscribeToken(`c${"A".repeat(32)}.${sig}`)).toBe(false);
    expect(isBatchItemUnsubscribeToken(`c${"a".repeat(31)}.${sig}`)).toBe(false);
    expect(isBatchItemUnsubscribeToken(`d${"a".repeat(32)}.${sig}`)).toBe(false);
  });

  it("URL は base の末尾スラッシュを1つにそろえて /u/<token>", () => {
    const url = buildBatchItemUnsubscribeUrl(ITEM, "https://app.ligarejapan.com/", KEY);
    expect(url).toBe(`https://app.ligarejapan.com/u/${buildBatchItemUnsubscribeToken(ITEM, KEY)}`);
  });
});
