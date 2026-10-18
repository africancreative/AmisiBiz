"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Field } from "@amisibiz/ui/field";
import { Alert } from "@amisibiz/ui/alert";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { EmptyState } from "@amisibiz/ui/state";
import { Loader2, Trash2, Upload } from "lucide-react";
import {
  deleteItemImageAction,
  uploadItemImageAction,
} from "@/server/actions/item";
import { IMAGE_ALT_MAX } from "@/lib/validations/catalogue";
import type { ItemImageRow } from "./types";

/**
 * Image management for one item: upload and delete.
 *
 * Fail-closed by contract (design spec §7 "no fake storage"). The server-side
 * seam (`services/item-images.ts`) refuses a production upload when
 * `BLOB_READ_WRITE_TOKEN` is not configured, and the action surfaces that
 * message verbatim. This panel shows it as-is and writes NOTHING optimistic:
 * no row appears, no placeholder or data-URL stand-in is rendered, and no
 * success flash fires. A URL only ever comes from the `blobUrl` the server
 * returned.
 *
 * The client mirrors the seam's own file rules (PNG/JPEG/WebP, 2 MB) so the
 * common mistakes are caught before a round trip — the server still has the
 * last word, including the magic-byte check this panel cannot perform.
 *
 * Gating mirrors the catalogue list: the storage verbs sit behind
 * `ITEMS_UPDATE` (both `uploadItemImageAction` and `deleteItemImageAction`
 * authorize on that exact permission), so a reader gets a gallery and nothing
 * else.
 */

const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

function pickFileError(file: File): string | null {
  if (!ACCEPTED_MIME.includes(file.type)) {
    return "Choose a PNG, JPEG or WebP image.";
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_BYTES) {
    return "Images must be 2 MB or smaller.";
  }
  return null;
}

/** True only for the storage-configuration refusal, not for any other error. */
function isStorageMisconfiguration(message: string): boolean {
  return message.includes("BLOB_READ_WRITE_TOKEN");
}

export interface ItemImagesPanelProps {
  tenantId: string;
  itemId: string;
  itemName: string;
  images: ItemImageRow[];
  canUpdate: boolean;
  onChanged: () => void;
}

export function ItemImagesPanel({
  tenantId,
  itemId,
  itemName,
  images,
  canUpdate,
  onChanged,
}: ItemImagesPanelProps) {
  const [file, setFile] = React.useState<File | null>(null);
  const [alt, setAlt] = React.useState("");
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [altError, setAltError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ItemImageRow | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const storageDown = serverError
    ? isStorageMisconfiguration(serverError)
    : false;

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    setServerError(null);
    setFlash(null);
    setFileError(null);
    setAltError(null);

    if (!file) {
      setFileError("Choose an image first.");
      return;
    }
    const rejected = pickFileError(file);
    if (rejected) {
      setFileError(rejected);
      return;
    }
    if (alt.trim().length > IMAGE_ALT_MAX) {
      setAltError(`Alt text must be ${IMAGE_ALT_MAX} characters or fewer.`);
      return;
    }

    setIsUploading(true);
    try {
      const result = await uploadItemImageAction({
        tenantId,
        itemId,
        alt: alt.trim(),
        file,
      });

      if (result.success) {
        // Only a real server-returned URL reaches the gallery, and the row
        // itself comes from the reload — this panel never synthesises one.
        setFile(null);
        setAlt("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        setFlash("Image uploaded.");
        onChanged();
        return;
      }

      setServerError(result.error || "Failed to upload the image.");
    } catch {
      setServerError(
        "The upload request did not reach the server. Nothing was saved.",
      );
    } finally {
      setIsUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    setServerError(null);
    try {
      const result = await deleteItemImageAction({
        tenantId,
        imageId: deleting.id,
      });
      if (result.success) {
        setDeleting(null);
        setFlash("Image removed from this item.");
        onChanged();
        return;
      }
      setServerError(result.error || "Failed to delete the image.");
    } catch {
      setServerError("Something went wrong while deleting the image.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="images-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="images-heading" className="text-sm font-semibold">
          Images
        </h3>
        <span className="text-xs text-muted-foreground">
          {images.length === 0
            ? "No images yet"
            : `${images.length} image${images.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {serverError ? (
        storageDown ? (
          // The seam's own configuration text, verbatim: the upload did NOT
          // happen and no row exists. `role="alert"` because a refusal is not
          // a status update.
          <Alert
            tone="warning"
            role="alert"
            title="Image storage is not configured"
          >
            {serverError}
          </Alert>
        ) : (
          <div className="text-sm text-destructive" role="alert">
            {serverError}
          </div>
        )
      ) : null}

      {flash ? (
        <p className="text-sm text-success-foreground" role="status">
          {flash}
        </p>
      ) : null}

      {images.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No images"
          description="Product photos appear on this item's public share page once image storage is configured for the workspace."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image) => (
            <li
              key={image.id}
              className="space-y-2 rounded-lg border border-border p-2"
            >
              <img
                src={image.blobUrl}
                alt={image.alt ?? `${itemName} image ${image.position}`}
                className="aspect-square w-full rounded object-cover"
                loading="lazy"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Position {image.position}
                </span>
                {canUpdate ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete image ${image.position} for ${itemName}`}
                    onClick={() => {
                      setServerError(null);
                      setDeleting(image);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              {image.alt ? (
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={image.alt}
                >
                  {image.alt}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canUpdate ? (
        <form
          onSubmit={upload}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <Field
            label="Image file"
            description="PNG, JPEG or WebP, 2 MB or smaller. The file is stored by the workspace's blob store; its URL is assigned by the server."
            error={fileError ?? undefined}
          >
            <Input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="py-1.5 text-sm file:mr-2 file:border-0 file:bg-transparent file:text-sm file:font-medium"
              onChange={(e) => {
                setFileError(null);
                setServerError(null);
                setFlash(null);
                setFile(e.target.files?.[0] ?? null);
              }}
              disabled={isUploading}
            />
          </Field>

          <Field
            label="Alt text"
            description="Describes the picture for screen readers and for a broken image. Leave blank only when the image is decorative."
            error={altError ?? undefined}
          >
            <Input
              value={alt}
              onChange={(e) => {
                setAltError(null);
                setAlt(e.target.value);
              }}
              maxLength={IMAGE_ALT_MAX}
              placeholder="e.g. Front label of the 500 ml bottle"
              disabled={isUploading}
            />
          </Field>

          {file ? (
            <p className="text-xs text-muted-foreground">
              Selected: {file.name} ({Math.round(file.size / 1024)} KB)
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={isUploading || !file}>
              {isUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {isUploading ? "Uploading…" : "Upload image"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isUploading || !file}
              onClick={() => {
                setFile(null);
                setAlt("");
                setFileError(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            >
              Clear
            </Button>
          </div>
        </form>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Remove image"
          description={`Remove image ${deleting.position} from “${itemName}”? It stops appearing on this item and on any public page that shows it.`}
          confirmLabel="Remove"
          variant="danger"
          isLoading={isDeleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}
