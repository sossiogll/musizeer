import type { FolderValue, ViewerFolderName, ViewerFolders } from "@/types";

/** The longest path inside a root the server accepts (sdk `musizeer_sdk.folders.MAX_PATH`). */
export const MAX_FOLDER_PATH = 4096;

/** Why a path cannot be a path inside a root folder: the same rule the server judges by (the server stays the judge). */
export type FolderPathProblem = "too_long" | "nul" | "absolute" | "empty_segment" | "dot" | "dotdot";

/**
 * Whether `path` can be the path inside a root folder: relative, no empty, `.` or `..` segment, no NUL. The empty string is the
 * root itself and is fine. Only to answer while the administrator types; the server refuses what it must.
 */
export function folderPathProblem(path: string): FolderPathProblem | null {
  if (path.length > MAX_FOLDER_PATH) return "too_long";
  if (path.includes("\0")) return "nul";
  if (path === "") return null;
  if (path.startsWith("/")) return "absolute";
  for (const part of path.split("/")) {
    if (part === "") return "empty_segment";
    if (part === ".") return "dot";
    if (part === "..") return "dotdot";
  }
  return null;
}

/** The folder a root and a path inside it name: what the server resolves a value to. */
export function joinFolder(rootPath: string, path: string): string {
  if (path === "") return rootPath;
  return `${rootPath.replace(/\/+$/, "")}/${path}`;
}

/** The path of `folder` inside the root folder at `rootPath` (the inverse of `joinFolder`), or null when it is not inside it. */
export function relativeToRoot(rootPath: string, folder: string): string | null {
  const base = rootPath.replace(/\/+$/, "");
  if (folder === base) return "";
  return folder.startsWith(`${base}/`) ? folder.slice(base.length + 1) : null;
}

/** The value a `folder` setting holds, when it holds one (the API sends `null` for an unset folder). */
export function readFolderValue(raw: unknown): FolderValue | null {
  if (!raw || typeof raw !== "object") return null;
  const { root_id, path } = raw as Partial<FolderValue>;
  return typeof root_id === "string" && root_id !== "" ? { root_id, path: typeof path === "string" ? path : "" } : null;
}

/** The folders the viewer status says are missing, each with the state it reported. */
export function missingFolders(folders: ViewerFolders | null | undefined): { name: ViewerFolderName; folder: ViewerFolders[ViewerFolderName] }[] {
  if (!folders || folders.ready) return [];
  return folders.missing.map((name) => ({ name, folder: folders[name] }));
}
