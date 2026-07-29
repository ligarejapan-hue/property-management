import { describe, it, expect, vi } from "vitest";

// api-helpers は auth/prisma を import するが、import 時には接続しない。
// parseJsonBody は Request だけを読む純粋な helper なので最小スタブで十分
// (handle-api-error-render-busy.test.ts と同じ形)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: {} }));

import { parseJsonBody, ApiError } from "../api-helpers";

const req = (body: string) =>
  new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("parseJsonBody", () => {
  it("空ボディは {} を返す（オプションキーのみの POST/PATCH を許容）", async () => {
    await expect(
      parseJsonBody(new Request("http://x", { method: "POST" })),
    ).resolves.toEqual({});
    await expect(parseJsonBody(req("   "))).resolves.toEqual({});
  });

  it("JSON リテラルの null は {} に正規化する（総点検P3）", async () => {
    // ⚠'null' は**有効な JSON**なので malformed の catch に落ちない。
    // そのまま返すと呼び出し側の `(body as {x?: unknown}).x` が TypeError で
    // 500 になる（auto-fetch / sale-dm regenerate で実在した）。空ボディと
    // 同じ「何も指定していない」= {} に揃え、各 route 自身の検証
    // （confirmed 必須等）が正しい 400/422 を返せるようにする。
    await expect(parseJsonBody(req("null"))).resolves.toEqual({});
  });

  it("通常の object / array / プリミティブはそのまま返す", async () => {
    await expect(parseJsonBody(req('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(parseJsonBody(req("[1,2]"))).resolves.toEqual([1, 2]);
    await expect(parseJsonBody(req("123"))).resolves.toBe(123);
  });

  it("malformed JSON は ApiError(400, INVALID_JSON)", async () => {
    const p = parseJsonBody(req("{oops"));
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
  });
});
