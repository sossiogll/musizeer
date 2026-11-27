import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Search, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n, type MessageKey } from "@/i18n";
import { deleteMapping, typeMapping, verifyMapping } from "@/lib/api-client";
import { absoluteTime } from "@/lib/dates";
import { useErrorText, useFailureToast } from "@/lib/error-text";
import { queryKeys } from "@/lib/query-keys";
import type { DelegateTool, MappingOverview, MappingState, MusicServerTool, RootMapping } from "@/types";

type Look = { variant: "success" | "warning" | "destructive" | "secondary"; labelKey: MessageKey };

const STATE: Record<MappingState | "not_verified", Look> = {
  verified: { variant: "success", labelKey: "roots.tools.state.verified" },
  typed: { variant: "secondary", labelKey: "roots.tools.state.typed" },
  failed: { variant: "destructive", labelKey: "roots.tools.state.failed" },
  verify_again: { variant: "warning", labelKey: "roots.tools.state.verify_again" },
  not_verified: { variant: "secondary", labelKey: "roots.tools.state.not_verified" },
};

const METHOD: Record<RootMapping["method"], MessageKey> = {
  probe: "roots.tools.method.probe",
  suffix: "roots.tools.method.suffix",
  typed: "roots.tools.method.typed",
};

function StateBadge({ state }: { state: MappingState | "not_verified" }) {
  const { t } = useI18n();
  const look = STATE[state];
  return <Badge variant={look.variant}>{t(look.labelKey)}</Badge>;
}

/** One delegate: where it imports, which of those folders is the library, and Verify / type / remove. */
function DelegateRow({ tool, libraryReady }: { tool: DelegateTool; libraryReady: boolean }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const server = useServerAction();
  const failed = useFailureToast();
  const errorText = useErrorText();
  const [typing, setTyping] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.mappings });

  const verify = useMutation({
    mutationFn: () => verifyMapping(tool.provider),
    onSuccess: (mapping) => {
      toast.success(t("roots.tools.verified", { name: tool.label, folder: mapping.remote_path }));
      refresh();
    },
    onError: (error) => {
      failed(error, t("roots.tools.verifyFailed"));
      refresh();
    },
  });
  const save = useMutation({
    mutationFn: (folder: string) => typeMapping(tool.provider, folder),
    onSuccess: () => {
      toast.success(t("roots.tools.saved"));
      setTyping(null);
      refresh();
    },
    onError: (error) => failed(error, t("roots.tools.saveFailed")),
  });
  const remove = useMutation({
    mutationFn: (mapping: RootMapping) => deleteMapping(tool.provider, mapping.id),
    onSuccess: () => {
      toast.success(t("roots.tools.removed"));
      refresh();
    },
    onError: (error) => failed(error, t("roots.tools.removeFailed")),
  });

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium">{tool.label}</span>
          <span className="ml-2 text-muted-foreground">
            {t("roots.tools.importsInto")}{" "}
            {tool.import_roots ? (
              <span className="font-mono text-xs">{tool.import_roots.join(", ") || "—"}</span>
            ) : (
              <span>{tool.import_roots_error ? errorText(`provider_${tool.import_roots_error}`, t("roots.tools.importRootsUnknown")) : t("roots.tools.importRootsUnknown")}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label={t("roots.tools.verifyLabel", { name: tool.label })}
            disabled={server.disabled || !libraryReady || verify.isPending}
            title={libraryReady ? server.reason : t("roots.tools.libraryNotSet")}
            onClick={() => verify.mutate()}
          >
            {verify.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Search aria-hidden />}
            {t("roots.tools.verify")}
          </Button>
          <Button variant="ghost" size="sm" disabled={server.disabled} onClick={() => setTyping(typing === null ? "" : null)}>
            {t("roots.tools.type")}
          </Button>
        </div>
      </div>

      {typing !== null && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(typing);
          }}
        >
          <Input
            aria-label={t("roots.tools.typeLabel", { name: tool.label })}
            placeholder={t("roots.tools.typePlaceholder")}
            value={typing}
            onChange={(event) => setTyping(event.target.value)}
            className="max-w-xs font-mono"
          />
          <Button type="submit" size="sm" disabled={save.isPending || !typing.trim()}>
            {t("roots.tools.save")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setTyping(null)}>
            {t("roots.tools.cancel")}
          </Button>
        </form>
      )}

      <ul className="space-y-1">
        {tool.mappings.map((mapping) => (
          <li key={mapping.id} className="flex flex-wrap items-center gap-2 text-sm">
            <StateBadge state={mapping.state} />
            <span>{t("roots.tools.mapping", { folder: mapping.remote_path })}</span>
            <span className="text-xs text-muted-foreground">
              {t(METHOD[mapping.method])} · {absoluteTime(mapping.verified_at, locale)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive"
              aria-label={t("roots.tools.remove", { folder: mapping.remote_path })}
              disabled={server.disabled || remove.isPending}
              onClick={() => remove.mutate(mapping)}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
        {tool.unmapped_roots.map((folder) => (
          <li key={folder} className="flex items-start gap-1 text-xs text-warning" role="status">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {t("roots.tools.notMapped", { folder })}
          </li>
        ))}
        {tool.notice && (
          <li className="flex items-start gap-1 text-xs text-warning" role="status">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {t("roots.tools.notice", { outside: tool.notice.outside, unconfirmed: tool.notice.unconfirmed })}
          </li>
        )}
      </ul>
    </li>
  );
}

/** A music server: the outcome of its full-sync verification, run from the settings. */
function MusicServerRow({ tool }: { tool: MusicServerTool }) {
  const { t, locale } = useI18n();
  return (
    <li className="space-y-1 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{tool.label}</span>
        <span className="text-muted-foreground">{t("roots.tools.readsLibrary")}</span>
        <StateBadge state={tool.state} />
        {tool.result && <span className="text-xs text-muted-foreground">{absoluteTime(tool.result.verified_at, locale)}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{t("roots.tools.musicServerHint")}</p>
    </li>
  );
}

/**
 * Other tools (ADR-0008 §7, §8): each delegate that imports into folders of its own, with the folder of it that is the
 * library, and each music server with whether it reads the library. Every row comes from the server; no provider is named.
 */
export function OtherToolsTable({ overview }: { overview: MappingOverview }) {
  return (
    <ul className="divide-y rounded-lg border">
      {overview.delegates.map((tool) => (
        <DelegateRow key={tool.provider} tool={tool} libraryReady={overview.library.set} />
      ))}
      {overview.music_servers.map((tool) => (
        <MusicServerRow key={tool.provider} tool={tool} />
      ))}
    </ul>
  );
}
