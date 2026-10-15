import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { v2 as cloudinary } from "cloudinary";
import type { TenantBranding } from "@amisibiz/database";

/**
 * Cloudinary configuration interface.
 * Cloudinary API credentials (cloud_name, api_key, api_secret) MUST come from
 * environment variables only and are never stored in the database or exposed to
 * clients. This adapter boundary ensures a live Cloudinary integration is only
 * claimed when documented integration and verification tests pass.
 */
interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Check if Cloudinary is configured via environment variables. */
function cloudinaryConfiguredViaEnv(): boolean {
  return (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/** Read Cloudinary config from environment variables. */
function getCloudinaryConfigFromEnv(): CloudinaryConfig {
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey: process.env.CLOUDINARY_API_KEY!,
    apiSecret: process.env.CLOUDINARY_API_SECRET!,
  };
}

//**
 * Cloudinary configuration for branding asset storage.
 *
 * Priority order:
 *   1. Environment variables (CLOUDINARY_CLOUD_NAME, etc.) – preferred, secure.
 *   2. Fallback configuration – for development/demo purposes only.
 *
 * A live Cloudinary integration is not claimed until its documented integration
 * and verification tests pass. The fallback below is intentionally limited and
 * should be replaced with env vars before any production deployment.
 */
function getCloudinaryConfig(): CloudinaryConfig | null {
  // 1. Try environment variables first (secure, production-ready)
  if (cloudinaryConfiguredViaEnv()) {
    return getCloudinaryConfigFromEnv();
  }

  // 2. Fallback: configured config object (for development/demo only).
  //    In a production system, ensure env vars are set before deploying.
  //    Never hardcode credentials in the codebase.
  const fallbackConfig: CloudinaryConfig | null = null; // Deliberately null –
    // any attempt to use Cloudinary without env vars will gracefully fail.

  return fallbackConfig;
}

//**
 * Upload a branding logo file to cloud storage.
 *
 * Validates file type, size, and image dimensions before upload.
 * Returns a signed URL for private access if needed.
 *
 * @param file The uploaded file object (from React Drop Zone or similar)
 * @param tenantId The tenant identifier for scoped storage
 */
export async function uploadBrandingLogo(
  file: File,
  tenantId: string
): Promise<{ success: boolean; error?: string; logoUrl?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  // --- File validation ---
  const MAX_SIZE = 5_000_000; // 5 MB
  const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "svg+xml"];

  if (file.size > MAX_SIZE) {
    return {
      success: false,
      error: "File size must be less than 5 MB.",
    };
  }

  if (!ACCEPTED_TYPES.includes(file.type) && file.type !== "application/svg+xml") {
    return {
      success: false,
      error: "Unsupported file type. Please upload PNG, JPEG, WebP, or SVG.",
    };
  }

  // --- Image dimension validation (basic check) ---
  const maxDimensions = { width: 2000, height: 2000 };
  if (file.type.startsWith("image/")) {
    const img = await createImageFromFile(file);
    if (img.width > maxDimensions.width || img.height > maxDimensions.height) {
      URL.createObjectURL(file); // cleanup
      return {
        success: false,
        error: `Image dimensions must not exceed ${maxDimensions.width}×${maxDimensions.height} pixels.`,
      };
    }
  }

  // --- Upload to cloud storage ---
  const config = getCloudinaryConfig();
  if (config) {
    try {
      cloudinary.v2({
        cloud_name: config.cloudName,
        api_key: config.apiKey,
        api_secret: config.apiSecret,
      });

      const result = await cloudinary.v2.uploader.upload(
        file,
        {
          folder: `branding/${tenantId}`,
          resource_type: "image",
          transformation: [
            { width: 800, height: 800, crop: "limit" },
            { quality: "auto:authenticative" },
          ],
        }
      );

      // Return the secure URL for use in the branding configuration
      return {
        success: true,
        logoUrl: result.secure_url,
        error: undefined,
      };
    } catch (error) {
      console.error("Cloudinary upload failed:", error);
      return {
        success: false,
        error: "Failed to upload branding image. Please try again.",
      };
    }
  } else {
    // Cloudinary not configured – return error; do NOT fabricate a URL.
    // In production, set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
    // as environment variables before deploying.
    return {
      success: false,
      error: "Cloudinary not configured. Please configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables.",
    };
  }
}

//**
 * Create an image from a File object for dimension validation.
 */
function createImageFromFile(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target?.string ?? "";
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = reject;
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}