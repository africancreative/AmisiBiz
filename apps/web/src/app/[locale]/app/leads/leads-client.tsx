"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
import { Field } from "@amisibiz/ui/field";
import { Badge } from "@amisibiz/ui/badge";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@amisibiz/ui/table";
import { Pagination } from "@amisibiz/ui/pagination";
import { EmptyState, LoadingState } from "@amisibiz/ui/state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@amisibiz/documents";
import {
  convertLeadAction,
  createLeadAction,
  getLeadsAction,
  loseLeadAction,
  moveLeadStageAction,
  reopenLeadAction,
} from "@/server/actions/lead";
import { getPipelinesAction } from "@/server/actions/pipeline";
import { findContactDuplicateCandidatesAction } from "@/server/actions/contact";
import type { LeadListItem } from "@/server/services/leads/service";
import type { PipelineListItem } from "@/server/services/pipeline/service";
import type { DuplicateSuspect } from "@/server/services/leads/dedupe";
import {
  LEAD_PRIORITIES,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/validations/lead";
import { Loader2, Plus, Search, Users } from "lucide-react";

/**
 * Leads surface (AGENT 02 Phase 3).
 *
 * Two views over the same Server Actions: a pipeline KANBAN (drag a card, or
 * use the card's "Move to" select — both call `moveLeadStageAction`, the only
 * sanctioned stage transition; there is no free-form status edit anywhere) and
 * a paginated LIST fallback with filters. The board needs PIPELINES_READ for
 * its columns; a member without it lands on the list. Conversion goes through
 * `convertLeadAction` and is honest about drafts: when the engine reports
 * `needsDraftEditor` the UI says the draft was NOT created and links to the
 * document editor — it never fakes a quotation.
 */

type LeadRow = LeadListItem;
type StageRow = PipelineListItem["stages"][number];

interface LeadsClientProps {
  locale: string;
  tenantId: string;
  initialPage: number;
  initialQ: string;
  initialStatus: string;
  initialView: string;
  readonly: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canConvert: boolean;
  canViewPipelines: boolean;
  canReadContacts: boolean;
  title: string;
  description: string;
}

const PAGE_SIZE = 25;
const BOARD_PAGE_SIZE = 100;

const OPEN_STATUSES = new Set(["NEW", "CONTACTED", "QUALIFIED"]);

const CURRENCY_OPTIONS = [
  "KES",
  "UGX",
  "TZS",
  "RWF",
  "ETB",
  "USD",
  "EUR",
  "GBP",
];

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

function leadDisplayName(lead: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
}): string {
  const person = [lead.firstName, lead.lastName].filter(Boolean).join(" ");
  return person || lead.companyName || lead.email || "Unnamed lead";
}

