import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// [@codex P2] 検索の文字を変えたとき、遅れて返った前の検索の結果で「名簿にあるマンション」の段が
// 上書きされると、今の検索とは違う建物の「マンション棟に登録」が押せてしまう(違う棟を作る)。
// 一覧は "use client" + useEffect の取得で、env=node では動かせないため、配線を走査して固定する。
const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8").replace(/\r\n/g, "\n");
const load = src.slice(src.indexOf("const load = useCallback"), src.indexOf("}, [keyword]);"));

describe("棟の検索: 古い応答で名簿の段を上書きしない", () => {
  it("★問い合わせごとに番号を振り、最新の番号のときだけ結果を入れる", () => {
    expect(load).toMatch(/const seq = \+\+loadSeqRef\.current;/);
    const awaitAt = load.indexOf("await fetchBuildings");
    const guardAt = load.indexOf("if (!isLatestRequest(seq, loadSeqRef.current)) return;");
    expect(guardAt).toBeGreaterThan(awaitAt);
    expect(guardAt).toBeLessThan(load.indexOf("setCatalog(res.catalog"));
  });
  it("★失敗したら名簿の段を空にする(前の検索の名簿を残さない)", () => {
    const catchBody = load.slice(load.indexOf("} catch {"), load.indexOf("} finally {"));
    expect(catchBody).toContain("setCatalog([])");
  });
});
