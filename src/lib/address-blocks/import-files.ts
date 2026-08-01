/**
 * 取込スクリプト共通のファイル走査(scripts/import-address-*.ts から使う・app からは使わない)。
 */
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 指定パス(ファイル or フォルダ)から .csv を列挙する(フォルダは1階層下まで)。
 * 重複指定(フォルダとその中のファイルを両方渡す・同じファイルを2回渡す・symlink 経由等)は
 * **物理パス**(realpath)で dedupe する(重複すると同じ点が二重挿入されるため)。
 */
export function collectCsvFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const push = (p: string) => {
    const canonical = realpathSync(p);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    files.push(canonical);
  };
  for (const p of paths) {
    const st = statSync(p);
    if (st.isFile()) {
      push(p);
      continue;
    }
    for (const name of readdirSync(p)) {
      const child = join(p, name);
      if (statSync(child).isDirectory()) {
        for (const inner of readdirSync(child)) {
          if (inner.toLowerCase().endsWith(".csv")) push(join(child, inner));
        }
      } else if (name.toLowerCase().endsWith(".csv")) {
        push(child);
      }
    }
  }
  return files;
}

/**
 * 大きな UTF-8 ファイルを**厳格 decode**(不正バイトで throw)しながら行単位で流す。
 * 文字化けデータの混入防止(Shift_JIS 側の fatal:true と同じ方針)をメモリに載る
 * サイズ制限なしで行うため streaming にする(東京都の住居点 CSV は約2GB弱まで想定)。
 */
export async function* strictUtf8Lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  for await (const chunk of createReadStream(path)) {
    carry += decoder.decode(chunk as Buffer, { stream: true });
    const parts = carry.split(/\r?\n/);
    carry = parts.pop() ?? "";
    for (const p of parts) yield p;
  }
  carry += decoder.decode();
  if (carry !== "") yield carry;
}