export function LeadsClient({
  locale,
  tenantId,
  initialPage,
  initialQ,
  initialStatus,
  initialView,
  readonly,
  canCreate,
  canUpdate,
  canConvert,
  canViewPipelines,
  canReadContacts,
  title,
  description,
}: LeadsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [view, setView] = React.useState<"board" | "list">(
    initialView === "list" || !canViewPipelines ? "list" : "board",
  );
  const [pipelines, setPipelines] = React.useState<PipelineListItem[]>([]);
  const [activePipelineId, setActivePipelineId] = React.useState<string>("");
  const [boardLeads, setBoardLeads] = React.useState<LeadRow[]>([]);
  const [listLeads, setListLeads] = React.useState<LeadRow[]>([]);
  const [listTotal, setListTotal] = React.useState(0);
  const [listTotalPages, setListTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(initialPage);
  const [q, setQ] = React.useState(initialQ);
  const [status, setStatus] = React.useState(initialStatus);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [showNewLead, setShowNewLead] = React.useState(false);
  const [convertingLead, setConvertingLead] = React.useState<LeadRow | null>(
    null,
  );
  const [losingLead, setLosingLead] = React.useState<LeadRow | null>(null);
  const [reopeningLead, setReopeningLead] = React.useState<LeadRow | null>(
    null,
  );
  const [isReopening, setIsReopening] = React.useState(false);
  const [movingLeadId, setMovingLeadId] = React.useState<string | null>(null);

  const activePipeline =
    pipelines.find((pipeline) => pipeline.id === activePipelineId) ??
    pipelines[0] ??
    null;

  const loadPipelines = React.useCallback(async () => {
    if (!canViewPipelines) return;
    const result = await getPipelinesAction({ tenantId });
    if (result.success && result.data) {
      setPipelines(result.data.pipelines);
      if (result.data.pipelines.length > 0) {
        setActivePipelineId(
          (current) => current || result.data!.pipelines[0]!.id,
        );
      }
    }
  }, [tenantId, canViewPipelines]);

  const loadBoard = React.useCallback(async () => {
    setError(null);
    try {
      const result = await getLeadsAction({
        tenantId,
        page: 1,
        pageSize: BOARD_PAGE_SIZE,
        ...(q ? { q } : {}),
      });
      if (!result.success) {
        setError(result.error || "Failed to load leads.");
        return;
      }
      if (result.data) setBoardLeads(result.data.leads);
    } catch {
      setError("Something went wrong while loading leads.");
    }
  }, [tenantId, q]);

  const loadList = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getLeadsAction({
        tenantId,
        page,
        pageSize: PAGE_SIZE,
        ...(q ? { q } : {}),
        ...(LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])
          ? { status: status as (typeof LEAD_STATUSES)[number] }
          : {}),
      });
      if (!result.success) {
        setError(result.error || "Failed to load leads.");
        return;
      }
      if (result.data) {
        setListLeads(result.data.leads);
        setListTotal(result.data.total);
        setListTotalPages(result.data.totalPages);
      }
    } catch {
      setError("Something went wrong while loading leads.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, page, q, status]);

  React.useEffect(() => {
    void loadPipelines();
  }, [loadPipelines]);

  React.useEffect(() => {
    if (view === "board") {
      setIsLoading(true);
      void loadBoard().finally(() => setIsLoading(false));
    } else {
      void loadList();
    }
  }, [view, loadBoard, loadList]);

  // Keep the local mirrors in sync with URL-driven props (same pattern as the
  // items list: the server re-render is asynchronous).
  React.useEffect(() => {
    setPage(initialPage);
    setQ(initialQ);
    setStatus(initialStatus);
    if (initialView === "list" || initialView === "board") {
      setView(canViewPipelines ? (initialView as "board" | "list") : "list");
    }
  }, [initialPage, initialQ, initialStatus, initialView, canViewPipelines]);

  const pushUrl = (changes: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`?${params.toString()}`);
  };

  const refresh = React.useCallback(() => {
    if (view === "board") void loadBoard();
    else void loadList();
  }, [view, loadBoard, loadList]);

  const moveLead = async (leadId: string, stageId: string) => {
    if (readonly || !canUpdate) return;
    setMovingLeadId(leadId);
    setError(null);
    try {
      const result = await moveLeadStageAction({ tenantId, leadId, stageId });
      if (!result.success) {
        setError(result.error || "Failed to move the lead.");
      } else {
        const stage = activePipeline?.stages.find((s) => s.id === stageId);
        setFlash(
          stage
            ? `Lead moved to “${stage.name}”.`
            : "Lead moved to the unassigned column.",
        );
        await Promise.all([loadBoard(), loadList()]);
      }
    } catch {
      setError("Something went wrong while moving the lead.");
    } finally {
      setMovingLeadId(null);
    }
  };

  const reopenLead = async () => {
    if (!reopeningLead || readonly) return;
    setIsReopening(true);
    setError(null);
    try {
      const result = await reopenLeadAction({
        tenantId,
        leadId: reopeningLead.id,
      });
      if (result.success) {
        setFlash("Lead reopened.");
        setReopeningLead(null);
        await refresh();
      } else {
        setError(result.error || "Failed to reopen the lead.");
      }
    } catch {
      setError("Something went wrong while reopening the lead.");
    } finally {
      setIsReopening(false);
    }
  };

  const boardLeadsOpen = boardLeads.filter((lead) =>
    OPEN_STATUSES.has(lead.status),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {canViewPipelines ? (
            <Select
              aria-label="Choose view"
              value={view}
              onChange={(e) => {
                const next = e.target.value === "list" ? "list" : "board";
                setView(next);
                pushUrl({ view: next });
              }}
              className="w-36"
            >
              <option value="board">Kanban board</option>
              <option value="list">List</option>
            </Select>
          ) : null}
          {canCreate && !readonly ? (
            <Button onClick={() => setShowNewLead(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New lead
            </Button>
          ) : null}
        </div>
      </div>

      <form
        className="flex flex-col sm:flex-row gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          pushUrl({ q, page: "1" });
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by name, company, email or phone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-10"
          />
        </div>
        {view === "list" ? (
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
              const params = new URLSearchParams(searchParams.toString());
              if (e.target.value) params.set("status", e.target.value);
              else params.delete("status");
              params.set("page", "1");
              router.push(`?${params.toString()}`);
            }}
            className="w-full sm:w-48"
          >
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        ) : null}
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {flash ? (
        <div className="text-sm text-success-foreground" role="status">
          {flash}
          <button
            type="button"
            className="ml-2 underline text-xs"
            onClick={() => setFlash(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {view === "board" && canViewPipelines ? (
        <BoardView
          locale={locale}
          pipelines={pipelines}
          activePipeline={activePipeline}
          onSelectPipeline={(id) => setActivePipelineId(id)}
          leads={boardLeadsOpen}
          isLoading={isLoading}
          movingLeadId={movingLeadId}
          canMove={canUpdate && !readonly}
          canConvert={canConvert && !readonly}
          onMove={moveLead}
          onConvert={(lead) => setConvertingLead(lead)}
          error={error}
        />
      ) : (
        <ListView
          locale={locale}
          leads={listLeads}
          isLoading={isLoading}
          error={error}
          page={page}
          total={listTotal}
          totalPages={listTotalPages}
          canConvert={canConvert && !readonly}
          canUpdate={canUpdate && !readonly}
          onConvert={(lead) => setConvertingLead(lead)}
          onLose={(lead) => setLosingLead(lead)}
          onReopen={(lead) => setReopeningLead(lead)}
          onPageChange={(next) => {
            setPage(next);
            pushUrl({ page: String(next) });
          }}
        />
      )}

      {showNewLead ? (
        <NewLeadDialog
          tenantId={tenantId}
          stages={activePipeline?.stages ?? []}
          onClose={() => setShowNewLead(false)}
          onCreated={(message) => {
            setShowNewLead(false);
            setFlash(message);
            void refresh();
          }}
        />
      ) : null}

      {convertingLead ? (
        <ConvertLeadDialog
          tenantId={tenantId}
          locale={locale}
          lead={convertingLead}
          canReadContacts={canReadContacts}
          onClose={() => setConvertingLead(null)}
          onConverted={(message) => {
            setConvertingLead(null);
            setFlash(message);
            void refresh();
          }}
        />
      ) : null}

      {losingLead ? (
        <LoseLeadDialog
          tenantId={tenantId}
          lead={losingLead}
          onClose={() => setLosingLead(null)}
          onLost={(message) => {
            setLosingLead(null);
            setFlash(message);
            void refresh();
          }}
        />
      ) : null}

      {reopeningLead ? (
        <ConfirmDialog
          title="Reopen lead"
          description={`Reopen “${leadDisplayName(reopeningLead)}”? The engine places it back on the board with its pre-loss stage, or the first stage if that stage is gone.`}
          confirmLabel="Reopen"
          isLoading={isReopening}
          onConfirm={reopenLead}
          onCancel={() => setReopeningLead(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------- board view -------------------------------- */

interface BoardViewProps {
  locale: string;
  pipelines: PipelineListItem[];
  activePipeline: PipelineListItem | null;
  onSelectPipeline: (id: string) => void;
  leads: LeadRow[];
  isLoading: boolean;
  movingLeadId: string | null;
  canMove: boolean;
  canConvert: boolean;
  onMove: (leadId: string, stageId: string) => Promise<void>;
  onConvert: (lead: LeadRow) => void;
  error: string | null;
}

function BoardView({
  locale,
  pipelines,
  activePipeline,
  onSelectPipeline,
  leads,
  isLoading,
  movingLeadId,
  canMove,
  canConvert,
  onMove,
  onConvert,
  error,
}: BoardViewProps) {
  const [dragOverStage, setDragOverStage] = React.useState<string | null>(null);

  if (isLoading) {
    return <LoadingState label="Loading pipeline board" />;
  }

  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title="No pipelines yet"
        description="The board needs at least one pipeline. Create one under Settings → Pipelines, then leads can be placed on stages. Leads without a stage still appear in the list view."
      />
    );
  }

  if (error && leads.length === 0) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive"
        role="alert"
      >
        {error}
      </div>
    );
  }

  const stages = activePipeline?.stages ?? [];
  const byStage = new Map<string, LeadRow[]>();
  const backlog: LeadRow[] = [];
  for (const lead of leads) {
    const stage = lead.pipelineStage;
    if (stage && stage.pipelineId === activePipeline?.id) {
      const bucket = byStage.get(stage.id) ?? [];
      bucket.push(lead);
      byStage.set(stage.id, bucket);
    } else {
      backlog.push(lead);
    }
  }

  const columns: Array<{
    key: string;
    name: string;
    badge?: string | undefined;
    leads: LeadRow[];
  }> = [
    {
      key: "__backlog",
      name: "Unassigned stage",
      badge: "new",
      leads: backlog,
    },
    ...stages.map((stage) => ({
      key: stage.id,
      name: stage.name,
      badge: stage.isWin ? "win" : stage.isLost ? "lost" : undefined,
      leads: byStage.get(stage.id) ?? [],
    })),
  ];

  return (
    <div className="space-y-4">
      {pipelines.length > 1 ? (
        <Select
          aria-label="Choose pipeline"
          value={activePipeline?.id ?? ""}
          onChange={(e) => onSelectPipeline(e.target.value)}
          className="w-64"
        >
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
              {pipeline.isDefault ? " (default)" : ""}
            </option>
          ))}
        </Select>
      ) : null}

      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <div
            key={column.key}
            className={cn(
              "w-72 shrink-0 rounded-lg border bg-muted/40 p-3",
              dragOverStage === column.key && "border-primary bg-primary/5",
            )}
            onDragOver={(e) => {
              if (!canMove) return;
              e.preventDefault();
              setDragOverStage(column.key);
            }}
            onDragLeave={() => setDragOverStage(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverStage(null);
              if (!canMove) return;
              const leadId = e.dataTransfer.getData("text/plain");
              if (!leadId) return;
              // The backlog column has no stage to move TO; dropping there
              // would need a dedicated unstage verb, which does not exist.
              if (column.key === "__backlog") return;
              void onMove(leadId, column.key);
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {column.name}
                {column.badge ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({column.badge})
                  </span>
                ) : null}
              </h3>
              <span className="text-xs text-muted-foreground">
                {column.leads.length}
              </span>
            </div>
            <div className="space-y-2">
              {column.leads.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  Drop a lead here
                </p>
              ) : (
                column.leads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    locale={locale}
                    stages={stages}
                    isMoving={movingLeadId === lead.id}
                    canMove={canMove}
                    canConvert={canConvert}
                    onMove={(stageId) => onMove(lead.id, stageId)}
                    onConvert={() => onConvert(lead)}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LeadCard({
  lead,
  locale,
  stages,
  isMoving,
  canMove,
  canConvert,
  onMove,
  onConvert,
}: {
  lead: LeadRow;
  locale: string;
  stages: StageRow[];
  isMoving: boolean;
  canMove: boolean;
  canConvert: boolean;
  onMove: (stageId: string) => Promise<void>;
  onConvert: () => void;
}) {
  return (
    <div
      draggable={canMove}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", lead.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "rounded-md border bg-card p-3 shadow-sm space-y-2",
        canMove && "cursor-grab",
        isMoving && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/${locale}/app/leads/${lead.id}`}
          className="text-sm font-medium hover:underline min-w-0 truncate"
        >
          {leadDisplayName(lead)}
        </Link>
        {isMoving ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge tone={statusTone(lead.status)}>
          {lead.status.charAt(0) + lead.status.slice(1).toLowerCase()}
        </Badge>
        {lead.priority === "HIGH" ? <Badge tone="danger">High</Badge> : null}
        {lead.priority === "LOW" ? <Badge tone="neutral">Low</Badge> : null}
      </div>
      {lead.companyName ? (
        <p className="truncate text-xs text-muted-foreground">
          {lead.companyName}
        </p>
      ) : null}
      {lead.estimatedValue ? (
        <p className="text-xs font-mono">
          {formatMoney(lead.estimatedValue.toString(), lead.currency)}
        </p>
      ) : null}
      {lead.assignedToUser ? (
        <p className="truncate text-xs text-muted-foreground">
          Assigned: {lead.assignedToUser.name ?? lead.assignedToUser.email}
        </p>
      ) : null}
      {canMove ? (
        <Select
          aria-label={`Move ${leadDisplayName(lead)} to stage`}
          value={lead.pipelineStage?.id ?? ""}
          onChange={(e) => void onMove(e.target.value)}
          className="h-8 text-xs"
          disabled={isMoving}
        >
          <option value="">Unassigned stage</option>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </Select>
      ) : null}
      {canConvert ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onConvert}
        >
          Convert
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------- list view ------------------------------- */

interface ListViewProps {
  locale: string;
  leads: LeadRow[];
  isLoading: boolean;
  error: string | null;
  page: number;
  total: number;
  totalPages: number;
  canConvert: boolean;
  canUpdate: boolean;
  onConvert: (lead: LeadRow) => void;
  onLose: (lead: LeadRow) => void;
  onReopen: (lead: LeadRow) => void;
  onPageChange: (page: number) => void;
}

function ListView({
  locale,
  leads,
  isLoading,
  error,
  page,
  total,
  totalPages,
  canConvert,
  canUpdate,
  onConvert,
  onLose,
  onReopen,
  onPageChange,
}: ListViewProps) {
  if (isLoading) {
    return <LoadingState label="Loading leads" />;
  }

  // Mirror the board view: a failed load must not render as an empty list.
  if (error && leads.length === 0) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive"
        role="alert"
      >
        {error}
      </div>
    );
  }

  return (
    <div className="card">
      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent py-12"
                    title="No leads found"
                    description={
                      "New enquiries from share links and the new-lead form appear here."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/${locale}/app/leads/${lead.id}`}
                      className="hover:underline"
                    >
                      {leadDisplayName(lead)}
                    </Link>
                    {lead.companyName ? (
                      <p className="text-xs font-normal text-muted-foreground">
                        {lead.companyName}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    <p>{lead.email || "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {lead.phone || ""}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {lead.pipelineStage?.name ?? (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(lead.status)}>
                      {lead.status.charAt(0) +
                        lead.status.slice(1).toLowerCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {lead.estimatedValue
                      ? formatMoney(
                          lead.estimatedValue.toString(),
                          lead.currency,
                        )
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {lead.source.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString(locale)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {canConvert && OPEN_STATUSES.has(lead.status) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onConvert(lead)}
                        >
                          Convert
                        </Button>
                      ) : null}
                      {canUpdate && OPEN_STATUSES.has(lead.status) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onLose(lead)}
                        >
                          Mark lost
                        </Button>
                      ) : null}
                      {canUpdate && lead.status === "LOST" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onReopen(lead)}
                        >
                          Reopen
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {totalPages > 1 ? (
        <div className="p-4 border-t border-border">
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            onPageChange={onPageChange}
          />
          <p className="text-sm text-muted-foreground mt-2 text-center">
            Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
            {Math.min(page * PAGE_SIZE, total)} of {total} leads
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------- new lead --------------------------------- */

interface NewLeadDialogProps {
  tenantId: string;
  stages: StageRow[];
  onClose: () => void;
  onCreated: (message: string) => void;
}

function NewLeadDialog({
  tenantId,
  stages,
  onClose,
  onCreated,
}: NewLeadDialogProps) {
  // The idempotency key is minted ONCE per dialog mount: an error-retry of the
  // same form submits the same key and the engine returns the original lead
  // instead of creating a second one.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [form, setForm] = React.useState({
    firstName: "",
    lastName: "",
    companyName: "",
    email: "",
    phone: "",
    description: "",
    source: "WEB_FORM",
    sourceDetail: "",
    currency: "KES",
    estimatedValue: "",
    priority: "MEDIUM",
    pipelineStageId: "",
  });
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]> | undefined
  >(undefined);
  const [suspects, setSuspects] = React.useState<DuplicateSuspect[]>([]);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors(undefined);
    try {
      const result = await createLeadAction({
        tenantId,
        source: form.source,
        currency: form.currency,
        priority: form.priority,
        idempotencyKey,
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        description: form.description.trim() || undefined,
        sourceDetail: form.sourceDetail.trim() || undefined,
        estimatedValue: form.estimatedValue.trim() || undefined,
        ...(form.pipelineStageId
          ? { pipelineStageId: form.pipelineStageId }
          : {}),
      });
      if (!result.success) {
        setError(result.error || "Failed to create the lead.");
        setFieldErrors(result.fieldErrors);
        return;
      }
      if (!result.data) {
        onCreated("Lead created.");
        return;
      }
      if (result.data.duplicateSuspects.length > 0) {
        // Keep the dialog open on purpose: duplicates are a human review, and
        // the engine created the lead regardless (it never auto-merges).
        setSuspects(result.data.duplicateSuspects);
        setIsSubmitting(false);
        return;
      }
      onCreated("Lead created.");
    } catch {
      setError("Something went wrong while creating the lead.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
          <DialogDescription>
            Status, tenant and revision are owned by the server; this form only
            describes the enquiry.
          </DialogDescription>
        </DialogHeader>
        {suspects.length > 0 ? (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3 space-y-2">
            <p className="text-sm font-medium">Possible duplicates found</p>
            <p className="text-xs text-muted-foreground">
              Your lead was created anyway — the system never merges on its own.
              Review these open leads and keep the one you want to work.
            </p>
            <ul className="space-y-1 text-sm">
              {suspects.map((suspect) => (
                <li key={suspect.id}>
                  {suspect.firstName ??
                    suspect.companyName ??
                    suspect.email ??
                    suspect.id}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({suspect.basis.join(", ")})
                  </span>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onCreated("Lead created — review the duplicates above.")
              }
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name" error={fieldErrors?.firstName?.[0]}>
              <Input
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="Last name" error={fieldErrors?.lastName?.[0]}>
              <Input
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="Company" error={fieldErrors?.companyName?.[0]}>
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
            <Field label="Phone" error={fieldErrors?.phone?.[0]}>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                maxLength={50}
              />
            </Field>
            <Field label="Source" required error={fieldErrors?.source?.[0]}>
              <Select
                value={form.source}
                onChange={(e) => set("source", e.target.value)}
              >
                {LEAD_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source detail" error={fieldErrors?.sourceDetail?.[0]}>
              <Input
                value={form.sourceDetail}
                onChange={(e) => set("sourceDetail", e.target.value)}
                maxLength={500}
              />
            </Field>
            <Field label="Priority">
              <Select
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
              >
                {LEAD_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority.charAt(0) + priority.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Currency"
              required
              description="Explicit ISO-4217 code — prices are never assumed."
              error={fieldErrors?.currency?.[0]}
            >
              <Select
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
              >
                {CURRENCY_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Estimated value"
              description="Decimal, e.g. 12500.50"
              error={fieldErrors?.estimatedValue?.[0]}
            >
              <Input
                value={form.estimatedValue}
                onChange={(e) => set("estimatedValue", e.target.value)}
                inputMode="decimal"
                pattern="[0-9]*\.?[0-9]{0,4}"
              />
            </Field>
            {stages.length > 0 ? (
              <Field
                label="Starting stage"
                description="Optional; the service proves the stage belongs to this workspace."
              >
                <Select
                  value={form.pipelineStageId}
                  onChange={(e) => set("pipelineStageId", e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <Field label="Description" error={fieldErrors?.description?.[0]}>
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
              Create lead
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ convert lead -------------------------------- */

interface ConvertLeadDialogProps {
  tenantId: string;
  locale: string;
  lead: LeadRow;
  canReadContacts: boolean;
  onClose: () => void;
  onConverted: (message: string) => void;
}

/**
 * Mirrors `DuplicateCandidate` from the contacts merge service — the shape the
 * action actually returns: a normalized, scored suspicion with the basis that
 * produced it. Duplicate review is advisory: selecting one is what links the
 * lead, and nothing here merges automatically.
 */
type CandidateContact = {
  id: string;
  displayName: string;
  email: string | null;
  score: "strong" | "medium" | "weak";
  basis: readonly string[];
};

function ConvertLeadDialog({
  tenantId,
  locale,
  lead,
  canReadContacts,
  onClose,
  onConverted,
}: ConvertLeadDialogProps) {
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [mode, setMode] = React.useState<"newContact" | "existingContact">(
    "newContact",
  );
  const [candidates, setCandidates] = React.useState<
    readonly CandidateContact[]
  >([]);
  const [candidateLoad, setCandidateLoad] = React.useState<
    "idle" | "loading" | "failed"
  >(canReadContacts ? "loading" : "idle");
  const [selectedContactId, setSelectedContactId] = React.useState("");
  const [contactForm, setContactForm] = React.useState({
    type: "INDIVIDUAL",
    firstName: lead.firstName ?? "",
    lastName: lead.lastName ?? "",
    companyName: lead.companyName ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    notes: lead.description ?? "",
  });
  const [draftChoice, setDraftChoice] = React.useState<
    "" | "quotation" | "order"
  >("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]> | undefined
  >(undefined);

  React.useEffect(() => {
    if (!canReadContacts) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await findContactDuplicateCandidatesAction({
          tenantId,
          ...(lead.email ? { email: lead.email } : {}),
          ...(lead.phone ? { phone: lead.phone } : {}),
          ...(lead.companyName ? { companyName: lead.companyName } : {}),
          ...(lead.firstName ? { firstName: lead.firstName } : {}),
          ...(lead.lastName ? { lastName: lead.lastName } : {}),
        });
        if (cancelled) return;
        if (result.success && result.data) {
          setCandidates(
            result.data.candidates.map((candidate) => ({
              id: candidate.contactId,
              displayName: candidate.displayName,
              email: candidate.email,
              score: candidate.score,
              basis: candidate.basis,
            })),
          );
          setCandidateLoad("idle");
        } else {
          setCandidateLoad("failed");
        }
      } catch {
        if (!cancelled) setCandidateLoad("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tenantId,
    canReadContacts,
    lead.email,
    lead.phone,
    lead.companyName,
    lead.firstName,
    lead.lastName,
  ]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors(undefined);
    try {
      const payload = {
        tenantId,
        leadId: lead.id,
        mode,
        idempotencyKey,
        ...(mode === "newContact"
          ? {
              contact: {
                type: contactForm.type,
                firstName: contactForm.firstName.trim(),
                lastName: contactForm.lastName.trim(),
                companyName: contactForm.companyName.trim(),
                email: contactForm.email.trim(),
                phone: contactForm.phone.trim(),
                notes: contactForm.notes.trim(),
              },
            }
          : { contactId: selectedContactId }),
        ...(draftChoice ? { createDraft: draftChoice } : {}),
      };
      const result = await convertLeadAction(payload);
      if (!result.success) {
        setError(result.error || "Failed to convert the lead.");
        setFieldErrors(result.fieldErrors);
        return;
      }
      const data = result.data;
      if (!data) {
        onConverted("Lead converted to a customer.");
        return;
      }
      if (data.documentCreated && data.documentId) {
        window.location.href = `/${locale}/app/documents/${data.documentId}`;
        return;
      }
      if (data.needsDraftEditor) {
        // Honest outcome: the conversion completed, but the engine refuses a
        // draft with zero lines, so NO quotation/order was faked.
        onConverted(
          draftChoice
            ? `Lead converted to a customer. The ${draftChoice} draft was NOT created — the document engine refuses an empty draft, so create it with real lines under Documents.`
            : "Lead converted to a customer.",
        );
        return;
      }
      onConverted("Lead converted to a customer.");
    } catch {
      setError("Something went wrong while converting the lead.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? null : onClose())}
      className="max-w-2xl"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert lead to customer</DialogTitle>
          <DialogDescription>
            {leadDisplayName(lead)} — conversion is explicit: you choose whether
            this becomes a NEW customer or links an EXISTING one. The system
            never merges automatically.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={submit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Duplicate review</legend>
            {candidateLoad === "loading" ? (
              <p className="text-xs text-muted-foreground">
                Checking existing customers with this email, phone or company…
              </p>
            ) : null}
            {candidateLoad === "failed" ? (
              <p className="text-xs text-destructive" role="alert">
                Duplicate check unavailable — you can still convert; review
                carefully.
              </p>
            ) : null}
            {!canReadContacts ? (
              <p className="text-xs text-muted-foreground">
                This account cannot search contacts, so existing duplicates are
                not shown.
              </p>
            ) : null}
            {candidates.length > 0 ? (
              <ul className="rounded-md border p-2 text-sm space-y-1 max-h-32 overflow-y-auto">
                {candidates.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">
                      {candidate.displayName}{" "}
                      <span className="text-xs text-muted-foreground">
                        {candidate.email ?? ""} · {candidate.score} match (
                        {candidate.basis.join(", ")})
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMode("existingContact");
                        setSelectedContactId(candidate.id);
                      }}
                    >
                      Link
                    </Button>
                  </li>
                ))}
              </ul>
            ) : candidateLoad === "idle" && canReadContacts ? (
              <p className="text-xs text-muted-foreground">
                No existing customers matched by email, phone or company.
              </p>
            ) : null}
          </fieldset>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === "newContact" ? "primary" : "outline"}
              onClick={() => setMode("newContact")}
            >
              New customer
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "existingContact" ? "primary" : "outline"}
              onClick={() => setMode("existingContact")}
              disabled={candidates.length === 0 && !selectedContactId}
            >
              Existing customer
            </Button>
          </div>

          {mode === "newContact" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Contact type" required>
                <Select
                  value={contactForm.type}
                  onChange={(e) =>
                    setContactForm((f) => ({ ...f, type: e.target.value }))
                  }
                >
                  <option value="INDIVIDUAL">Individual</option>
                  <option value="BUSINESS">Business</option>
                </Select>
              </Field>
              <Field
                label="First name"
                error={fieldErrors?.["contact.firstName"]?.[0]}
              >
                <Input
                  value={contactForm.firstName}
                  onChange={(e) =>
                    setContactForm((f) => ({ ...f, firstName: e.target.value }))
                  }
                />
              </Field>
              <Field label="Last name">
                <Input
                  value={contactForm.lastName}
                  onChange={(e) =>
                    setContactForm((f) => ({ ...f, lastName: e.target.value }))
                  }
                />
              </Field>
              <Field label="Company name">
                <Input
                  value={contactForm.companyName}
                  onChange={(e) =>
                    setContactForm((f) => ({
                      ...f,
                      companyName: e.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={contactForm.email}
                  onChange={(e) =>
                    setContactForm((f) => ({ ...f, email: e.target.value }))
                  }
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={contactForm.phone}
                  onChange={(e) =>
                    setContactForm((f) => ({ ...f, phone: e.target.value }))
                  }
                />
              </Field>
            </div>
          ) : (
            <Field
              label="Existing customer"
              required
              description="Only ACTIVE customers in this workspace are listed."
              error={fieldErrors?.contactId?.[0]}
            >
              <Select
                value={selectedContactId}
                onChange={(e) => setSelectedContactId(e.target.value)}
                required
              >
                <option value="">Choose a customer…</option>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName || candidate.email || candidate.id}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Draft document"
            description="A draft with zero lines is refused by the document engine on purpose — conversion never fakes a quotation. Choosing a draft here marks the intent; you complete the lines in the editor."
            error={fieldErrors?.createDraft?.[0]}
          >
            <Select
              value={draftChoice}
              onChange={(e) =>
                setDraftChoice(e.target.value as "" | "quotation" | "order")
              }
            >
              <option value="">No draft</option>
              <option value="quotation">Quotation (needs lines later)</option>
              <option value="order">Order (needs lines later)</option>
            </Select>
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Convert lead
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- lose lead --------------------------------- */

interface LoseLeadDialogProps {
  tenantId: string;
  lead: LeadRow;
  onClose: () => void;
  onLost: (message: string) => void;
}

function LoseLeadDialog({
  tenantId,
  lead,
  onClose,
  onLost,
}: LoseLeadDialogProps) {
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
        onLost("Lead marked lost — the reason is recorded on the timeline.");
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
            {leadDisplayName(lead)} — a loss without a reason is not auditable,
            so the reason is mandatory.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <Field
            label="Why was this lost?"
            required
            error={error ? undefined : undefined}
          >
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
