import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// env=node(jsdom 無し)のため、UI 配線の回帰はソース文字列で守る。
const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("A3: 認証レイアウトのフォールバック(dashboard-layout)", () => {
  const src = read("src/components/layout/dashboard-layout.tsx");

  it("useSession の status を使う(session 有無だけで役割を決めない)", () => {
    expect(src).toContain("status } = useSession()");
  });

  it("loading 中はローディング表示にして閲覧者に降格しない", () => {
    expect(src).toContain('status === "loading"');
    expect(src).toContain("読み込み中");
  });

  it("未認証は黙って VIEWER にせず再ログインへ誘導する(callbackUrl 付き)", () => {
    expect(src).toContain('status === "unauthenticated"');
    expect(src).toContain("セッションが切れました");
    expect(src).toContain("/login?callbackUrl=");
  });
});

describe("A3(補強): ログイン成功後は callbackUrl(同一サイト内)へ戻す(@codex R3)", () => {
  const src = read("src/app/(auth)/login/page.tsx");

  it("callbackUrl を読み、オープンリダイレクトを防いで元の画面へ戻す", () => {
    expect(src).toContain('get("callbackUrl")');
    expect(src).toContain('!cb.startsWith("//")'); // プロトコル相対 URL を弾く
  });
});

describe("A4: 販売図面エディタのセッション切れ処理(SalesSheetEditor)", () => {
  const src = read("src/components/sales-sheet/editor/SalesSheetEditor.tsx");

  it("セッション切れ(401/redirect)を検出するガードがある", () => {
    expect(src).toContain("function assertAuthedResponse");
    expect(src).toContain("res.redirected");
  });

  it("保存の JSON parse は失敗しても生エラー(Unexpected token)にしない", () => {
    expect(src).toContain("res.json().catch(() => null)");
  });

  it("保存・出力・削除の3経路でセッション切れガードを呼ぶ", () => {
    const calls = src.split("assertAuthedResponse(res)").length - 1;
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("A2(補強): 物件編集フォームは変更した項目だけ送る(既存の不正値で編集不能にしない・pre-review P1)", () => {
  const src = read("src/components/properties/property-edit-form.tsx");

  it("初期値(property)と一致する項目は payload に入れない", () => {
    expect(src).toContain("if (raw === initialStr) continue");
  });
});
