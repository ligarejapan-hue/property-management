import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("資料送付の守り(走査)", () => {
  const send = read("src/app/api/agent-inquiries/[id]/material-sends/route.ts");
  const cand = read("src/app/api/agent-inquiries/[id]/material-candidates/route.ts");
  it("送信は checkMaterialSelection を通してからストレージを読む", () => {
    expect(send.indexOf("checkMaterialSelection(")).toBeGreaterThan(-1);
    expect(send.indexOf("checkMaterialSelection(")).toBeLessThan(send.indexOf("storage.read("));
  });
  it("候補は selectableForMaterialSend で絞る", () => expect(cand).toContain("selectableForMaterialSend("));
  it("BCC・CC を付けない", () => expect(send).not.toMatch(/\b(bcc|cc)\s*:/i));
  it("メール設定の中身を応答に入れない", () => expect(cand).toMatch(/mailConfigured: config != null/));
});
