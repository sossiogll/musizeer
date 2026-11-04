import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiErrorMessage } from "@/components/ErrorMessage";
import { FolderControl } from "@/components/folders/FolderControl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFolderLabel } from "@/hooks/useRoots";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n } from "@/i18n";
import { patchSettings } from "@/lib/api-client";
import { folderPathProblem, readFolderValue } from "@/lib/folders";
import { queryKeys } from "@/lib/query-keys";
import type { FolderSetting, FolderValue } from "@/types";

interface FolderDialogProps {
  /** The folder setting being edited; `null` keeps the dialog closed. */
  folder: FolderSetting | null;
  onClose: () => void;
  /** The control's call to action when there is no root folder yet. */
  onAddRoot: () => void;
}

/** Edits one folder setting (the working folder, a provider's folder) with the same control the settings use. */
export function FolderDialog({ folder, onClose, onAddRoot }: FolderDialogProps) {
  return (
    <AlertDialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      {folder && (
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <FolderForm folder={folder} onClose={onClose} onAddRoot={onAddRoot} />
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

function FolderForm({ folder, onClose, onAddRoot }: { folder: FolderSetting; onClose: () => void; onAddRoot: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const server = useServerAction();
  const folderLabel = useFolderLabel();
  const [value, setValue] = useState<FolderValue | null>(readFolderValue(folder.root_id ? { root_id: folder.root_id, path: folder.path } : null));
  const name = folderLabel(folder);

  const save = useMutation({
    mutationFn: () => patchSettings({ [folder.key]: value }),
    onSuccess: () => {
      toast.success(t("settings.saved"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.roots });
      void queryClient.invalidateQueries({ queryKey: ["settings-values"] });
      // Whether downloads can work is the status of the viewer.
      void queryClient.invalidateQueries({ queryKey: queryKeys.viewer });
      onClose();
    },
  });

  return (
    <>
      <AlertDialogTitle>{t("roots.folderDialog.title", { name })}</AlertDialogTitle>
      <AlertDialogDescription>{folder.detail || t("roots.folderDialog.description")}</AlertDialogDescription>
      <FolderControl value={value} onChange={setValue} label={name} suggestedPath={folder.suggested_path} onAddRoot={onAddRoot} />
      {save.error && <ApiErrorMessage error={save.error} fallback={t("settings.saveFailed")} className="text-sm text-destructive" />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
        <AlertDialogAction
          disabled={(value !== null && folderPathProblem(value.path) !== null) || server.disabled || save.isPending}
          title={server.reason}
          onClick={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {t("common.save")}
        </AlertDialogAction>
      </div>
    </>
  );
}
