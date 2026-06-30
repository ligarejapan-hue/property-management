import { describe, it, expect, vi } from "vitest";
import { OpenAiLetterProvider } from "../sale-dm-letter/providers/openai";
import { SaleDmError } from "../sale-dm-letter/types";

// ClaudeLetterProvider と同型: 実 SDK 呼び出しを createCompletion 注入で差し替えてテストする。
describe("OpenAiLetterProvider", () => {
  it("createCompletion の message.content を body として返す(system/user を chat messages へ)", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "拝啓 …(本文)… 敬具" }, finish_reason: "stop" }],
    });
    const p = new OpenAiLetterProvider({ apiKey: "k", model: "gpt-4o", createCompletion });
    const r = await p.generate({ system: "S", user: "U" });
    expect(r.body).toBe("拝啓 …(本文)… 敬具");
    expect(createCompletion).toHaveBeenCalledOnce();
    const arg = createCompletion.mock.calls[0][0];
    expect(arg.model).toBe("gpt-4o");
    expect(arg.messages[0]).toEqual({ role: "system", content: "S" });
    expect(arg.messages[1]).toEqual({ role: "user", content: "U" });
  });

  it("createCompletion が throw したら SaleDmError(GENERATION_FAILED)", async () => {
    const createCompletion = vi.fn().mockRejectedValue(new Error("boom"));
    const p = new OpenAiLetterProvider({ apiKey: "k", model: "gpt-4o", createCompletion });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("content_filter(拒否)は SaleDmError(GENERATION_FAILED)", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null }, finish_reason: "content_filter" }],
    });
    const p = new OpenAiLetterProvider({ apiKey: "k", model: "gpt-4o", createCompletion });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("空応答(content 空/欠落)は SaleDmError(GENERATION_FAILED)", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    });
    const p = new OpenAiLetterProvider({ apiKey: "k", model: "gpt-4o", createCompletion });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("finish_reason=length(トークン上限で途中切れ)は本文が非空でも SaleDmError(不完全な手紙を保存しない)", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "拝啓 …(ここで上限に達し途中で切れた本文" }, finish_reason: "length" }],
    });
    const p = new OpenAiLetterProvider({ apiKey: "k", model: "gpt-4o", createCompletion });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });
});
