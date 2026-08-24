import {
  Building2,
  Upload,
  Newspaper,
  Mail,
  UserCog,
  Users,
  History,
  ClipboardCheck,
  Map as MapIcon,
  BookOpen,
} from "lucide-react";
import { canSee, type AppRole } from "@/lib/nav/roles";

export interface HomeCard {
  label: string;
  href: string;
  icon: React.ReactNode;
  desc: string;
  minRole: AppRole;
  big?: boolean;
}

const ic = (C: React.ComponentType<{ className?: string }>) => <C className="h-6 w-6" />;

/** ホームのカード定義(役割で絞る前)。現場は現地調査マップを大カードで先頭に。 */
export const HOME_CARDS: HomeCard[] = [
  { label: "現地調査マップ", href: "/field-survey/map", icon: ic(MapIcon), desc: "今日の巡回はここから", minRole: "field_staff", big: true },
  { label: "巡回履歴", href: "/field-survey/sessions", icon: ic(History), desc: "過去の記録", minRole: "field_staff" },
  { label: "物件化の完成待ち", href: "/field-survey/candidates", icon: ic(ClipboardCheck), desc: "あと少しの物件", minRole: "field_staff" },
  { label: "物件", href: "/properties", icon: ic(Building2), desc: "物件一覧・マンション棟", minRole: "office_staff" },
  { label: "物件データ取り込み", href: "/import", icon: ic(Upload), desc: "受付帳・謄本の取込", minRole: "office_staff" },
  { label: "販売図面", href: "/sales-sheets/new", icon: ic(Newspaper), desc: "マイソクを作る", minRole: "office_staff" },
  // メニュー再編(2026-08-24): DM の入口はメニューページに集約したので、
  // ホームからもそこへ入る(設定だけに飛ばさない)。事務担当にも出す。
  { label: "DMメニュー", href: "/dm", icon: ic(Mail), desc: "宛名・お手紙・記録", minRole: "office_staff" },
  { label: "物件データ編集", href: "/admin/owners/correction", icon: ic(UserCog), desc: "所有者データ点検", minRole: "admin" },
  // ⚠添付ファイル検索は「物件」へ移したので、説明から「添付」を外す。
  { label: "システム管理", href: "/admin/users", icon: ic(Users), desc: "利用者・権限・ログ", minRole: "admin" },
  { label: "資料", href: "/help", icon: ic(BookOpen), desc: "使い方・マニュアル", minRole: "field_staff" },
];

/** userRole で見えるホームカード。 */
export function visibleHomeCards(userRole: string): HomeCard[] {
  return HOME_CARDS.filter((c) => canSee(userRole, c.minRole));
}
