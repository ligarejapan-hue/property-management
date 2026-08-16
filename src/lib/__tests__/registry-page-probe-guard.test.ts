import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KNOWN_PROBE_SELECTORS,
  formatRegistryPageProbe,
} from "@/lib/registry-fetch/page-probe";

/**
 * 画面構造の診断（page-probe）が **PII / 物件特定情報を読まない**ことを、
 * 実装のソースを走査して担保する。
 *
 * ⚠なぜ走査型か: この診断は本番の登記情報提供サービス上でしか動かず、単体テストでは
 * 実DOMを再現できない。「tbody のセルを読まない」という約束は**書き方でしか守れない**ので、
 * 書き方そのものを検査する。個別の行番号や関数名では固定しない（動くと嘘になる）。
 */
/**
 * ⚠**改行を LF に正規化してから走査する**。下の検査には `[\s\S]{0,900}` のように
 * **文字数で距離を測る**ものが有り、Windows の作業ツリー（CRLF）では1行につき1文字伸びる。
 * 正規化しないと**同じコードでも手元と CI で判定が変わる**＝手元のフル緑が根拠にならない。
 * 実際 PR #383 で既存テストがこれを踏み、手元 11,297件 緑のまま CI だけが落ちた。
 */
const AUTO_FETCH = readFileSync(
  join(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

/** logRegistryPageProbe の本体（次の関数宣言まで）を切り出す。 */
function probeBody(): string {
  const start = AUTO_FETCH.indexOf("async function logRegistryPageProbe");
  expect(start).toBeGreaterThan(-1);
  const rest = AUTO_FETCH.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|type) /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe("page-probe が読む範囲（PII 防御）", () => {
  it("表は thead の見出しだけを読む", () => {
    expect(probeBody()).toContain("thead th");
  });

  it("⚠表の中身（tbody のセル）を読まない＝所在・地番・所有者が出ない", () => {
    const body = probeBody();
    // 行「数」を数えるのは可（tbody tr の length）。セルを読むのは不可。
    expect(body).not.toMatch(/tbody\s+t[dh]/);
    expect(body).not.toMatch(/querySelectorAll\(["'`]td/);
    expect(body).not.toMatch(/\btd\b[^\n]*textContent/);
  });

  it("行は「数」だけを取る", () => {
    expect(probeBody()).toMatch(/tbody tr["'`]\)\.length/);
  });

  it("⚠表の行の中にあるボタン・リンクは走査しない（行アクションの onclick に受付番号が入る）", () => {
    const body = probeBody();
    // tbody 配下を除外する述語があり、ボタンとタブの両方に適用されていること。
    expect(body).toMatch(/closest\(["'`]tbody["'`]\)\s*===\s*null/);
    expect((body.match(/\.filter\(outsideRows\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("⚠ボタンの識別に生の onclick を使わない（id / name のみ。onclick は整形側でマスク）", () => {
    // 走査側で onclick を id へフォールバックさせると、マスクを経ずに出る経路ができる。
    expect(probeBody()).not.toMatch(/id:\s*b\.id\s*\|\|\s*b\.name\s*\|\|\s*\(?b?\.?getAttribute\(["'`]onclick/);
  });

  it("診断の出力は必ず整形関数を通す（生データを直接ログへ出さない）", () => {
    const body = probeBody();
    // ⚠当初 /console\.warn\([^)]*json/ で書いたが、`[^)]*` は `)` を跨げず、
    // テンプレート内の `page-probe(${where})` の `)` で走査が止まって**常に合格**した
    // ＝検査になっていなかった（提出前レビューで指摘）。括弧に依存しない判定にする。
    const formatAt = body.indexOf("formatRegistryPageProbe(");
    const parseAt = body.indexOf("JSON.parse(json)");
    expect(formatAt).toBeGreaterThan(-1);
    // JSON.parse(json) は整形関数の**内側**にある＝生データは必ず整形を通る。
    expect(parseAt).toBeGreaterThan(formatAt);
    // 生の json 変数をテンプレートへ直接埋め込まないこと。
    expect(body).not.toContain("${json}");
    expect(body).not.toMatch(/console\.\w+\(\s*json\b/);
  });

  it("⚠この検査自体が空振りしていないこと（壊した書き方なら落ちる）", () => {
    // 上の判定ロジックを、わざと違反した擬似ソースへ当てて「落ちる」ことを確かめる。
    const bad = 'console.warn(`page-probe(${where}) ${json}`);';
    expect(bad.indexOf("formatRegistryPageProbe(")).toBe(-1);
    expect(bad).toContain("${json}");
  });

  it("診断が失敗しても本流を壊さない（握って警告のみ）", () => {
    expect(probeBody()).toMatch(/catch\s*\{[\s\S]*page-probe[\s\S]*unavailable/);
  });

  it("⚠診断自身に期限がある（レンダラが固まっても元の失敗を投げ直せる）", () => {
    // @codex #383 P2: 期限が無いと page.evaluate が解決せず、元の失敗が投げ直されない
    // ＝ブラウザの後始末が走らず物件の取得ロックが解けない。
    const body = probeBody();
    expect(body).toContain("Promise.race");
    expect(body).toContain("PAGE_PROBE_BUDGET_MS");
    expect(body).toMatch(/budget exceeded/);
  });

  it("⚠期限は環境変数に依存しない（未設定の本番でも必ず効く）", () => {
    expect(AUTO_FETCH).toMatch(/const PAGE_PROBE_BUDGET_MS = \d+;/);
    const decl = AUTO_FETCH.match(/const PAGE_PROBE_BUDGET_MS = [^;]+;/)?.[0] ?? "";
    expect(decl).not.toContain("process.env");
  });
});

describe("診断を仕掛ける場所", () => {
  it("⚠マイページ遷移の待ちが失敗したときに採取する（2026-08-16 に実際に止まった地点）", () => {
    // 「myPageTab を押す → myPageTable を待つ」が try で囲われ、catch で採取している。
    expect(AUTO_FETCH).toMatch(
      /myPageTab[\s\S]{0,400}?catch[\s\S]{0,900}?logRegistryPageProbe\(\s*page,\s*"mypage-transition"/,
    );
  });

  it("採取しても例外は握りつぶさず投げ直す（失敗は失敗のまま扱う）", () => {
    expect(AUTO_FETCH).toMatch(
      /logRegistryPageProbe\(\s*page,\s*"mypage-transition"\s*\);\s*throw transitionErr;/,
    );
  });

  it("⚠課金より前でしか採取しない（課金後に診断を足すと分類が濁る）", () => {
    const probeAt = AUTO_FETCH.indexOf('logRegistryPageProbe(page, "mypage-transition")');
    const chargeAt = AUTO_FETCH.indexOf("chargeState.charged = true");
    expect(probeAt).toBeGreaterThan(-1);
    expect(chargeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(chargeAt);
  });
});

describe("⚠端から端まで：どんな入力を渡しても PII は出ない", () => {
  it("表・ボタン・タブに実データを詰めても、ログ文字列に原文が残らない", () => {
    // 整形の入口に「実サイトから採れてしまい得る最悪の値」を入れ、出口を検査する。
    const leaky = [
      "井土ケ谷中町69-2",
      "田中",
      "東京都千代田区丸の内",
      "yamada@example.com",
      "090-1234-5678",
    ];
    const out = formatRegistryPageProbe({
      tables: [{ id: "t", headers: leaky, rowCount: 1 }],
      buttons: leaky.map((s) => ({
        id: "",
        onclick: `showOwner('${s}')`,
        label: s,
        disabled: false,
      })),
      tabs: leaky.map((s) => ({ label: s, onclick: `go('${s}')` })),
      known: {},
    });
    for (const s of leaky) {
      expect(out, `「${s}」が漏れている`).not.toContain(s);
    }
    // 部分片も残さない（前方一致で拾えないこと）。
    for (const frag of ["井土ケ谷", "丸の内", "yamada", "1234"]) {
      expect(out, `「${frag}」が漏れている`).not.toContain(frag);
    }
  });
});

describe("既知セレクタ一覧は実際のセレクタ定義と一致している", () => {
  it("在/不在を出す対象が auto-fetch の REGISTRY_SELECTORS に実在する", () => {
    // 診断が「#myPageTable=no」と言うとき、その値が本当に本流の使う値であること。
    // ずれると診断が嘘をつく（別物の不在を報告する）。
    for (const sel of KNOWN_PROBE_SELECTORS) {
      expect(
        AUTO_FETCH.includes(sel) ||
          // onclick セレクタはソース中でエスケープされて書かれている。
          AUTO_FETCH.includes(sel.replace(/"/g, '\\"')),
      ).toBe(true);
    }
  });
});
