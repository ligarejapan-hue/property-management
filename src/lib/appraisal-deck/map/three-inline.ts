/**
 * 3D 表示の部品(three)を、資料の HTML に直接埋め込める形(ふつうの <script>)にする(2026-11-11)。
 *
 * 資料は外へ通信しない(CSP で外部の読み込みを止めている)ため、three を CDN から読まずに中身を埋め込む。
 * three は ES モジュール(import/export)でしか配られないので、2つのファイル(three.core.js・three.module.js)の
 * import/export の行だけを書き換えて、window.THREE に入れる1本のスクリプトにする。
 * ⚠three の版を上げて形が変わったら、ここで例外を出す(テストが落ちる)=黙って壊れた資料を出さない。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const CORE_SPEC = "'./three.core.js'";

/** `a as b, c` → [[元の名前, 出す名前], ...] */
function parseSpecifiers(list: string): Array<[string, string]> {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
      if (!m) throw new Error(`three: 読めない export/import の形です: ${s.slice(0, 40)}`);
      return [m[1], m[2] ?? m[1]];
    });
}

function countMatches(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

/** three.core.js と three.module.js の中身から、window.THREE を作るスクリプトを組み立てる。 */
export function buildThreeClassicScript(core: string, mod: string): string {
  // three.core.js: import はなく、最後に export { ... }; が1つだけ。
  if (countMatches(core, /^import\s/gm) !== 0) throw new Error("three: core に import があります");
  const coreExports = [...core.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)];
  if (coreExports.length !== 1 || countMatches(core, /^export\s/gm) !== 1) throw new Error("three: core の export の形が想定と違います");
  const coreObj = parseSpecifiers(coreExports[0][1])
    .map(([local, name]) => `${JSON.stringify(name)}:${local}`)
    .join(",");
  const coreBody = core.replace(coreExports[0][0], `const __core={${coreObj}};`);

  // three.module.js: core からの import が1つ、core の再 export が1つ、自分の export が1つ。
  const imports = [...mod.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/three\.core\.js';?\s*$/gm)];
  const reexports = [...mod.matchAll(/^export\s*\{([^}]*)\}\s*from\s*'\.\/three\.core\.js';?\s*$/gm)];
  const ownExports = [...mod.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)];
  if (
    imports.length !== 1 ||
    reexports.length !== 1 ||
    ownExports.length !== 1 ||
    countMatches(mod, /^import\s/gm) !== 1 ||
    countMatches(mod, /^export\s/gm) !== 2 ||
    mod.split(CORE_SPEC).length - 1 !== 2 ||
    /\bimport\s*\(|import\.meta/.test(core + mod)
  ) {
    throw new Error("three: module の import/export の形が想定と違います");
  }
  const destructure = parseSpecifiers(imports[0][1])
    .map(([orig, local]) => (orig === local ? orig : `${orig}:${local}`))
    .join(",");
  const reObj = parseSpecifiers(reexports[0][1])
    .map(([orig, name]) => `${JSON.stringify(name)}:__core[${JSON.stringify(orig)}]`)
    .join(",");
  const ownObj = parseSpecifiers(ownExports[0][1])
    .map(([local, name]) => `${JSON.stringify(name)}:${local}`)
    .join(",");
  const modBody = mod
    .replace(imports[0][0], `const {${destructure}}=__core;`)
    .replace(reexports[0][0], "")
    .replace(ownExports[0][0], `return Object.assign({},__core,{${reObj}},{${ownObj}});`);

  return `(function(){"use strict";\n${coreBody}\nwindow.THREE=Object.freeze((function(){"use strict";\n${modBody}\n})());\n})();`;
}

/**
 * 資料を軽くする(約2.1MB → 約1.3MB)。行の頭の空白と、行まるごとの説明コメント(/** … *\/)だけを除く。
 * 文字列の中身に触れるのは GLSL(シェーダー)の字下げとコメントだけ=動きは変わらない。
 */
export function slimThreeSource(src: string): string {
  return src.replace(/^[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*$\n?/gm, "").replace(/^[ \t]+/gm, "");
}

let cached: string | null = null;

/** 入っている three から作ったスクリプト(サーバーの中で1回だけ作る)。 */
export function threeInlineScript(): string {
  if (cached) return cached;
  const dir = path.join(process.cwd(), "node_modules", "three", "build");
  const read = (f: string) => slimThreeSource(readFileSync(path.join(dir, f), "utf8"));
  const js = buildThreeClassicScript(read("three.core.js"), read("three.module.js"));
  // <script> の中で要素を閉じてしまう並びがないこと(あれば埋め込めない)。
  if (/<\/script/i.test(js)) throw new Error("three: スクリプトに </script が含まれます");
  cached = js;
  return cached;
}
