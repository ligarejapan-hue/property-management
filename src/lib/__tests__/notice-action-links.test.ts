import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * 「別の画面で操作してください」と促す案内には、その画面へのリンクを添える(発注者指摘 2026-09-20:
 * 文章で画面名を書くだけだと利用者が探して回ることになる)。リンクは権限のある人にだけ出す
 * =押しても入れない画面へは誘導しない、が本リポジトリの決まり。
 */
const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const INQUIRY_LIST = "src/components/sale-dm/inquiry-list.tsx";
const MAIL_SETTINGS = "src/app/(dashboard)/admin/mail-settings/page.tsx";

describe("操作を促す案内には行き先のリンクを付ける", () => {
  it("査定の申込: 通知先ゼロの案内から「ユーザー管理」へ行ける(管理者のみ)", () => {
    const src = read(INQUIRY_LIST);
    expect(src).toContain('href="/admin/users"');
    expect(src).toContain("ユーザー管理を開く");
    // 管理者以外には従来どおり文章だけを出す(リンクなし)
    expect(src).toContain("管理者に、ユーザー管理の「通知」から設定を依頼してください。");
    // 「利用者一覧」という画面は存在しない(実際のメニュー名は「ユーザー管理」)
    expect(src).not.toContain("利用者一覧");
  });

  it("査定の申込: 失敗の理由ごとの行き先が1か所にまとまっている", () => {
    const src = read(INQUIRY_LIST);
    const fn = src.slice(src.indexOf("function fixLinkFor"), src.indexOf("export default function"));
    expect(fn).toContain('code === "no_recipients"');
    expect(fn).toContain('href: "/admin/users"');
    expect(fn).toContain('code === "mail_not_configured"');
    expect(fn).toContain('href: "/admin/mail-settings"');
    // 行のリンクは管理者だけ
    expect(src).toMatch(/isAdmin\s*&&[\s\S]{0,200}fixLinkFor/);
  });

  it("査定の申込: 管理者判定はセッションの役割を見る(画面ごとに独自判定を作らない)", () => {
    const src = read(INQUIRY_LIST);
    expect(src).toContain('from "next-auth/react"');
    expect(src).toMatch(/session\?\.user as \{ role\?: string \} \| undefined\)\?\.role === "admin"/);
  });

  it("メール送信設定: 通知先ゼロの案内から「ユーザー管理」へ行ける", () => {
    const src = read(MAIL_SETTINGS);
    expect(src).toContain('href="/admin/users"');
    expect(src).toContain("ユーザー管理を開く");
    expect(src).not.toContain("利用者一覧");
  });

  it("行き先の綴りは実在する画面(sidebar に登録済み)である", () => {
    const sidebar = read("src/components/layout/sidebar-model.tsx");
    for (const href of ["/admin/users", "/admin/mail-settings"]) {
      expect(sidebar).toContain(`href: "${href}"`);
    }
  });
});
