import { getPortalState } from "@/server/auth/portal";
import { prisma, runInScope, sessionScope } from "@amisibiz/database";
import { formatMoney } from "@amisibiz/documents";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
import { FileText, Download, Eye } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CustomerPortalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getPortalState(locale);
  if (state.status !== "ok") {
    return null;
  }

  const { tenant, contact, user } = state;

  // Retrieve customer documents strictly filtered by contactId and tenantId.
  // Drafts are intentionally excluded — customers only ever see issued business documents.
  const documents = await runInScope(sessionScope(user.id), () =>
    prisma.document.findMany({
      where: {
        tenantId: tenant.id,
        contactId: contact.id,
        status: { not: "DRAFT" },
      },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        currency: true,
        total: true,
        issueDate: true,
        dueDate: true,
        issuedAt: true,
      },
      orderBy: { issueDate: "desc" },
    }),
  );

  const invoiceCount = documents.filter((d) => d.type === "INVOICE").length;
  const quotationCount = documents.filter((d) => d.type === "QUOTATION").length;
  const deliveryCount = documents.filter(
    (d) => d.type === "DELIVERY_NOTE",
  ).length;

  const getStatusTone = (status: string) => {
    switch (status) {
      case "PAID":
      case "ACCEPTED":
      case "DELIVERED":
        return "success";
      case "ISSUED":
      case "SENT":
        return "info";
      case "OVERDUE":
      case "REJECTED":
      case "VOIDED":
        return "danger";
      default:
        return "neutral";
    }
  };

  return (
    <div className="space-y-8">
      {/* Welcome banner */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
        <h1 className="text-2xl font-bold text-foreground">
          Welcome, {contact.firstName ?? contact.companyName ?? "Customer"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View and download your official commercial quotations, invoices, and
          delivery notes issued by{" "}
          <strong className="text-foreground">{tenant.name}</strong>.
        </p>

        {/* Quick summary stats */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-lg border border-border bg-background p-4">
            <span className="block text-xs font-semibold text-muted-foreground uppercase">
              Total Documents
            </span>
            <span className="mt-1 block text-2xl font-bold text-foreground">
              {documents.length}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <span className="block text-xs font-semibold text-muted-foreground uppercase">
              Invoices
            </span>
            <span className="mt-1 block text-2xl font-bold text-foreground">
              {invoiceCount}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <span className="block text-xs font-semibold text-muted-foreground uppercase">
              Quotations
            </span>
            <span className="mt-1 block text-2xl font-bold text-foreground">
              {quotationCount}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <span className="block text-xs font-semibold text-muted-foreground uppercase">
              Delivery Notes
            </span>
            <span className="mt-1 block text-2xl font-bold text-foreground">
              {deliveryCount}
            </span>
          </div>
        </div>
      </div>

      {/* Documents List */}
      <div className="rounded-xl border border-border bg-card shadow-xs overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            Shared Documents
          </h2>
          <span className="text-xs text-muted-foreground">
            {documents.length} document{documents.length === 1 ? "" : "s"}
          </span>
        </div>

        {documents.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-foreground">
              No documents available yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              When {tenant.name} issues an invoice, quotation, or delivery note
              for your account, it will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs font-semibold uppercase text-muted-foreground border-b border-border">
                <tr>
                  <th scope="col" className="px-6 py-3">
                    Document
                  </th>
                  <th scope="col" className="px-6 py-3">
                    Type
                  </th>
                  <th scope="col" className="px-6 py-3">
                    Date
                  </th>
                  <th scope="col" className="px-6 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-6 py-3 text-right">
                    Amount
                  </th>
                  <th scope="col" className="px-6 py-3 text-center">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.map((doc) => {
                  const pdfUrl = `/api/portal/documents/${doc.id}/pdf?tenantId=${tenant.id}`;
                  return (
                    <tr
                      key={doc.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-6 py-4 font-semibold text-foreground">
                        {doc.number ?? "—"}
                      </td>
                      <td className="px-6 py-4 text-xs">
                        <span className="inline-flex items-center rounded-md bg-secondary px-2 py-1 font-medium text-secondary-foreground">
                          {doc.type.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">
                        {new Date(doc.issueDate).toLocaleDateString(
                          tenant.locale ?? "en",
                          {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          },
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <StatusIndicator tone={getStatusTone(doc.status)}>
                          {doc.status}
                        </StatusIndicator>
                      </td>
                      <td className="px-6 py-4 text-right font-semibold text-foreground">
                        {formatMoney(doc.total.toString(), doc.currency)}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <a
                            href={`${pdfUrl}&disposition=inline`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                            title="View PDF in browser"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span>View</span>
                          </a>
                          <a
                            href={`${pdfUrl}&disposition=attachment`}
                            className="inline-flex items-center gap-1 rounded-md bg-brand-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-800 transition-colors"
                            title="Download PDF"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>Download</span>
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
