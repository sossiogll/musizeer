import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { FolderPicker } from "@/components/folders/FolderPicker";
import { ApiErrorMessage } from "@/components/ErrorMessage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useFolderLabel } from "@/hooks/useRoots";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n } from "@/i18n";
import { addRoot, editRoot } from "@/lib/api-client";
import { classifyError } from "@/lib/api-errors";
import { queryKeys } from "@/lib/query-keys";
import type { FolderSettingRef, RootFolder } from "@/types";

/** `add` declares a root folder; `edit` renames one or moves it. */
export type RootTarget = { mode: "add" } | { mode: "edit"; root: RootFolder };

/**
 * Add a root folder (the folder picker, a path that can also be typed, an optional label) or change one. Moving a root
 * that folder settings point at asks first, listing them, and only then sends `confirm` (ADR-0008); the gateway judges the
 * path, so a root it refuses is saved with its reason and the table shows it.
 */
export function RootDialog({ target, onClose }: { target: RootTarget | null; onClose: () => void }) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target && (
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <RootForm target={target} onClose={onClose} />
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

function RootForm({ target, onClose }: { target: RootTarget; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const server = useServerAction();
  const folderLabel = useFolderLabel();
  const labelId = useId();
  const editing = target.mode === "edit" ? target.root : null;
  const [path, setPath] = useState(editing?.path ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  // The settings that move with a root in use, once the administrator is asked.
  const [asking, setAsking] = useState<FolderSettingRef[] | null>(null);

  const cleanPath = path.trim();
  const cleanLabel = label.trim();
  const usedBy = editing?.used_by ?? [];
  const moved = editing !== null && cleanPath !== editing.path;
  // An emptied label keeps the current one: a root always has a name.
  const renamed = editing !== null && cleanLabel !== "" && cleanLabel !== editing.label;
  const changed = editing === null || moved || renamed;

  const save = useMutation({
    mutationFn: (confirm: boolean) => {
      if (!editing) return addRoot({ path: cleanPath, label: cleanLabel || null });
      return editRoot(editing.id, { ...(moved ? { path: cleanPath } : {}), ...(renamed ? { label: cleanLabel } : {}) }, confirm);
    },
    onSuccess: (root) => {
      toast.success(t(editing ? "roots.dialog.saved" : "roots.dialog.added"));
      if (root.state === "refused") toast.warning(t("roots.dialog.refused", { reason: root.reason }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.roots });
      // A root that moved or was refused changes which folders the downloads can use.
      void queryClient.invalidateQueries({ queryKey: queryKeys.viewer });
      onClose();
    },
    onError: (error) => {
      // The list was stale: the root is in use after all. Ask, listing what the server says depends on it.
      const { status, body } = classifyError(error);
      if (status === 409 && body?.error_code === "confirmation_required" && body.used_by) setAsking(body.used_by);
    },
  });

  const submit = () => {
    if (moved && usedBy.length > 0 && asking === null) setAsking(usedBy);
    else save.mutate(asking !== null);
  };

  if (asking !== null) {
    return (
      <>
        <AlertDialogTitle>{t("roots.dialog.moveTitle", { name: editing?.label ?? "" })}</AlertDialogTitle>
        <AlertDialogDescription>{t("roots.dialog.moveBody", { from: editing?.path ?? "", to: cleanPath })}</AlertDialogDescription>
        <ul className="list-inside list-disc text-sm">
          {asking.map((folder) => (
            <li key={folder.key}>{folderLabel(folder)}</li>
          ))}
        </ul>
        {save.error && <ApiErrorMessage error={save.error} fallback={t("roots.dialog.saveFailed")} className="text-sm text-destructive" />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={server.disabled || save.isPending}
            title={server.reason}
            onClick={(event) => {
              event.preventDefault();
              save.mutate(true);
            }}
          >
            {t("roots.dialog.moveConfirm")}
          </AlertDialogAction>
        </div>
      </>
    );
  }

  return (
    <>
      <AlertDialogTitle>{editing ? t("roots.dialog.editTitle", { name: editing.label }) : t("roots.dialog.addTitle")}</AlertDialogTitle>
      <AlertDialogDescription>{t("roots.dialog.description")}</AlertDialogDescription>
      <div className="space-y-4">
        <FolderPicker value={path} onChange={setPath} />

        <div className="space-y-1.5">
          <label htmlFor={labelId} className="text-sm font-medium">
            {t("roots.dialog.label")}
          </label>
          <Input
            id={labelId}
            className="h-11 sm:h-9"
            autoComplete="off"
            maxLength={80}
            placeholder={t("roots.dialog.labelPlaceholder")}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("roots.dialog.labelHint")}</p>
        </div>

        {moved && usedBy.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("roots.dialog.moveWarning", { count: usedBy.length })}
          </p>
        )}

        {save.error && <ApiErrorMessage error={save.error} fallback={t("roots.dialog.saveFailed")} className="text-sm text-destructive" />}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
        <AlertDialogAction
          disabled={cleanPath === "" || !changed || server.disabled || save.isPending}
          title={server.reason}
          onClick={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {editing ? t("roots.dialog.save") : t("roots.dialog.add")}
        </AlertDialogAction>
      </div>
    </>
  );
}
