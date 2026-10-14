import * as React from "react";
import { PageHeader } from "@amisibiz/ui/page-header";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
} from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";

/**
 * Structural placeholder for a not-yet-implemented module. Renders the shared
 * page header + table scaffold so navigation, layout and empty states are in
 * place for a later phase to fill with real functionality.
 */
export function ModulePlaceholder({
  title,
  description,
  columns,
  emptyTitle,
  emptyDescription,
  action,
}: {
  title: string;
  description?: string;
  columns: string[];
  emptyTitle: string;
  emptyDescription?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} actions={action} />
      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <td colSpan={columns.length} className="p-0">
                <EmptyState
                  className="border-0 bg-transparent"
                  title={emptyTitle}
                  description={emptyDescription}
                />
              </td>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
