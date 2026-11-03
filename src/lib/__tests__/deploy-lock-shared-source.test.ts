// 本番反映の2つの経路(手元の反映スクリプト・GitHub Actions の pm-deploy)が同じ鍵で排他する配線の固定テスト。
//
// 背景(2026-11-02): 手元のスクリプトは /root/pm-deploy.lock、Actions 側は /run/pm-deploy.lock を使っていて、
// 2 つの経路が同時に走ると互いを止められなかった。2026-11-03 のユーザー指示で、手元のスクリプトの鍵を
// Actions 側と同じ /run/pm-deploy.lock にそろえ、もう一方が動いていれば待つ(待ちきれなければ何も変えずに止まる)。
// あわせて、migration がある回は反映前に DB のバックアップを取る(2026-11-01 のユーザー指示)ことも固定する。
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8").replace(/\r\n/g, "\n");
}

const LOCK = "/run/pm-deploy.lock";
const local = readRepoFile("deploy/vps/pm-deploy-local.sh");
const actions = readRepoFile("deploy/vps/pm-deploy.sh");
const deployDoc = readRepoFile("docs/deploy.md");
const claudeMd = readRepoFile("CLAUDE.md");

describe("本番反映の鍵(2つの経路で共通)", () => {
  it("Actions 側(pm-deploy)は /run/pm-deploy.lock を flock する", () => {
    expect(actions).toContain(`exec 9>${LOCK}`);
    expect(actions).toMatch(/flock -n 9/);
  });

  it("手元の反映スクリプトも同じ /run/pm-deploy.lock を使う", () => {
    expect(local).toContain(`LOCK=${LOCK}`);
    expect(local).toContain('exec 9>"$LOCK"');
  });

  it("手元の反映スクリプトは、鍵が取れないとき待ち、待ちきれなければ LOCKED で止まる", () => {
    expect(local).toMatch(/flock -n 9 \|\|/);
    expect(local).toMatch(/flock -w "\$LOCK_WAIT" 9/);
    expect(local).toContain("LOCKED");
  });

  it("鍵を取る前に本番を変えない(fetch・ff・npm ci・restart より前に鍵を取る)", () => {
    const lockAt = local.indexOf('exec 9>"$LOCK"');
    for (const op of ["fetch origin", "merge --ff-only", "npm ci", "systemctl restart"]) {
      const at = local.indexOf(op);
      expect(at, op).toBeGreaterThan(lockAt);
    }
  });

  it("待っている間に別の経路が同じ版まで進めていても、途中で終わらずに作り直す(相手の失敗を残さない)", () => {
    expect(local).toContain("SAME_VERSION_AFTER_WAIT");
    expect(local).not.toMatch(/WAITED"? = 1[^\n]*exit 0/);
  });
});

// 鍵の部分を実際に動かして確かめる(flock がある環境=CI の Ubuntu だけ。Windows の Git Bash には無いので飛ばす)。
// スクリプトから「LOCK=… から cd /opt/property-management の前まで」を抜き出し、鍵の場所だけ一時ファイルに差し替える。
const hasFlock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;
describe.skipIf(!hasFlock)("鍵の動き(実際に flock する)", () => {
  const start = local.indexOf(`LOCK=${LOCK}`);
  const end = local.indexOf("cd /opt/property-management");
  const block = local.slice(start, end);

  function run(holdSeconds: number, lockWait: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-lock-"));
    const newLock = path.join(dir, "new.lock");
    const oldLock = path.join(dir, "old.lock");
    const body = block.split(LOCK).join(newLock).split("/root/pm-deploy.lock").join(oldLock);
    const hold = holdSeconds > 0 ? `flock "${newLock}" sleep ${holdSeconds} & sleep 0.5\n` : "";
    const script = `set -euo pipefail\nLOCK_WAIT=${lockWait}\n${hold}${body}\necho GOT_LOCK\n`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 20_000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("誰も持っていなければ、待たずに鍵を取る", () => {
    const r = run(0, 5);
    expect(r.status).toBe(0);
    expect(r.out).toContain("GOT_LOCK");
    expect(r.out).not.toContain("WAITING_LOCK");
  });

  it("もう一方が持っていれば待ち、空いたら鍵を取る", () => {
    const r = run(2, 10);
    expect(r.status).toBe(0);
    expect(r.out).toContain("WAITING_LOCK");
    expect(r.out).toContain("LOCK_ACQUIRED");
    expect(r.out).toContain("GOT_LOCK");
  });

  it("待ちきれなければ LOCKED で止まり、先へ進まない", () => {
    const r = run(4, 1);
    expect(r.status).toBe(1);
    expect(r.out).toContain("LOCKED");
    expect(r.out).not.toContain("GOT_LOCK");
  });
});

describe("migration がある回のバックアップ", () => {
  it("手元の反映スクリプトは prisma migrate deploy の前に pg_dump で控えを取り、読めるか確かめる", () => {
    const dumpAt = local.indexOf("pg_dump");
    const checkAt = local.indexOf("pg_restore --list");
    const migrateAt = local.indexOf("prisma migrate deploy");
    expect(dumpAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(dumpAt);
    expect(migrateAt).toBeGreaterThan(checkAt);
  });
});

describe("決まりの文書", () => {
  it("CLAUDE.md §13 は、手元の反映スクリプトでの反映・1セッションだけ・反映以外の SSH をしないことを書く", () => {
    const s13 = claudeMd.slice(claudeMd.indexOf("## 13."), claudeMd.indexOf("## 14."));
    expect(s13).toContain("deploy/vps/pm-deploy-local.sh");
    expect(s13).toContain("1 つのセッションだけ");
    expect(s13).toContain(LOCK);
    expect(s13).not.toContain("Claude Code は VPS へ直接 SSH しない");
  });

  it("docs/deploy.md は手元の反映スクリプトの使い方と共通の鍵を書く", () => {
    expect(deployDoc).toContain("deploy/vps/pm-deploy-local.sh");
    expect(deployDoc).toContain(LOCK);
    expect(deployDoc).not.toContain("Claude Code は手元から VPS へ直接反映するスクリプト");
  });
});
