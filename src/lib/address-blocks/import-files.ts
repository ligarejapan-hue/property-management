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
 * chunk 列を**厳格 UTF-8 decode**(不正バイトで TypeError)しながら行単位で流す純ロジック
 * (テスト対象)。チャンク境界でのマルチバイト文字の分断は TextDecoder の stream:true が、
 * CRLF の分断(\r と \n が別チャンク)と改行なし最終行は carry の持ち回りが吸収する。
 */
export async function* strictUtf8LinesFromChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  for await (const chunk of chunks) {
    carry += decoder.decode(chunk, { stream: true });
    // \r\n の \r がチャンク末尾に来た場合に \r| \n で分断されないよう、
    // 末尾の \r は次チャンクへ持ち越す。
    const holdCr = carry.endsWith("\r");
    const usable = holdCr ? carry.slice(0, -1) : carry;
    const parts = usable.split(/\r?\n/);
    carry = (parts.pop() ?? "") + (holdCr ? "\r" : "");
    for (const p of parts) yield p;
  }
  carry += decoder.decode();
  // 最後に単独の \r が残った場合は行区切りとして扱う(空行は呼び出し側が無視)。
  const parts = carry.split(/\r?\n/);
  for (const p of parts) if (p !== "") yield p.replace(/\r$/, "");
}

/**
 * 大きな UTF-8 ファイルを**厳格 decode**(不正バイトで throw)しながら行単位で流す。
 * 文字化けデータの混入防止(Shift_JIS 側の fatal:true と同じ方針)をメモリに載る
 * サイズ制限なしで行うため streaming にする(東京都の住居点 CSV は約180MB)。
 */
export async function* strictUtf8Lines(path: string): AsyncGenerator<string> {
  yield* strictUtf8LinesFromChunks(
    createReadStream(path) as AsyncIterable<Uint8Array>,
  );
}
