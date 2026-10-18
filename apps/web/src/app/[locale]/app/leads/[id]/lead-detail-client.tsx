"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
import { Field } from "@amisibiz/ui/field";
import { Badge } from "@amisibiz/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@amisibiz/ui/state";
import {
  getLeadAction,
  loseLeadAction,
  moveLeadStageAction,
  reopenLeadAction,
  updateLeadAction,
} from "@/server/actions/lead";
import { getPipelinesAction } from "@/server/actions/pipeline";
import type { LeadDetail } from "@/server/services/leads/service";
import type { PipelineListItem } from "@/server/services/pipeline/service";
import type { DuplicateSuspect } from "@/server/services/leads/dedupe";
import { TimelinePanel } from "@/components/activities/timeline-client";
import { TaskPanel } from "@/components/tasks/task-panel-client";
import { formatMoney } from "@amisibiz/documents";
import { LEAD_PRIORITIES } from "@/lib/validations/lead";
import { ArrowLeft, Loader2, Pencil, UserCheck } from "lucide-react";

/**
 * Lead 360 (AGENT 02 Phase 3): the whole story of one lead in one page —
 * details, typed stage moves (only through `moveLeadStageAction`), the task
 * list with its own panel, the unified activity timeline, and the duplicate
 * suspects a human should see before working the lead. Terminal states
 * (CONVERTED / LOST) are read-only facts here; reopening is its own audited
 * action.
 */

interface LeadDetailClientProps {
  locale: string;
  tenantId: string;
  leadId: string;
  readonly: boolean;
  canUpdate: boolean;
  canConvert: boolean;
  canReadTasks: boolean;
  canManageTasks: boolean;
  canReadTimeline: boolean;
  canViewPipelines: boolean;
  canReadDocuments: boolean;
}

const OPEN_STATUSES = new Set(["NEW", "CONTACTED", "QUALIFIED"]);

function statusTone(
  status: string,
): "info" | "warning" | "success" | "danger" | "neutral" {
  switch (status) {
    case "NEW":
      return "info";
    case "CONTACTED":
      return "warning";
    case "QUALIFIED":
      return "success";
    case "CONVERTED":
      return "success";
    case "LOST":
      return "danger";
    default:
      return "neutral";
  }
}

