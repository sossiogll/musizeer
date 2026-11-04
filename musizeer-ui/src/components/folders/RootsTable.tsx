import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Info, Loader2, Pencil, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFolderLabel } from "@/hooks/useRoots";
import { useServerAction } from "@/hooks/useServerAction";
import { useI18n, type MessageKey } from "@/i18n";
import { checkRoot, deleteRoot } from "@/lib/api-client";
import { useFailureToast } from "@/lib/error-text";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes } from "@/lib/utils";
import type { RootCheck, RootCheckLevel, RootFolder, RootState } from "@/types";

type BadgeLook = { variant: "success" | "warning" | "destructive" | "secondary"; labelKey: MessageKey };

const STATE: Record<RootState, BadgeLook> = {
  accepted: { variant: "success", labelKey: "roots.state.accepted" },
  refused: { variant: "destructive", labelKey: "roots.state.refused" },
  unchecked: { variant: "secondary", labelKey: "roots.state.unchecked" },
};

/** After a Check the badge follows the Check's overall state, never the gateway's verdict alone; an info note keeps OK. */
const CHECK_STATE: Record<RootCheckLevel, BadgeLook> = {
  ok: STATE.accepted,
  info: STATE.accepted,
  warning: { variant: "warning", labelKey: "roots.state.warning" },
  error: { variant: "destructive", labelKey: "roots.state.error" },
};

const FINDING_KEYS: Record<string, MessageKey> = {
  gateway_ok: "roots.check.ok",
  gateway_unreachable: "roots.check.gatewayUnreachable",
  gateway_refused: "roots.check.failed",
  application_required_missing: "roots.check.applicationRequiredMissing",
  application_required_read_only: "roots.check.applicationReadOnly",
  application_not_needed: "roots.check.applicationNotNeeded",
  application_read_only_not_needed: "roots.check.applicationReadOnlyNotNeeded",
  application_unused_missing: "roots.check.applicationUnusedMissing",
  application_unused_read_only: "roots.check.applicationUnusedReadOnly",
};

const FINDING_ICON = { ok: CircleCheck, info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const FINDING_TONE: Record<RootCheckLevel, string> = {
  ok: "text-success",
  info: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive",
};

/** What a Check found, a sentence per finding (the plain "application is fine" one says nothing). */
function useCheckFindings() {
  const { t } = useI18n();
  return (report: RootCheck) =>
    report.checks
      .filter((finding) => finding.code !== "application_ok" && FINDING_KEYS[finding.code])
      .map((finding) => ({
        key: finding.code,
        level: finding.level,
        text: t(FINDING_KEYS[finding.code], finding.params),
      }));
}

interface RootsTableProps {
  roots: RootFolder[];
  onEdit: (root: RootFolder) => void;
}

/**
 * The root folders: label, path, the gateway's verdict, the free space a Check found, and which folder settings use each,
 * with Check, edit and delete (a root in use cannot be deleted, and says which settings use it).
 */
export function RootsTable({ roots, onEdit }: RootsTableProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const server = useServerAction();
  const failed = useFailureToast();
  const folderLabel = useFolderLabel();
  const checkFindings = useCheckFindings();
  const [checks, setChecks] = useState<Record<string, RootCheck>>({});
  const [deleting, setDeleting] = useState<RootFolder | null>(null);

  const check = useMutation({
    mutationFn: (root: RootFolder) => checkRoot(root.id),
    onSuccess: (report) => {
      setChecks((current) => ({ ...current, [report.root.id]: report }));
      // The Check records the gateway's verdict: the table and the viewer's folders read it again.
      void queryClient.invalidateQueries({ queryKey: queryKeys.roots });
      void queryClient.invalidateQueries({ queryKey: queryKeys.viewer });
    },
    onError: (error) => failed(error, t("roots.check.requestFailed")),
  });
  const remove = useMutation({
    mutationFn: (root: RootFolder) => deleteRoot(root.id),
    onSuccess: () => {
      toast.success(t("roots.deleted"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.roots });
    },
    onError: (error) => failed(error, t("roots.deleteFailed")),
  });

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">{t("roots.heading")}</caption>
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.label")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.path")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.state")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.free")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("roots.columns.usedBy")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t("roots.columns.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {roots.map((root) => {
              const report = checks[root.id];
              const findings = report ? checkFindings(report) : [];
              const inUse = root.used_by.length > 0;
              const usedBy = root.used_by.map(folderLabel).join(", ");
              const checking = check.isPending && check.variables?.id === root.id;
              const state = report ? CHECK_STATE[report.state] : STATE[root.state];
              return (
                <tr key={root.id} className="align-top">
                  <th scope="row" className="px-3 py-2.5 font-medium">{root.label}</th>
                  <td className="px-3 py-2.5 font-mono text-xs">{root.path}</td>
                  <td className="space-y-1 px-3 py-2.5">
                    <Badge variant={state.variant}>{t(state.labelKey)}</Badge>
                    {root.state === "refused" && root.reason && <p className="max-w-xs text-xs text-destructive">{root.reason}</p>}
                    {findings.map((finding) => {
                      const Icon = FINDING_ICON[finding.level];
                      const quiet = finding.level === "ok" || finding.level === "info";
                      return (
                        <p
                          key={finding.key}
                          data-level={finding.level}
                          className={`flex max-w-xs items-start gap-1 text-xs ${quiet ? "text-muted-foreground" : FINDING_TONE[finding.level]}`}
                          role="status"
                        >
                          <Icon aria-hidden className={`mt-px size-3.5 shrink-0 ${FINDING_TONE[finding.level]}`} />
                          {finding.text}
                        </p>
                      );
                    })}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{formatBytes(report?.gateway?.free_bytes, locale)}</td>
                  <td className="px-3 py-2.5">{inUse ? usedBy : <span className="text-muted-foreground">{t("roots.notUsed")}</span>}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("roots.check.button", { name: root.label })}
                        disabled={server.disabled || checking}
                        title={server.reason}
                        onClick={() => check.mutate(root)}
                      >
                        {checking ? <Loader2 aria-hidden className="animate-spin" /> : <ShieldCheck aria-hidden />}
                        {t("roots.check.label")}
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t("roots.edit", { name: root.label })} disabled={server.disabled} onClick={() => onEdit(root)}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={t("roots.delete", { name: root.label })}
                        disabled={server.disabled || inUse}
                        title={inUse ? t("roots.deleteInUse", { folders: usedBy }) : server.reason}
                        onClick={() => setDeleting(root)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("roots.deleteTitle", { name: deleting?.label ?? "" })}
        description={t("roots.deleteBody", { path: deleting?.path ?? "" })}
        confirmLabel={t("roots.deleteConfirm")}
        destructive
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}
