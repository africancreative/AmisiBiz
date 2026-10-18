"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Field } from "@amisibiz/ui/field";
import { Alert } from "@amisibiz/ui/alert";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { EmptyState, LoadingState } from "@amisibiz/ui/state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import {
  createCategoryAction,
  deleteCategoryAction,
  getCategoriesAction,
  updateCategoryAction,
} from "@/server/actions/item";
import { CATEGORY_NAME_MAX } from "@/lib/validations/catalogue";

/**
 * Catalogue category management (create / rename / delete), used from the items
 * list as both the filter's data source and the "Manage categories" surface.
 *
 * Categories here are the CATALOGUE categories (`CatalogueCategory`), which is
 * what `getItemsAction({ categoryId })` filters on — distinct from tax
 * categories, which the item dialog reaches through its tax-rate picker.
 *
 * Gating follows the action wiring exactly: create is `ITEMS_CREATE`, rename
 * `ITEMS_UPDATE`, delete `ITEMS_DELETE`; loading needs only `ITEMS_READ`, so a
 * read-only member can still open this dialog to see the list.
 *
 * Nothing is claimed on a hope: a row appears in the list only after the action
 * returns `success`, and a delete that the server refuses (a category still
 * holding items) shows the action's own message instead of disappearing.
 */

const PAGE_SIZE = 100;

interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  itemCount: number;
}

interface CategoriesPage {
  categories: CategoryRow[];
  total: number;
  page: number;
  totalPages: number;
}

export interface CategoryDialogProps {
  tenantId: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onClose: () => void;
  /** Lets the list adopt a category it just created. */
  onCreated?: (categoryId: string) => void;
}

