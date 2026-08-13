import { describe, it, expect } from "vitest";
import { POST } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

// AI 直結の再生成は廃止(設計 §2.1)。個別の上書き設定で再生成する経路も含めて閉じる。
// 文面は外部AI方式(プロンプト表示→貼り付け→適用)で作る。
describe("POST regenerate draft は廃止されている", () => {
  it("410 を返す", async () => {
    const res = await POST(new Request("http://x", { method: "POST" }) as never);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GONE");
  });

  it("案内文が外部AI方式へ誘導している", async () => {
    const res = await POST(new Request("http://x", { method: "POST" }) as never);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/プロンプト|貼り付け/);
  });
});
