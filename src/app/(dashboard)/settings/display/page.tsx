import { PageHeader } from "@/components/ui/page-header";
import DisplaySettings from "@/components/settings/display-settings";

// 見た目の設定 段階4(2026-10-31): 設定 > 表示。だれでも自分の分だけ変えられる(管理者には会社の標準の欄も出る)。
// 入口 = ヘッダーの利用者メニュー・スマホのメニュー。
export default function DisplaySettingsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="表示の設定" description="色テーマ・文字サイズ・メニューの配置を、自分の見やすいように選べます。" />
      <DisplaySettings />
    </div>
  );
}
