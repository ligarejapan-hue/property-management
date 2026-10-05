import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryResults } from "../agent-picker";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const hits = [{ id: "m1", companyName: "株式会社 見本不動産", phone: "03-0000-1212", licenseLabel: "東京都知事(17)第000001号" }];

describe("国交省の一覧から来た候補", () => {
  it("「国交省の一覧」の印・免許番号・代表電話を添える", () => {
    const html = renderToStaticMarkup(<RegistryResults hits={hits} busyId={null} onPick={() => {}} />);
    expect(html).toContain("名簿に無い会社(国交省の一覧から)");
    expect(html).toContain("国交省の一覧");
    expect(html).toContain("株式会社 見本不動産");
    expect(html).toContain("東京都知事(17)第000001号");
    expect(html).toContain("代表 03-0000-1212");
  });

  it("名簿へ写している間はその候補を押せない・「名簿に入れています…」", () => {
    const html = renderToStaticMarkup(<RegistryResults hits={hits} busyId="m1" onPick={() => {}} />);
    expect(html).toContain("disabled");
    expect(html).toContain("名簿に入れています…");
  });

  it("候補が無ければ何も出さない", () => {
    expect(renderToStaticMarkup(<RegistryResults hits={[]} busyId={null} onPick={() => {}} />)).toBe("");
  });

  it("受付の窓だけが一覧の候補を頼む(名簿の画面は頼まない=名簿は関わった業者だけ)", () => {
    expect(read("src/components/agent-inquiry/agent-picker.tsx")).toContain("searchDeskAgents(query, { registry: true })");
    expect(read("src/app/(dashboard)/agents/page.tsx")).not.toContain("registry: true");
  });

  it("候補を押すと名簿へ写してから、今までどおり選んだ状態にする", () => {
    const src = read("src/components/agent-inquiry/agent-picker.tsx");
    expect(src).toMatch(/adoptRegistryAgent\(h\.id\)[\s\S]*onPick\(r\.agent\)/);
  });

  it("★写している間に検索語が変わったら、古い返事で選ばない(別の業者に反響を付けない・@codex #477)", () => {
    const src = read("src/components/agent-inquiry/agent-picker.tsx");
    // 打ち直して元の語に戻した場合も古い返事で選ばない=語の比較ではなく、変わるたびに増える番号で見る
    expect(src).toMatch(/const asked = queryGen\.current;[\s\S]*adoptRegistryAgent\(h\.id\)[\s\S]*if \(queryGen\.current !== asked\) return;[\s\S]*onPick\(r\.agent\)/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*queryGen\.current \+= 1;\s*\}, \[query\]\)/);
    // 打った瞬間(描画や effect を待たず)に番号を進める=返事が描画の直前に届いても古い返事で選ばない
    expect(src).toMatch(/onChange=\{\(e\) => \{[^}]*?queryGen\.current \+= 1;\s*onQuery\(e\.target\.value\);\s*\}\}/);
  });
});
