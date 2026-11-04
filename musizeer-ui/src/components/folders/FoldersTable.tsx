import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFolderLabel } from "@/hooks/useRoots";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n, type MessageKey } from "@/i18n";
import type { FolderSetting, FolderState } from "@/types";

const STATE: Record<FolderState, { variant: "success" | "warning" | "destructive"; labelKey: MessageKey }> = {
  set: { variant: "success", labelKey: "roots.folderState.set" },
  not_set: { variant: "warning", labelKey: "roots.folderState.not_set" },
  root_missing: { variant: "destructive", labelKey: "roots.folderState.root_missing" },
  root_refused: { variant: "destructive", labelKey: "roots.folderState.root_refused" },
  invalid: { variant: "destructive", labelKey: "roots.folderState.invalid" },
};

interface FoldersTableProps {
  folders: FolderSetting[];
  onEdit: (folder: FolderSetting) => void;
}

/**
 * Every folder setting (the working folder and the library folder of each storage provider that has one): the folder it
 * resolves to, whether it is set and why not, and the action to change it. The rows come from the server, so a provider
 * that declares a folder setting appears here without a line of this page knowing it.
 */
export function FoldersTable({ folders, onEdit }: FoldersTableProps) {
  const { t } = useI18n();
  const server = useServerAction();
  const folderLabel = useFolderLabel();

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="sr-only">{t("roots.foldersHeading")}</caption>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t("roots.folderColumns.folder")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("roots.folderColumns.resolved")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.state")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("roots.columns.actions")}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {folders.map((folder) => {
            const state = STATE[folder.state];
            const name = folderLabel(folder);
            return (
              <tr key={folder.key} className="align-top">
                <th scope="row" className="px-3 py-2.5 font-medium">{name}</th>
                <td className="px-3 py-2.5 font-mono text-xs">{folder.resolved ?? <span className="font-sans text-muted-foreground">—</span>}</td>
                <td className="space-y-1 px-3 py-2.5">
                  <Badge variant={state.variant}>{t(state.labelKey)}</Badge>
                  {folder.state !== "set" && folder.detail && <p className="max-w-sm text-xs text-muted-foreground">{folder.detail}</p>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" aria-label={t("roots.folderEdit", { name })} disabled={server.disabled} title={server.reason} onClick={() => onEdit(folder)}>
                      <Pencil aria-hidden />
                      {t("roots.folderEditShort")}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
