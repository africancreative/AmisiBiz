"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface ColourInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  description?: string;
  required?: boolean;
}

export function ColourInput({
  label,
  value,
  onChange,
  error,
  description,
  required,
}: ColourInputProps) {
  const [hexValue, setHexValue] = React.useState(value);

  React.useEffect(() => {
    setHexValue(value);
  }, [value]);

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (/^#[0-9a-fA-F]{0,6}$/.test(val)) {
      setHexValue(val);
    }
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setHexValue(e.target.value);
    onChange(e.target.value);
  };

  const handleBlur = () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexValue)) {
      onChange(hexValue);
    }
  };

  const generatedId = React.useId();
  const errorId = error ? `${generatedId}-error` : undefined;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={generatedId} className="block text-sm font-medium text-foreground">
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
          value={hexValue}
          onChange={handleColorChange}
          onBlur={handleBlur}
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
          aria-label={`${label} hex value`}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={describedBy}
        />
        <div
          className="h-10 w-10 rounded-md border border-border"
          style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(hexValue) ? hexValue : "transparent" }}
          aria-hidden="true"
        />
      </div>
      {description && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
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
}

export function LogoUpload({ currentLogoUrl, onUpload, onDelete, isLoading }: LogoUploadProps) {
  const [preview, setPreview] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);

    const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
    if (!allowedTypes.includes(file.type)) {
      setError("Invalid file type. Allowed: PNG, JPEG, WebP, SVG.");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError("File size must not exceed 5 MB.");
      return;
    }

    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        if (img.width > 2000 || img.height > 2000) {
          reject(new Error("Image dimensions must not exceed 2000x2000 pixels."));
        } else {
          resolve();
        }
      };
      img.onerror = () => reject(new Error("Invalid image file."));
    });

    setPreview(URL.createObjectURL(file));

    try {
      await onUpload(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const handleDelete = async () => {
    setPreview(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await onDelete();
  };

  const displayUrl = preview || currentLogoUrl;

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-foreground">
        Logo
      </label>
      <div className="flex items-center gap-4">
        <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
          {displayUrl ? (
            <img
              src={displayUrl}
              alt="Logo preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="btn-secondary"
          >
            {currentLogoUrl ? "Replace" : "Upload"}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={handleFileSelect}
              className="hidden"
              disabled={isLoading}
            />
          </button>
          {currentLogoUrl && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isLoading}
              className="btn-destructive text-sm"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        PNG, JPEG, WebP, or SVG. Max 5 MB, 2000×2000 px.
      </p>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}