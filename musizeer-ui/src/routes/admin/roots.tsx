import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { ApiErrorMessage } from "@/components/ErrorMessage";
import { FolderDialog } from "@/components/folders/FolderDialog";
import { FoldersTable } from "@/components/folders/FoldersTable";
import { OtherToolsTable } from "@/components/folders/OtherToolsTable";
import { RootDialog, type RootTarget } from "@/components/folders/RootDialog";
import { RootsTable } from "@/components/folders/RootsTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMappings, useRoots } from "@/hooks/useRoots";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n } from "@/i18n";

/**
 * Administration › Root folders, modelled on the root folders of Lidarr's Media Management (ADR-0008):
 *
 * - Root folders: the places mounted in the containers that the product may use, with the gateway's verdict on each, the
 *   explicit Check, and which folder settings use it.
 * - Folders: every folder setting (the working folder, a storage provider's library folder), each a root folder plus a
 *   path inside it, edited here with the same control the settings use.
 * - Other tools: the programs that import into the library by themselves (mapped by a probe) and the music servers that
 *   read it (the full-sync verification).
 *
 * `?folder=<setting>` opens the dialog of that folder: it is where the warning of a missing folder leads. Nothing here
 * knows a provider by name; the rows and their labels come from the server.
 */
export function AdminRootsPage() {
  const { t } = useI18n();
  const server = useServerAction();
  const navigate = useNavigate({ from: "/admin/roots" });
  const { folder: folderKey } = useSearch({ strict: false }) as { folder?: string };
  const [rootTarget, setRootTarget] = useState<RootTarget | null>(null);
  const { data, isLoading, error } = useRoots();
  const tools = useMappings();

  const editingFolder = data?.folders.find((folder) => folder.key === folderKey) ?? null;
  const closeFolder = () => void navigate({ search: {}, replace: true });

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">{t("roots.intro")}</p>

      <section aria-label={t("roots.heading")} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold">{t("roots.heading")}</h2>
          <Button size="sm" disabled={server.disabled} title={server.reason} onClick={() => setRootTarget({ mode: "add" })}>
            <Plus aria-hidden className="mr-1" />
            {t("roots.add")}
          </Button>
        </div>
        {isLoading && <Skeleton className="h-24 w-full" />}
        {error && <ApiErrorMessage error={error} fallback={t("roots.loadFailed")} className="text-sm text-destructive" />}
        {data && data.roots.length === 0 && <p className="text-sm text-muted-foreground">{t("roots.empty")}</p>}
        {data && data.roots.length > 0 && <RootsTable roots={data.roots} onEdit={(root) => setRootTarget({ mode: "edit", root })} />}
      </section>

      <section aria-label={t("roots.foldersHeading")} className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold">{t("roots.foldersHeading")}</h2>
          <p className="text-sm text-muted-foreground">{t("roots.foldersIntro")}</p>
        </div>
        {isLoading && <Skeleton className="h-24 w-full" />}
        {data && data.folders.length === 0 && <p className="text-sm text-muted-foreground">{t("roots.foldersEmpty")}</p>}
        {data && data.folders.length > 0 && (
          <FoldersTable folders={data.folders} onEdit={(folder) => void navigate({ search: { folder: folder.key }, replace: true })} />
        )}
      </section>

      <section aria-label={t("roots.tools.heading")} className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold">{t("roots.tools.heading")}</h2>
          <p className="text-sm text-muted-foreground">{t("roots.tools.intro")}</p>
        </div>
        {tools.isLoading && <Skeleton className="h-16 w-full" />}
        {tools.error && <ApiErrorMessage error={tools.error} fallback={t("roots.tools.loadFailed")} className="text-sm text-destructive" />}
        {tools.data && !tools.data.library.set && <p className="text-sm text-muted-foreground">{t("roots.tools.libraryNotSet")}</p>}
        {tools.data && tools.data.delegates.length + tools.data.music_servers.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("roots.tools.empty")}</p>
        )}
        {tools.data && tools.data.delegates.length + tools.data.music_servers.length > 0 && <OtherToolsTable overview={tools.data} />}
      </section>

      <RootDialog target={rootTarget} onClose={() => setRootTarget(null)} />
      <FolderDialog
        folder={editingFolder}
        onClose={closeFolder}
        onAddRoot={() => {
          closeFolder();
          setRootTarget({ mode: "add" });
        }}
      />
    </div>
  );
}
