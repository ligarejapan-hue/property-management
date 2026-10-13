import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("ログアウト・ログインで控えを全消しする", () => {
  it("logout.ts: clearNoticeStorage の隣で clearAllDrafts を呼ぶ(signOut より前)", () => {
    const src = read("src/lib/notifications/logout.ts");
    expect(src).toMatch(/import \{ clearAllDrafts \} from "@\/lib\/drafts\/draft-store";/);
    // 鍵をかけて消す=ログアウトで小窓が閉じる瞬間(unmount・pagehide)に書き戻させない。
    expect(src).toMatch(/clearNoticeStorage\(\);\n(?:\s*\/\/.*\n)*\s*clearAllDrafts\(\{ lockUntilReload: true \}\);[\s\S]*await signOut\(/);
  });
  it("login: 画面を開いた時点では、ログインしていないときだけ全消しする(@codex P2)", () => {
    const src = read("src/app/(auth)/login/page.tsx");
    // ログイン中の人が戻るでログイン画面を見ただけでは消さない。
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s*clearNoticeStorage\(\);\n(?:\s*\/\/.*\n)*\s*void getSession\(\)\n\s*\.then\(\(session\) => \{\n\s*if \(!session\) clearAllDrafts\(\);/);
  });
  it("login: 成功したら移動の前に clearAllDrafts を呼ぶ", () => {
    const src = read("src/app/(auth)/login/page.tsx");
    expect(src).toMatch(/import \{ clearAllDrafts \} from "@\/lib\/drafts\/draft-store";/);
    expect(src).toMatch(/writeSharedLastActivity\(Date\.now\(\)\);\n(?:\s*\/\/.*\n)*\s*clearAllDrafts\(\);[\s\S]*router\.push\(safeInternalDest\(cb\)\)/);
  });
});
