/**
 * 冪等キーの「同じ要求か」判定の材料（@codex #373 R9 P2）。
 *
 * ⚠画面（キーを張り替えるか）とサーバ（既存ジョブを返してよいか）が
 *   **同じ材料**で判断する必要がある。片方だけ材料が足りないと、
 *   別の要求を同じ要求とみなして古いジョブを返す。
 */
import { describe, it, expect } from "vitest";
import { buildBulkIdempotencySignature } from "../idempotency";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

describe("buildBulkIdempotencySignature", () => {
  it("選ぶ順番が違っても同じ要求として扱う", () => {
    expect(buildBulkIdempotencySignature([A, B], "owner", { [A]: "h1", [B]: "h2" })).toBe(
      buildBulkIdempotencySignature([B, A], "owner", { [B]: "h2", [A]: "h1" }),
    );
  });

  it("⚠承認の内容が変われば別の要求になる（これが今回の要点）", () => {
    // 作成は成功したのに応答が失われた → 利用者が地番を直して確認し直した、という
    // 筋道。物件も種別も同じなので、承認の指紋を見ないと同じ要求に見えてしまい、
    // **直す前の古いジョブ**へ飛ばされる。
    const before = buildBulkIdempotencySignature([A], "owner", { [A]: "old" });
    const after = buildBulkIdempotencySignature([A], "owner", { [A]: "new" });
    expect(after).not.toBe(before);
  });

  it("物件・種別が変われば別の要求になる（従来どおり）", () => {
    const base = buildBulkIdempotencySignature([A], "owner", { [A]: "h" });
    expect(buildBulkIdempotencySignature([A, B], "owner", { [A]: "h" })).not.toBe(base);
    expect(buildBulkIdempotencySignature([A], "all", { [A]: "h" })).not.toBe(base);
  });

  it("承認が無い場合も落ちない（送られてこなければ空として扱う）", () => {
    expect(buildBulkIdempotencySignature([A], "owner")).toBe(
      buildBulkIdempotencySignature([A], "owner", null),
    );
    expect(buildBulkIdempotencySignature([A], "owner", {})).toBe(
      buildBulkIdempotencySignature([A], "owner"),
    );
  });

  it("⚠材料に入るのは指紋（digest）だけ＝地番の値そのものは入らない（秘匿）", () => {
    // 呼び出し側が地番を渡す作りになっていないことを、引数の形で担保する。
    const sig = buildBulkIdempotencySignature([A], "owner", { [A]: "abcdef01" });
    expect(sig).toContain("abcdef01");
    expect(sig).not.toContain("番");
  });
});
