import { useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCan } from "@/hooks/useCapabilities";
import { useServerAction, type ServerActionState } from "@/hooks/useServerAction";
import { useI18n, type MessageKey } from "@/i18n";
import { missingFolders } from "@/lib/folders";
import type { ViewerFolder, ViewerFolderName } from "@/types";

export interface FolderStatus {
  /** A folder the downloads need is not set (the server's word, `folders` of the viewer status). */
  blocked: boolean;
  /** Which ones, with what the server reported about each (`setting` and `detail` only for administrators). */
  missing: { name: ViewerFolderName; folder: ViewerFolder }[];
}

/**
 * Whether downloads can work, as GET /auth/account/status says (ADR-0008): the working folder and the library folder are
 * set. A viewer the status says nothing about (a guest, an older server) is not blocked here: the server still refuses
 * what it must, with `working_folder_not_set` / `library_folder_not_set`.
 */
export function useFolderStatus(): FolderStatus {
  const { authConfig } = useAuth();
  const folders = authConfig?.folders;
  return useMemo(() => {
    const missing = missingFolders(folders);
    return { blocked: missing.length > 0, missing };
  }, [folders]);
}

/** What an administrator is told about a missing folder; anyone else only learns downloads are not set up. */
export const MISSING_FOLDER_TEXT: Record<ViewerFolderName, MessageKey> = {
  working_folder: "folders.blocked.working",
  library_folder: "folders.blocked.library",
};

/**
 * The gate every download action goes through before it is offered: disabled, with the reason as its tooltip, while the
 * server is unreachable (`useServerAction`) or a folder the downloads need is not set. The server stays the judge: a
 * download that gets past a stale screen is refused with a 409 and the same reason, worded by `useFailureToast`.
 */
export function useDownloadGate(): ServerActionState {
  const server = useServerAction();
  const { blocked, missing } = useFolderStatus();
  const admin = useCan("admin");
  const { t } = useI18n();
  if (server.disabled) return server;
  if (!blocked) return { disabled: false, reason: undefined };
  return { disabled: true, reason: admin ? t(MISSING_FOLDER_TEXT[missing[0].name]) : t("folders.blocked.user") };
}