export function LeadDetailClient({
  locale,
  tenantId,
  leadId,
  readonly,
  canUpdate,
  canReadTasks,
  canManageTasks,
  canReadTimeline,
  canViewPipelines,
  canReadDocuments,
}: LeadDetailClientProps) {
  const [lead, setLead] = React.useState<LeadDetail | null>(null);
  const [suspects, setSuspects] = React.useState<DuplicateSuspect[]>([]);
  const [pipelines, setPipelines] = React.useState<PipelineListItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [showEdit, setShowEdit] = React.useState(false);
  const [showLose, setShowLose] = React.useState(false);
  const [isReopening, setIsReopening] = React.useState(false);
  const [isMoving, setIsMoving] = React.useState(false);

  const load = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getLeadAction({ tenantId, leadId });
      if (!result.success) {
        if (result.code === "NOT_FOUND") setNotFound(true);
        setError(result.error || "Failed to load the lead.");
        return;
      }
      if (!result.data) {
        setError("Failed to load the lead.");
        return;
      }
      setLead(result.data.lead);
      setSuspects(result.data.duplicateSuspects);
    } catch {
      setError("Something went wrong while loading the lead.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, leadId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!canViewPipelines) return;
    void (async () => {
      const result = await getPipelinesAction({ tenantId });
      if (result.success && result.data) setPipelines(result.data.pipelines);
    })();
  }, [tenantId, canViewPipelines]);

  const allStages = pipelines.flatMap((pipeline) =>
    pipeline.stages.map((stage) => ({ ...stage, pipelineName: pipeline.name })),
  );

  const moveStage = async (stageId: string) => {
    if (!lead || readonly || !canUpdate) return;
    setIsMoving(true);
    setError(null);
    try {
      const result = await moveLeadStageAction({
        tenantId,
        leadId: lead.id,
        stageId,
      });
      if (result.success) {
        setFlash("Stage updated.");
        await load();
      } else {
        setError(result.error || "Failed to move the lead.");
      }
    } catch {
      setError("Something went wrong while moving the lead.");
    } finally {
      setIsMoving(false);
    }
  };

  const reopen = async () => {
    if (!lead || readonly) return;
    setIsReopening(true);
    setError(null);
    try {
      const result = await reopenLeadAction({ tenantId, leadId: lead.id });
      if (result.success) {
        setFlash("Lead reopened.");
        await load();
      } else {
        setError(result.error || "Failed to reopen the lead.");
      }
    } catch {
      setError("Something went wrong while reopening the lead.");
    } finally {
      setIsReopening(false);
    }
  };

  if (isLoading) {
    return <LoadingState label="Loading lead" />;
  }

  if (!lead) {
    return notFound ? (
      <ErrorState
        title="Lead not found"
        description="This lead does not exist in this workspace, or it was removed."
        action={
          <Link
            href={`/${locale}/app/leads`}
            className="inline-flex items-center justify-center rounded-md border border-input bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Back to leads
          </Link>
        }
      />
    ) : (
      <ErrorState
        title="Lead unavailable"
        description={error ?? "Failed to load the lead."}
        action={
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        }
      />
    );
  }

  const person = [lead.firstName, lead.lastName].filter(Boolean).join(" ");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/${locale}/app/leads`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Leads
          </Link>
          <h1 className="mt-1 text-2xl font-semibold truncate">
            {person || lead.companyName || lead.email || "Unnamed lead"}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(lead.status)}>
              {lead.status.charAt(0) + lead.status.slice(1).toLowerCase()}
            </Badge>
            <Badge
              tone={
                lead.priority === "HIGH"
                  ? "danger"
                  : lead.priority === "LOW"
                    ? "neutral"
                    : "info"
              }
            >
              {lead.priority.charAt(0) + lead.priority.slice(1).toLowerCase()}{" "}
              priority
            </Badge>
            {lead.pipelineStage ? (
              <Badge tone="primary">{lead.pipelineStage.name}</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Created {new Date(lead.createdAt).toLocaleDateString(locale)}
            </span>
          </div>
        </div>
        {!readonly && canUpdate ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowEdit(true)}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit details
            </Button>
            {OPEN_STATUSES.has(lead.status) ? (
              <Button variant="outline" onClick={() => setShowLose(true)}>
                Mark lost
              </Button>
            ) : null}
            {lead.status === "LOST" ? (
              <Button variant="outline" onClick={reopen} disabled={isReopening}>
                {isReopening ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Reopen
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {flash ? (
        <div className="text-sm text-success-foreground" role="status">
          {flash}
        </div>
      ) : null}

      {!readonly &&
      canUpdate &&
      OPEN_STATUSES.has(lead.status) &&
      canViewPipelines ? (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Pipeline stage</span>
          <Select
            aria-label="Move lead to stage"
            value={lead.pipelineStage?.id ?? ""}
            onChange={(e) => void moveStage(e.target.value)}
            disabled={isMoving}
            className="w-64"
          >
            <option value="">Unassigned stage</option>
            {allStages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.pipelineName} — {stage.name}
              </option>
            ))}
          </Select>
          {isMoving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          <span className="text-xs text-muted-foreground">
            Stage moves are audited; there is no free-form status edit.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card p-4 space-y-3 lg:col-span-1">
          <h2 className="text-sm font-semibold">Details</h2>
          <Fact
            label="Email"
            value={lead.email}
            href={lead.email ? `mailto:${lead.email}` : undefined}
          />
          <Fact label="Phone" value={lead.phone} />
          <Fact label="Company" value={lead.companyName} />
          <Fact label="Source" value={lead.source.replace(/_/g, " ")} />
          <Fact label="Source detail" value={lead.sourceDetail} />
          <Fact
            label="Estimated value"
            value={
              lead.estimatedValue
                ? formatMoney(lead.estimatedValue.toString(), lead.currency)
                : null
            }
          />
          <Fact
            label="UTM"
            value={
              [lead.utmSource, lead.utmMedium, lead.utmCampaign]
                .filter(Boolean)
                .join(" / ") || null
            }
          />
          {lead.description ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Description
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {lead.description}
              </p>
            </div>
          ) : null}
          {lead.lostReason ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
              <p className="font-medium text-destructive">Lost</p>
              <p className="text-xs text-muted-foreground">{lead.lostReason}</p>
            </div>
          ) : null}
          {lead.convertedContactId ? (
            <p className="text-sm">
              <UserCheck className="mr-1 inline h-4 w-4 text-success" />
              Converted to{" "}
              <Link
                className="text-primary hover:underline"
                href={`/${locale}/app/contacts/${lead.convertedContactId}`}
              >
                the customer record
              </Link>
              .
            </p>
          ) : null}
          {lead.convertedDocumentId && canReadDocuments ? (
            <p className="text-sm">
              Draft raised at conversion:{" "}
              <Link
                className="text-primary hover:underline"
                href={`/${locale}/app/documents/${lead.convertedDocumentId}`}
              >
                open the document
              </Link>
            </p>
          ) : null}
        </div>

        <div className="lg:col-span-2 space-y-6">
          {suspects.length > 0 ? (
            <div className="card p-4 space-y-2">
              <h2 className="text-sm font-semibold">
                Possible duplicate leads
              </h2>
              <p className="text-xs text-muted-foreground">
                Shown for your review only — the system never merges leads by
                itself. Convert the one you want to keep.
              </p>
              <ul className="divide-y divide-border text-sm">
                {suspects.map((suspect) => (
                  <li
                    key={suspect.id}
                    className="py-2 flex items-center justify-between gap-2"
                  >
                    <Link
                      href={`/${locale}/app/leads/${suspect.id}`}
                      className="hover:underline truncate"
                    >
                      {[suspect.firstName, suspect.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                        suspect.companyName ||
                        suspect.email ||
                        suspect.id}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {suspect.basis.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="card p-4 space-y-3">
            <h2 className="text-sm font-semibold">Tasks</h2>
            <TaskPanel
              tenantId={tenantId}
              leadId={lead.id}
              canRead={canReadTasks}
              canManage={canManageTasks && !readonly}
              locale={locale}
            />
          </div>

          <div className="card p-4 space-y-3">
            <h2 className="text-sm font-semibold">Activity timeline</h2>
            {canReadTimeline ? (
              <TimelinePanel
                tenantId={tenantId}
                leadId={lead.id}
                locale={locale}
              />
            ) : (
              <EmptyState
                title="Timeline hidden"
                description="This account cannot read activity events."
              />
            )}
          </div>
        </div>
      </div>

      {showEdit ? (
        <EditLeadDialog
          tenantId={tenantId}
          lead={lead}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false);
            setFlash("Lead updated.");
            await load();
          }}
        />
      ) : null}

      {showLose ? (
        <LoseLeadDialog
          tenantId={tenantId}
          lead={lead}
          onClose={() => setShowLose(false)}
          onLost={async () => {
            setShowLose(false);
            setFlash("Lead marked lost — the reason is on the timeline.");
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function Fact({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null | undefined;
  href?: string | undefined;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm truncate">
        {value ? (
          href ? (
            <a className="text-primary hover:underline" href={href}>
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          "—"
        )}
      </p>
    </div>
  );
}

function EditLeadDialog({
  tenantId,
  lead,
  onClose,
  onSaved,
}: {
  tenantId: string;
  lead: LeadDetail;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [form, setForm] = React.useState({
    firstName: lead.firstName ?? "",
    lastName: lead.lastName ?? "",
    companyName: lead.companyName ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    description: lead.description ?? "",
    priority: lead.priority,
    currency: lead.currency,
    estimatedValue: lead.estimatedValue ? lead.estimatedValue.toString() : "",
    sourceDetail: lead.sourceDetail ?? "",
    utmSource: lead.utmSource ?? "",
    utmMedium: lead.utmMedium ?? "",
    utmCampaign: lead.utmCampaign ?? "",
  });
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]> | undefined
  >(undefined);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors(undefined);
    try {
      const result = await updateLeadAction({
        tenantId,
        leadId: lead.id,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        companyName: form.companyName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        description: form.description.trim(),
        priority: form.priority,
        currency: form.currency,
        estimatedValue: form.estimatedValue.trim() || null,
        sourceDetail: form.sourceDetail.trim(),
        utmSource: form.utmSource.trim(),
        utmMedium: form.utmMedium.trim(),
        utmCampaign: form.utmCampaign.trim(),
      });
      if (!result.success) {
        setError(result.error || "Failed to update the lead.");
        setFieldErrors(result.fieldErrors);
        return;
      }
      await onSaved();
    } catch {
      setError("Something went wrong while updating the lead.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit lead details</DialogTitle>
          <DialogDescription>
            Identity and value only. Status moves through stage, lose and reopen
            actions, never through this form.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name">
              <Input
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="Last name">
              <Input
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="Company">
              <Input
                value={form.companyName}
                onChange={(e) => set("companyName", e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Email" error={fieldErrors?.email?.[0]}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                maxLength={254}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                maxLength={50}
              />
            </Field>
            <Field label="Priority">
              <Select
                value={form.priority}
                onChange={(e) =>
                  set(
                    "priority",
                    e.target.value as (typeof LEAD_PRIORITIES)[number],
                  )
                }
              >
                {LEAD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0) + p.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Input
                value={form.currency}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
                maxLength={3}
              />
            </Field>
            <Field
              label="Estimated value"
              error={fieldErrors?.estimatedValue?.[0]}
            >
              <Input
                value={form.estimatedValue}
                onChange={(e) => set("estimatedValue", e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <Field label="UTM source">
              <Input
                value={form.utmSource}
                onChange={(e) => set("utmSource", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="UTM medium">
              <Input
                value={form.utmMedium}
                onChange={(e) => set("utmMedium", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="UTM campaign">
              <Input
                value={form.utmCampaign}
                onChange={(e) => set("utmCampaign", e.target.value)}
                maxLength={100}
              />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LoseLeadDialog({
  tenantId,
  lead,
  onClose,
  onLost,
}: {
  tenantId: string;
  lead: LeadDetail;
  onClose: () => void;
  onLost: () => Promise<void> | void;
}) {
  const [reason, setReason] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await loseLeadAction({
        tenantId,
        leadId: lead.id,
        lostReason: reason.trim(),
      });
      if (result.success) {
        await onLost();
      } else {
        setError(result.error || "Failed to mark the lead lost.");
      }
    } catch {
      setError("Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark lead lost</DialogTitle>
          <DialogDescription>
            The reason is mandatory and recorded on the timeline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <Field label="Why was this lost?" required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              minLength={3}
              maxLength={500}
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={isSubmitting || reason.trim().length < 3}
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Mark lost
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
