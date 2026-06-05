/**
 * F19: 監査ログ画面のユーザー名検索を debounce 化し、毎キーストロークの
 * /api/admin/audit-logs 再取得を抑制する配線の source-assertion テスト
 * （repo に jsdom / RTL が無いため、画面はソース文字列で検証する）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const PAGE = "src/app/(dashboard)/admin/audit-logs/page.tsx";

describe("F19: audit-logs ユーザー名検索の debounce 配線", () => {
  const src = read(PAGE);

  it("共通 debounce ユーティリティを再利用する（独自実装しない）", () => {
    expect(src).toMatch(/import \{ debounce \} from "@\/lib\/debounce"/);
  });

  it("入力中文字列(userNameInput)と確定値(userNameFilter)を分離する", () => {
    expect(src).toMatch(/const \[userNameInput, setUserNameInput\] = useState\(""\)/);
    expect(src).toMatch(/const \[userNameFilter, setUserNameFilter\] = useState\(""\)/);
  });

  it("確定は 300ms debounce で userNameFilter を更新し page を 1 に戻す", () => {
    expect(src).toMatch(/const commitUserName = useMemo\(/);
    expect(src).toMatch(/debounce\(\s*\(value: string\) => \{[\s\S]*?setUserNameFilter\(value\);[\s\S]*?setPage\(1\);[\s\S]*?\},\s*300,?\s*\)/);
  });

  it("入力欄は userNameInput を表示し、onChange は即時入力＋debounce commit のみ（直接 setUserNameFilter しない）", () => {
    expect(src).toMatch(/value=\{userNameInput\}/);
    expect(src).toMatch(/setUserNameInput\(e\.target\.value\);\s*commitUserName\(e\.target\.value\);/);
    // 毎キーストロークで確定値を直接更新しない（負アサーション）。
    expect(src).not.toMatch(/onChange=\{\(e\) => setUserNameFilter\(e\.target\.value\)\}/);
  });

  it("明示的な検索ボタンは保留中 debounce を破棄して入力値を即時反映する", () => {
    expect(src).toMatch(/function handleSearch\(\)\s*\{[\s\S]*?commitUserName\.cancel\(\);[\s\S]*?setUserNameFilter\(userNameInput\);[\s\S]*?setPage\(1\);[\s\S]*?\}/);
  });

  it("リセットは保留中 debounce を破棄し入力値も確定値もクリアする", () => {
    expect(src).toMatch(/function handleReset\(\)\s*\{[\s\S]*?commitUserName\.cancel\(\);[\s\S]*?setUserNameInput\(""\);[\s\S]*?setUserNameFilter\(""\);[\s\S]*?\}/);
  });

  it("アンマウント時に保留中 debounce を破棄する", () => {
    expect(src).toMatch(/useEffect\(\(\) => \(\) => commitUserName\.cancel\(\), \[commitUserName\]\)/);
  });

  it("fetchLogs は引き続き確定値 userNameFilter に依存する（debounce 後の値で取得）", () => {
    expect(src).toMatch(/const fetchLogs = useCallback\(/);
    expect(src).toMatch(/if \(userNameFilter\) params\.set\("userName", userNameFilter\)/);
    expect(src).toMatch(/\}, \[page, actionFilter, targetTableFilter, userNameFilter, dateFrom, dateTo\]\)/);
  });
});
