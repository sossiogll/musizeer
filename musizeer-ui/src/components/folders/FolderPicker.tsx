import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, HardDrive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { browseRoots } from "@/lib/api-client";
import { classifyError } from "@/lib/api-errors";
import { useErrorText } from "@/lib/error-text";
import { queryKeys } from "@/lib/query-keys";
import { cn, formatBytes } from "@/lib/utils";
import type { RootBrowse } from "@/types";

interface FolderPickerProps {
  /** The absolute path chosen (or typed). */
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
  /**
   * Limits the picker to this folder (the path of a root folder): it opens there, lists only what is inside it and has
   * nothing above it to go back to. The path cannot be typed then.
   */
  scope?: string;
}

/** Whether `path` is `base` or lies under it (both absolute and normalized). */
const within = (path: string, base: string) => path === base || path.startsWith(`${base.replace(/\/+$/, "")}/`);

/**
 * The places to go back to from a folder: the volume itself (or `base`, when given) and each folder down to `path`.
 * Nothing above the starting point is ever offered.
 */
export function breadcrumbs(browse: RootBrowse, base?: string): { path: string | null; name: string }[] {
  const start = base ?? browse.volume?.mount_point;
  if (!browse.path || !start || !within(browse.path, start)) return [];
  const mount = start;
  const crumbs: { path: string | null; name: string }[] = [{ path: mount, name: mount }];
  let walked = mount;
  for (const part of browse.path.slice(mount.length).split("/").filter(Boolean)) {
    walked = `${walked.replace(/\/+$/, "")}/${part}`;
    crumbs.push({ path: walked, name: part });
  }
  return crumbs;
}

/**
 * The folder picker of a root folder (ADR-0008): the mounted volumes first, then the folders inside one, with the way back
 * shown as a breadcrumb. It only ever lists what the gateway lists (subdirectories of mounted volumes, never files), so
 * a path outside a volume cannot be reached by clicking; one that is typed is checked by the server when it is saved.
 * Opening a folder chooses it; the path can also be typed.
 */
export function FolderPicker({ value, onChange, disabled, scope }: FolderPickerProps) {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const ids = { path: useId(), list: useId() };
  // The folder being looked at (null: the mounted volumes); the chosen path is `value`.
  const [location, setLocation] = useState<string | null>(scope ?? null);
  const { data, isFetching, error } = useQuery({
    queryKey: queryKeys.rootBrowse(location),
    queryFn: () => browseRoots(location),
    staleTime: 10_000,
    retry: false,
  });

  const open = (path: string | null) => {
    // A scoped picker never leaves its folder, whatever it is asked.
    if (scope && (path === null || !within(path, scope))) return;
    setLocation(path);
    if (path) onChange(path);
  };
  const failure = error ? classifyError(error).body : null;
  const crumbs = data ? breadcrumbs(data, scope) : [];

  return (
    <div className="space-y-3">
      {!scope && (
      <div className="space-y-1.5">
        <label htmlFor={ids.path} className="text-sm font-medium">
          {t("roots.dialog.path")}
        </label>
        <div className="flex gap-2">
          <Input
            id={ids.path}
            className="h-11 font-mono sm:h-9"
            autoComplete="off"
            spellCheck={false}
            placeholder="/library"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                open(value.trim() || null);
              }
            }}
          />
          <Button type="button" variant="outline" disabled={disabled || value.trim() === ""} onClick={() => open(value.trim())}>
            {t("roots.picker.browse")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("roots.dialog.pathHint")}</p>
      </div>
      )}

      <nav aria-label={t("roots.picker.location")}>
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
          {!scope && (
            <Crumb current={location === null} onSelect={() => open(null)}>
              {t("roots.picker.volumes")}
            </Crumb>
          )}
          {crumbs.map((crumb, index) => (
            <Crumb key={crumb.path} current={index === crumbs.length - 1} onSelect={() => open(crumb.path)} mono>
              {crumb.name}
            </Crumb>
          ))}
        </ol>
      </nav>

      <div
        id={ids.list}
        aria-busy={isFetching}
        className={cn("max-h-56 overflow-y-auto rounded-lg border", isFetching && "opacity-70")}
      >
        {failure || error ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {errorText(failure?.error_code, failure?.error_message ?? t("roots.picker.failed"))}
            {failure?.error_message && failure.error_code === "gateway_refused" && (
              <span className="block text-xs text-muted-foreground">{failure.error_message}</span>
            )}
          </p>
        ) : !data ? (
          <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            {t("roots.picker.loading")}
          </p>
        ) : data.directories.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t(location === null ? "roots.picker.noVolumes" : "roots.picker.empty")}</p>
        ) : (
          <ul aria-label={t(location === null ? "roots.picker.volumes" : "roots.picker.folders")}>
            {data.directories.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => open(entry.path)}
                  aria-current={entry.path === value ? "true" : undefined}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-9",
                    entry.path === value && "bg-muted font-medium",
                  )}
                >
                  {location === null ? <HardDrive aria-hidden className="size-4 shrink-0" /> : <Folder aria-hidden className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                  {location === null && entry.free_bytes ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{t("roots.picker.free", { size: formatBytes(entry.free_bytes, locale) })}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {data?.truncated && <p className="text-xs text-muted-foreground">{t("roots.picker.truncated")}</p>}
    </div>
  );
}

function Crumb({ current, onSelect, mono, children }: { current: boolean; onSelect: () => void; mono?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1 [&:not(:first-child)]:before:content-['/'] before:text-muted-foreground">
      {current ? (
        <span aria-current="location" className={cn("px-1 font-medium", mono && "font-mono")}>
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={cn("rounded-sm px-1 text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mono && "font-mono")}
        >
          {children}
        </button>
      )}
    </li>
  );
}
