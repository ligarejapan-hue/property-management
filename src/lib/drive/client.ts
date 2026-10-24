/**
 * Google ドライブ API(v3)の薄い包み(第2段)。REST を fetch で直接呼ぶ(npm の部品なし)。
 * ⚠ファイル名・フォルダ名は所有者名を含み得る=例外のメッセージに名前を入れない。
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";

export class DriveApiError extends Error {
  readonly status: number;
  readonly needsReconnect: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.needsReconnect = status === 401;
  }
}

export type DriveFolderSummary = { id: string; name: string; ownedByMe: boolean; ownerEmail: string | null };
export type DriveFolderDetail = { id: string; name: string; parents: string[]; trashed: boolean; webViewLink: string | null };

/** Drive の検索式の文字列の中で ' と \ を逃がす。 */
export function escapeDriveQueryValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type RawFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  ownedByMe?: boolean;
  owners?: { emailAddress?: string }[];
  webViewLink?: string;
};

export class DriveClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const u = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.fetchFn(u.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new DriveApiError(res.status, `Google ドライブの API が ${res.status} を返しました`);
    return (await res.json()) as T;
  }

  async about(): Promise<{ emailAddress: string }> {
    const j = await this.getJson<{ user?: { emailAddress?: string } }>("/about", { fields: "user(emailAddress)" });
    return { emailAddress: j?.user?.emailAddress ?? "" };
  }

  /** フォルダの一覧。parent="root"(マイドライブ直下)|"shared"(共有されたもの)|フォルダ id。 */
  async listFolders(args: {
    parent: string;
    nameContains?: string;
    pageToken?: string;
  }): Promise<{ folders: DriveFolderSummary[]; nextPageToken: string | null }> {
    const where: string[] = [`mimeType = '${FOLDER_MIME}'`, "trashed = false"];
    if (args.parent === "shared") where.push("sharedWithMe = true");
    else where.push(`'${escapeDriveQueryValue(args.parent)}' in parents`);
    if (args.nameContains && args.nameContains.trim() !== "") {
      where.push(`name contains '${escapeDriveQueryValue(args.nameContains.trim())}'`);
    }
    const j = await this.getJson<{ files?: RawFile[]; nextPageToken?: string }>("/files", {
      q: where.join(" and "),
      fields: "nextPageToken,files(id,name,mimeType,ownedByMe,owners(emailAddress))",
      orderBy: "name",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    });
    return {
      folders: (j?.files ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        ownedByMe: f.ownedByMe === true,
        ownerEmail: f.owners?.[0]?.emailAddress ?? null,
      })),
      nextPageToken: j?.nextPageToken ?? null,
    };
  }

  /** フォルダ1つ。無い/フォルダでない → null。 */
  async getFolder(id: string): Promise<DriveFolderDetail | null> {
    const f = await this.getJson<RawFile>(`/files/${encodeURIComponent(id)}`, {
      fields: "id,name,mimeType,parents,trashed,webViewLink",
      supportsAllDrives: "true",
    });
    if (!f || f.mimeType !== FOLDER_MIME) return null;
    return { id: f.id, name: f.name, parents: f.parents ?? [], trashed: f.trashed === true, webViewLink: f.webViewLink ?? null };
  }

  /** 「親 › 子」の形の道(最大4段・マイドライブの根は含めない)。 */
  async folderPath(id: string): Promise<string> {
    const names: string[] = [];
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 4; depth++) {
      const f: DriveFolderDetail | null = await this.getFolder(cur);
      if (!f) break;
      if (f.parents.length === 0) break; // 根(マイドライブ)は名前に含めない
      names.unshift(f.name);
      cur = f.parents[0] ?? null;
    }
    return names.join(" › ");
  }
}
