"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import {
  LOGO_ALLOWED_MIME_TYPES,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION_PX,
} from "@/lib/validations/branding";
import { cn } from "@/lib/utils";

/**
 * Branding form controls.
 *
 * `exactOptionalPropertyTypes` is on, so optional props are declared with an
 * explicit `| undefined` — callers can pass `errors.foo?.message` (which is
 * `string | undefined`) without a cast.
 */
interface ColourInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  description?: string | undefined;
  required?: boolean | undefined;
  className?: string | undefined;
}

const HEX_SIX = /^#[0-9a-fA-F]{6}$/;

export function ColourInput({
  label,
  value,
  onChange,
  error,
  description,
  required,
  className,
}: ColourInputProps) {
  const [hexValue, setHexValue] = React.useState(value);

  React.useEffect(() => {
    setHexValue(value);
  }, [value]);

  // Partial hex text is allowed while typing, but only a complete colour is
  // committed to form state — the same rule the server applies.
  const handleHexChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (/^#[0-9a-fA-F]{0,6}$/.test(next)) {
      setHexValue(next);
      if (HEX_SIX.test(next)) onChange(next);
    }
  };

  const handleColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setHexValue(event.target.value);
    onChange(event.target.value);
  };

  const handleBlur = () => {
    if (HEX_SIX.test(hexValue)) {
      onChange(hexValue);
    } else {
      setHexValue(value);
    }
  };

  const generatedId = React.useId();
  const errorId = error ? `${generatedId}-error` : undefined;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={generatedId}
        className="block text-sm font-medium text-foreground"
      >
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className="flex items-center gap-3">
        <input
          type="color"
          id={generatedId}
          value={HEX_SIX.test(hexValue) ? hexValue : "#000000"}
          onChange={handleColorChange}
          className="h-10 w-10 rounded-md border border-input bg-card cursor-pointer"
          aria-label={label}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={describedBy}
        />
        <input
          type="text"
          value={hexValue}
          onChange={handleHexChange}
          onBlur={handleBlur}
          className="flex-1 h-10 w-full max-w-xs rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive"
          placeholder="#1d4ed8"
          maxLength={7}
          aria-label={`${label} hex value`}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={describedBy}
        />
        <div
          className="h-10 w-10 rounded-md border border-border"
          style={{
            backgroundColor: HEX_SIX.test(hexValue) ? hexValue : "transparent",
          }}
          aria-hidden="true"
        />
      </div>
      {description && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-xs font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}

interface LogoUploadProps {
  currentLogoUrl: string | null;
  onUpload: (file: File) => Promise<void>;
  onDelete: () => Promise<void>;
  isLoading: boolean;
  className?: string | undefined;
}

const ACCEPTED_EXTENSIONS: Record<
  (typeof LOGO_ALLOWED_MIME_TYPES)[number],
  string
> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/**
 * Client-side pre-checks mirror the upload route, but they are only UX: the
 * route re-authorizes the caller, verifies the magic bytes of the actual file
 * and its pixel dimensions, and rejects anything else. SVG is intentionally not
 * offered — it is a scripting-capable format.
 */
export function LogoUpload({
  currentLogoUrl,
  onUpload,
  onDelete,
  isLoading,
  className,
}: LogoUploadProps) {
  const [preview, setPreview] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    if (!(LOGO_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(
        `Unsupported file type. Allowed: ${LOGO_ALLOWED_MIME_TYPES.map((t) => ACCEPTED_EXTENSIONS[t]).join(", ")}.`,
      );
      event.target.value = "";
      return;
    }

    if (file.size > LOGO_MAX_BYTES) {
      setError(
        `File size must not exceed ${Math.round(LOGO_MAX_BYTES / (1024 * 1024))} MB.`,
      );
      event.target.value = "";
      return;
    }

    const objectUrl = URL.createObjectURL(file);

    try {
      const dimensions = await readImageDimensions(objectUrl);
      if (!dimensions)
        throw new Error("The file could not be read as an image.");
      if (
        dimensions.width > LOGO_MAX_DIMENSION_PX ||
        dimensions.height > LOGO_MAX_DIMENSION_PX
      ) {
        throw new Error(
          `Image dimensions must not exceed ${LOGO_MAX_DIMENSION_PX}x${LOGO_MAX_DIMENSION_PX} pixels.`,
        );
      }

      setPreview(objectUrl);
      await onUpload(file);
      URL.revokeObjectURL(objectUrl);
      setPreview(null);
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      setPreview(null);
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    setPreview(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      await onDelete();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not remove the logo.",
      );
    }
  };

  const displayUrl = preview || currentLogoUrl;

  return (
    <div className={cn("space-y-3", className)}>
      <span className="block text-sm font-medium text-foreground">Logo</span>
      <div className="flex items-center gap-4">
        <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
          {displayUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo URLs are runtime tenant data served by the private upload route, not build-time assets
            <img
              src={displayUrl}
              alt="Logo preview"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              <svg
                className="h-8 w-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
          )}
        </div>
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isLoading}
            onClick={() => fileInputRef.current?.click()}
          >
            {currentLogoUrl ? "Replace" : "Upload"}
          </Button>
          {currentLogoUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              onClick={handleDelete}
            >
              Remove
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={LOGO_ALLOWED_MIME_TYPES.join(",")}
            onChange={handleFileSelect}
            className="hidden"
            disabled={isLoading}
            aria-label="Logo file"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {LOGO_ALLOWED_MIME_TYPES.map((t) => ACCEPTED_EXTENSIONS[t]).join(", ")}{" "}
        only. Max {Math.round(LOGO_MAX_BYTES / (1024 * 1024))} MB,{" "}
        {LOGO_MAX_DIMENSION_PX}×{LOGO_MAX_DIMENSION_PX} px. The file content is
        verified on upload, not just its extension.
      </p>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

async function readImageDimensions(
  src: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