export function CategoryManageDialog({
  tenantId,
  canCreate,
  canUpdate,
  canDelete,
  onClose,
  onCreated,
}: CategoryDialogProps) {
  const [data, setData] = React.useState<CategoriesPage | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [parentId, setParentId] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [renaming, setRenaming] = React.useState<CategoryRow | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleting, setDeleting] = React.useState<CategoryRow | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const load = React.useCallback(
    async (targetPage: number) => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await getCategoriesAction({
          tenantId,
          page: targetPage,
          pageSize: PAGE_SIZE,
        });
        if (!result.success) {
          setLoadError(result.error || "Failed to load categories.");
          return;
        }
        if (!result.data) return;
        setData({
          categories: result.data.categories.map((category) => ({
            id: category.id,
            name: category.name,
            parentId: category.parentId ?? null,
            itemCount: category._count?.items ?? 0,
          })),
          total: result.data.total,
          page: result.data.page,
          totalPages: result.data.totalPages,
        });
      } catch {
        setLoadError("Failed to load categories.");
      } finally {
        setIsLoading(false);
      }
    },
    [tenantId],
  );

  React.useEffect(() => {
    void load(page);
  }, [load, page]);

  const rows = data?.categories ?? [];

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setActionError(null);
    setFlash(null);
    setNameError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("A category name is required.");
      return;
    }
    if (trimmed.length > CATEGORY_NAME_MAX) {
      setNameError(`Name must be ${CATEGORY_NAME_MAX} characters or fewer.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createCategoryAction({
        tenantId,
        name: trimmed,
        // "" means "top level"; the schema takes a nullish uuid.
        ...(parentId ? { parentId } : {}),
      });
      if (result.success && result.data) {
        setName("");
        setParentId("");
        setFlash(
          result.data.created
            ? `Category “${result.data.name}” created.`
            : `Category “${result.data.name}” already existed and is now used.`,
        );
        onCreated?.(result.data.categoryId);
        void load(page);
        return;
      }
      if (!result.success) {
        const message = result.error || "Failed to create the category.";
        if (message.includes("already exists")) {
          setNameError(message);
        } else {
          setActionError(message);
        }
      }
    } catch {
      setActionError("Something went wrong while creating the category.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitRename = React.useCallback(async () => {
    if (!renaming) return;
    setActionError(null);
    setFlash(null);

    const trimmed = renameValue.trim();
    if (!trimmed) {
      setActionError("A category name is required.");
      return;
    }
    if (trimmed.length > CATEGORY_NAME_MAX) {
      setActionError(`Name must be ${CATEGORY_NAME_MAX} characters or fewer.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await updateCategoryAction({
        tenantId,
        categoryId: renaming.id,
        name: trimmed,
      });
      if (result.success) {
        setRenaming(null);
        setFlash("Category renamed.");
        void load(page);
        return;
      }
      setActionError(result.error || "Failed to rename the category.");
    } catch {
      setActionError("Something went wrong while renaming the category.");
    } finally {
      setIsSubmitting(false);
    }
  }, [load, page, renameValue, renaming, tenantId]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    setActionError(null);
    setFlash(null);
    try {
      const result = await deleteCategoryAction({
        tenantId,
        categoryId: deleting.id,
      });
      if (result.success) {
        setDeleting(null);
        setFlash("Category deleted.");
        void load(page);
        return;
      }
      // A category still pointed at by items is refused server-side; the
      // message says so and the row stays.
      setActionError(result.error || "Failed to delete the category.");
    } catch {
      setActionError("Something went wrong while deleting the category.");
    } finally {
      setIsDeleting(false);
    }
  };

  const parentOptions = rows.filter((row) => row.id !== renaming?.id);

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Categories</DialogTitle>
            <DialogDescription>
              Catalogue categories group items for the list filter, the detail
              page and the share pages. Renaming or deleting one never changes a
              price.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 p-4">
            {actionError ? (
              <div className="text-sm text-destructive" role="alert">
                {actionError}
              </div>
            ) : null}
            {flash ? (
              <p className="text-sm text-success-foreground" role="status">
                {flash}
              </p>
            ) : null}

            {canCreate ? (
              <form
                onSubmit={create}
                className="space-y-3 rounded-lg border border-border p-3"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="New category" error={nameError ?? undefined}>
                    <Input
                      value={name}
                      onChange={(e) => {
                        setNameError(null);
                        setName(e.target.value);
                      }}
                      maxLength={CATEGORY_NAME_MAX}
                      placeholder="e.g. Veterinary services"
                      disabled={isSubmitting}
                    />
                  </Field>
                  <Field
                    label="Parent category"
                    description="Optional. Leave at top level unless this category sits under another."
                  >
                    <Select
                      value={parentId}
                      onChange={(e) => setParentId(e.target.value)}
                      disabled={isSubmitting || parentOptions.length === 0}
                    >
                      <option value="">Top level</option>
                      {parentOptions.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button type="submit" size="sm" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add category
                </Button>
              </form>
            ) : null}

            {isLoading ? (
              <LoadingState label="Loading categories…" />
            ) : loadError ? (
              <Alert tone="danger" title="Categories unavailable">
                {loadError}
              </Alert>
            ) : rows.length === 0 ? (
              <EmptyState
                className="py-8"
                title="No categories yet"
                description="Add a category above to group products and services in the catalogue."
              />
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map((row) =>
                  renaming?.id === row.id ? (
                    <li key={row.id} className="space-y-2 p-3">
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitRename();
                        }}
                        className="space-y-2"
                      >
                        <Field label={`Rename “${row.name}”`}>
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            maxLength={CATEGORY_NAME_MAX}
                            disabled={isSubmitting}
                          />
                        </Field>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            type="submit"
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => setRenaming(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    </li>
                  ) : (
                    <li
                      key={row.id}
                      className="flex items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {row.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {row.itemCount} item
                          {row.itemCount === 1 ? "" : "s"}
                          {row.parentId ? " · has a parent" : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canUpdate ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Rename category ${row.name}`}
                            onClick={() => {
                              setActionError(null);
                              setRenaming(row);
                              setRenameValue(row.name);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canDelete ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete category ${row.name}`}
                            onClick={() => {
                              setActionError(null);
                              setDeleting(row);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}

            {data && data.totalPages > 1 ? (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  Page {data.page} of {data.totalPages} · {data.total}{" "}
                  categories
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isLoading || data.page <= 1}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isLoading || data.page >= data.totalPages}
                    onClick={() =>
                      setPage((current) =>
                        Math.min(data.totalPages, current + 1),
                      )
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {deleting ? (
        <ConfirmDialog
          title="Delete category"
          description={`Delete “${deleting.name}”? ${
            deleting.itemCount > 0
              ? `This category still has ${deleting.itemCount} item(s); the server will refuse until they are moved to another category.`
              : "Items keep existing — only the grouping goes away."
          }`}
          confirmLabel="Delete"
          variant="danger"
          isLoading={isDeleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}
