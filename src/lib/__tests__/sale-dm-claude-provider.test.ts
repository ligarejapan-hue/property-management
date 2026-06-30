import { describe, it, expect, vi } from "vitest";
import { ClaudeLetterProvider } from "../sale-dm-letter/providers/claude";
import { SaleDmError } from "../sale-dm-letter/types";

describe("ClaudeLetterProvider", () => {
  it("createMessage の text を body として返す", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "拝啓 …(本文)… 敬具" }],
    });
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    const r = await p.generate({ system: "S", user: "U" });
    expect(r.body).toBe("拝啓 …(本文)… 敬具");
    expect(createMessage).toHaveBeenCalledOnce();
    const arg = createMessage.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    expect(arg.max_tokens).toBe(1200);
    expect(arg.system).toBe("S");
  });

  it("createMessage が throw したら SaleDmError(GENERATION_FAILED)", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("refusal 応答は SaleDmError(GENERATION_FAILED)", async () => {
    const createMessage = vi.fn().mockResolvedValue({ stop_reason: "refusal", content: [] });
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("stop_reason=max_tokens(トークン上限で途中切れ)は本文が非空でも SaleDmError(不完全な手紙を保存しない・OpenAI の length と対称)", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "拝啓 …(ここで上限に達し途中で切れた本文" }],
    });
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });
});
