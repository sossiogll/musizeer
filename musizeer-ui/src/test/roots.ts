import type { FolderSetting, RootCheck, RootFolder, ViewerFolder, ViewerFolders } from "@/types";

/** Fixtures of the root folders (ADR-0008): no provider is named after a real one. */
export const root = (overrides: Partial<RootFolder> = {}): RootFolder => ({
  id: "r1",
  label: "Library",
  path: "/library",
  state: "accepted",
  reason: "",
  checked_at: "2026-10-25T10:00:00+00:00",
  created_at: "2026-10-25T09:00:00+00:00",
  used_by: [],
  ...overrides,
});

export const folder = (overrides: Partial<FolderSetting> = {}): FolderSetting => ({
  key: "workspace_dir",
  label: "Cartella di lavoro",
  group: "files",
  root_id: null,
  path: null,
  resolved: null,
  state: "not_set",
  detail: "The working folder is not set",
  suggested_path: ".musizeer-work",
  ...overrides,
});

/** A storage provider's library folder, as a provider declares it (an invented provider). */
export const libraryFolder = (overrides: Partial<FolderSetting> = {}): FolderSetting =>
  folder({ key: "provider.demo_storage.root_dir", label: "Library folder", group: "demo_storage", suggested_path: null, detail: "", ...overrides });

export const checkReport = (overrides: Partial<RootCheck> = {}): RootCheck => ({
  root: root(),
  gateway: {
    ok: true,
    path: "/library",
    exists: true,
    directory: true,
    writable: true,
    mounted: true,
    reason: "",
    device: "8:1",
    mount_id: 31,
    mount_point: "/library",
    fs_type: "ext4",
    free_bytes: 500 * 1024 ** 3,
    real_path: "/library",
    write_test: { ok: true },
  },
  gateway_error: null,
  application: { exists: true, writable: true },
  checks: [{ code: "gateway_ok", level: "ok", params: {} }, { code: "application_ok", level: "ok", params: {} }],
  state: "ok",
  ok: true,
  ...overrides,
});

const SET: ViewerFolder = { set: true, state: "set", applicable: true };

/** `folders` of the viewer status when both folders are set. */
export const FOLDERS_READY: ViewerFolders = { ready: true, missing: [], working_folder: SET, library_folder: SET };

/** `folders` of the viewer status while the working folder is not set; administrators also get `setting` and `detail`. */
export function foldersMissing(options: { admin?: boolean; library?: boolean } = {}): ViewerFolders {
  const working: ViewerFolder = {
    set: false,
    state: "not_set",
    applicable: true,
    ...(options.admin ? { setting: "workspace_dir", detail: "The working folder is not set" } : {}),
  };
  const library: ViewerFolder = options.library
    ? { set: false, state: "root_refused", applicable: true, ...(options.admin ? { setting: "provider.demo_storage.root_dir", detail: "The root folder Library is refused: not writable" } : {}) }
    : SET;
  return { ready: false, missing: options.library ? ["working_folder", "library_folder"] : ["working_folder"], working_folder: working, library_folder: library };
}
