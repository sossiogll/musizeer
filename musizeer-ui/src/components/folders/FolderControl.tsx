import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, FolderSearch, Wand2, X } from "lucide-react";
import { FolderPicker } from "@/components/folders/FolderPicker";
import { ApiErrorMessage } from "@/components/ErrorMessage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useRoots } from "@/hooks/useRoots";
import { useI18n } from "@/i18n";
import { folderPathProblem, joinFolder, readFolderValue, relativeToRoot } from "@/lib/folders";
import type { FolderValue } from "@/types";

interface FolderControlProps {
  /** What the setting holds: a `{root_id, path}`, or nothing. */
  value: unknown;
  /** `null` clears the folder: an unset folder is unset, never a guess (ADR-0008). */
  onChange: (value: FolderValue | null) => void;
  /** The accessible name of the whole control (the setting's label). */
  label: string;
  /** `suggested_path` of the setting: shown as the placeholder of the path, never applied by itself. */
  suggestedPath?: string | null;
  disabled?: boolean;
  /** Where "Add a root folder" leads when there is none: the Root folders page, unless the control is already on it. */
  onAddRoot?: () => void;
}

/**
 * A `folder` setting (ADR-0008): a root folder chosen from the ones the administrator declared, and a path inside it,
 * with the folder they resolve to shown as the administrator types. There is no default root: until one is chosen the
 * folder is not set. Used by the generated settings, the provider cards and the folders table of Administration › Root
 * folders; the server judges the value (its refusals are worded by `useErrorText`).
 */
export function FolderControl({ value, onChange, label, suggestedPath, disabled, onAddRoot }: FolderControlProps) {
  const { t } = useI18n();
  const ids = { root: useId(), path: useId(), note: useId() };
  const { data, isLoading, error } = useRoots();
  const [browsing, setBrowsing] = useState(false);
  const current = readFolderValue(value);

  if (isLoading) return <Skeleton className="h-9 w-full max-w-xl" />;
  if (error) return <ApiErrorMessage error={error} fallback={t("folders.control.loadFailed")} className="text-sm text-destructive" />;

  const roots = data?.roots ?? [];
  if (roots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("folders.control.noRoots")}{" "}
        {onAddRoot ? (
          <Button type="button" variant="link" className="h-auto p-0" onClick={onAddRoot}>
            {t("folders.control.addRoot")}
          </Button>
        ) : (
          <Link to="/admin/roots" className="font-medium text-primary underline-offset-4 hover:underline">
            {t("folders.control.addRoot")}
          </Link>
        )}
      </p>
    );
  }

  const root = roots.find((candidate) => candidate.id === current?.root_id);
  const path = current?.path ?? "";
  const problem = folderPathProblem(path);
  const suggestion = suggestedPath && path !== suggestedPath ? suggestedPath : null;
  const note = root?.state === "refused" ? t("folders.control.rootRefused", { reason: root.reason }) : null;

  return (
    <div role="group" aria-label={label} className="w-full max-w-xl space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="space-y-1 sm:w-56 sm:shrink-0">
          <label htmlFor={ids.root} className="text-xs font-medium text-muted-foreground">
            {t("folders.control.root")}
          </label>
          <Select
            id={ids.root}
            className="w-full"
            value={root?.id ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value ? { root_id: event.target.value, path } : null)}
          >
            <option value="">{t("folders.control.chooseRoot")}</option>
            {roots.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} ({candidate.path})
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={ids.path} className="text-xs font-medium text-muted-foreground">
            {t("folders.control.path")}
          </label>
          <Input
            id={ids.path}
            className="h-11 font-mono sm:h-9"
            autoComplete="off"
            spellCheck={false}
            placeholder={suggestedPath ?? ""}
            value={path}
            disabled={disabled || !root}
            aria-invalid={problem !== null}
            aria-describedby={ids.note}
            onChange={(event) => root && onChange({ root_id: root.id, path: event.target.value })}
          />
        </div>
      </div>

      <div id={ids.note} aria-live="polite" className="space-y-1 text-xs">
        {root && problem === null && (
          <p className="text-muted-foreground">
            {t("folders.control.resolvesTo")} <code className="break-all font-mono text-foreground">{joinFolder(root.path, path)}</code>
          </p>
        )}
        {problem !== null && <p className="text-destructive">{t(`folders.pathProblem.${problem}`)}</p>}
        {!root && <p className="text-muted-foreground">{t("folders.control.notSet")}</p>}
        {note && (
          <p className="flex items-start gap-1 text-warning">
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
            {note}
          </p>
        )}
      </div>

      {root && browsing && (
        // Scoped to the root: it opens there and has nothing above it. Opening a folder fills the path relative to the root.
        <FolderPicker
          key={root.id}
          scope={root.path}
          value={joinFolder(root.path, path)}
          disabled={disabled}
          onChange={(picked) => {
            const relative = relativeToRoot(root.path, picked);
            if (relative !== null) onChange({ root_id: root.id, path: relative });
          }}
        />
      )}

      {(root || current) && (
        <div className="flex flex-wrap gap-2">
          {root && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
              <FolderSearch aria-hidden />
              {t(browsing ? "folders.control.closeBrowse" : "folders.control.browse")}
            </Button>
          )}
          {root && suggestion && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ root_id: root.id, path: suggestion })}>
              <Wand2 aria-hidden />
              {t("folders.control.useSuggestion", { path: suggestion })}
            </Button>
          )}
          {current && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
              <X aria-hidden />
              {t("folders.control.clear")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
