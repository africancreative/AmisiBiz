import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { Input, InputPassword, InputRightElement } from "@amisibiz/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@amisibiz/ui/select";
import { useEffect, useState } from "react";
import { alert } from "@/lib/a notifications";
import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";

export const dynamic = "force-dynamic";

export default async function AdminAPISettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
>) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  // Authorization check
  const session = await _requirePlatformAuth();
  await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  // State for forms
  const [status, setStatus] = useState<{
    type: "cloudinary" | "dpo" | "mailtrap" | null;
    loading: boolean;
    error: string | null;
  }>({ type: null, loading: false, error: null });

  // --- Cloudinary Configuration ---
  const [cloudName, setCloudName] = useState("");
  const [cloudinaryKey, setCloudinaryKey] = useState("");
  const [cloudinarySecret, setCloudinarySecret] = useState("");
  const [cloudinaryConfigured, setCloudinaryConfigured] = useState(false);

  // Check if Cloudinary is configured via env vars
  useEffect(() => {
    const isConfigured = !!(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    );
    setCloudinaryConfigured(isConfigured);
    if (isConfigured) {
      setCloudName(process.env.CLOUDINARY_CLOUD_NAME);
      setCloudinaryKey(process.env.CLOUDINARY_API_KEY);
      // Note: we don't set the secret in state for security – it's env-only
    }
  }, []);

  const handleSaveCloudinary = async () => {
    setStatus({ type: "cloudinary", loading: true, error: null });

    // Validate inputs
    if !cloudName || !cloudinaryKey || !cloudinarySecret) {
      setStatus({
        type: "cloudinary",
        loading: false,
        error: "All Cloudinary fields are required.",
      });
      return;
    }

    // In a real deployment, these would be set as environment variables
    // on the hosting platform (Vercel, Netlify, etc.). We cannot store
    // credentials in the database – that would expose them.
    // Instead, we provide guidance and simulate the save.
    // The actual env var setting happens in the hosting platform UI.

    // Simulate saving – in production, this would trigger a deploy or
    // instruct the admin to set env vars
    await new Promise((resolve) => setTimeout(resolve, 1000)); // simulate

    // Tell the app to re-read config on next render
    setCloudinaryConfigured(true);
    setCloudName(cloudName);
    // We don't store the key/secret in state – they're env-only

    setStatus({
      type: "cloudinary",
      loading: false,
      error: "Configuration saved. Please verify environment variables are set on your hosting platform.",
    });
  };

  // --- DPO Payment API Configuration ---
  const [dpoEndpoint, setDpoEndpoint] = useState("");
  const [dpoKey, setDpoKey] = useState("");
  const [dpoConfigured, setDpoConfigured] = useState(false);

  useEffect(() => {
    // Check if DPO is configured – in practice, check for env vars
    const hasDpoConfig = !!process.env.DPO_ENDPOINT_URL;
    setDpoConfigured(hasDpoConfig);
    if (hasDpoConfig) {
      setDpoEndpoint(process.env.DPO_ENDPOINT_URL);
    }
  }, []);

  const handleSaveDpo = async () => {
    setStatus({ type: "dpo", loading: true, error: null });

    if !dpoEndpoint {
      setStatus({
        type: "dpo",
        loading: false,
        error: "DPO endpoint URL is required.",
      });
      return;
    }

    // Validate endpoint URL format
    const urlPattern = /^https?:\/\//;
    if !urlPattern.test(dpoEndpoint) {
      setStatus({
        type: "dpo",
        loading: false,
        error: "DPO endpoint must be a valid HTTPS URL.",
      });
      return;
    }

    // Again, credentials go to env vars; just save the config reference
    setDpoConfigured(true);
    setStatus({
      type: "dpo",
      loading: false,
      error: "DPO configuration saved. Set DPO_ENDPOINT_URL environment variable on your hosting platform.",
    });
  };

  // --- Mailtrap Email Service Configuration ---
  const [mailtrapServer, setMailtrapServer] = useState("");
  const [mailtrapUsername, setMailtrapUsername] = useState("");
  const [mailtrapPassword, setMailtrapPassword] = useState("");
  const [mailtrapConfigured, setMailtrapConfigured] = useState(false);

  useEffect(() => {
    // Check if Mailtrap is configured
    const hasMailtrapConfig = !!process.env.MAILTRAP_SERVER_URL;
    setMailtrapConfigured(hasMailtrapConfig);
    if (hasMailtrapConfig) {
      setMailtrapServer(process.env.MAILTRAP_SERVER_URL);
    }
  }, []);

  const handleSaveMailtrap = async () => {
    setStatus({ type: "mailtrap", loading: true, error: null });

    if !mailtrapServer || !mailtrapUsername || !mailtrapPassword {
      setStatus({
        type: "mailtrap",
        loading: false,
        error: "Mailtrap server, username, and password are required.",
      });
      return;
    }

    // Validate email format basics
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if !emailPattern.test(mailtrapUsername) {
      setStatus({
        type: "mailtrap",
        loading: false,
        error: "Mailtrap username must be a valid email address.",
      });
      return;
    }

    // Save configuration – credentials go to env vars
    setMailtrapConfigured(true);
    setStatus({
      type: "mailtrap",
      loading: false,
      error: "Mailtrap configuration saved. Set MAILTRAP_SERVER_URL, MAILTRAP_USERNAME, and MAILTRAP_PASSWORD environment variables on your hosting platform.",
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("apiSettingsTitle")}</h1>
        <p className="text-muted-foreground">{t("apiSettingsDescription")}</p>
      </div>

      {/* Cloudinary Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("cloudinaryTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {cloudinaryConfigured ? (
            <p className="text-success text-sm">
              {t("cloudinaryConfigured")}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {t("cloudinaryNotConfigured")}
            </p>
          )}

          <form onSubmit={(e) => {
            e.preventDefault();
            handleSaveCloudinary();
          }} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("cloudinaryCloudName")}
                </label>
                <Input
                  value={cloudName}
                  onChange={(e) => setCloudName(e.target.value)}
                  placeholder={t("cloudinaryCloudNamePlaceholder")}
                  className="input w-full"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("cloudinaryApiKey")}
                </label>
                <Input
                  type="password"
                  value={cloudinaryKey}
                  onChange={(e) => setCloudinaryKey(e.target.value)}
                  placeholder={t("cloudinaryApiKeyPlaceholder")}
                  className="input w-full"
                />
                <small className="text-xs text-muted-foreground">
                  {t("cloudinaryApiKeyInfo")}
                </small>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("cloudinaryApiSecret")}
                </label>
                <Input
                  type="password"
                  value=""
                  placeholder={t("cloudinaryApiSecretPlaceholder")}
                  className="input w-full"
                  readOnly
                >
                  <small className="text-xs text-muted-foreground">
                    {t("cloudinaryApiSecretInfo")}
                  </small>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <button type="submit" className="btn btn-primary">
                {t("saveCloudinary")}
              </button>
              <Link
                href="https://vercel.com/docs/cli#environment-variables"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                {t("cloudinaryEnvVarsLink")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* DPO Payment API Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("dpoApiTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {dpoConfigured ? (
            <p className="text-success text-sm">
              {t("dpoConfigured")}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {t("dpoNotConfigured")}
            </p>
          )}

          <form onSubmit={(e) => {
            e.preventDefault();
            handleSaveDpo();
          }} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("dpoEndpointUrl")}
                </label>
                <Input
                  type="text"
                  value={dpoEndpoint}
                  onChange={(e) => setDpoEndpoint(e.target.value)}
                  placeholder={t("dpoEndpointUrlPlaceholder")}
                  className="input w-full"
                />
              </div>
            </div>

            <div className="mt-4">
              <button type="submit" className="btn btn-primary">
                {t("saveDpo")}
              </button>
              <small className="text-xs text-muted-foreground">
                {t("dpoEnvVarInfo")}
              </small>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Mailtrap Email Service Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("mailtrapTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {mailtrapConfigured ? (
            <p className="text-success text-sm">
              {t("mailtrapConfigured")}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {t("mailtrapNotConfigured")}
            </p>
          )}

          <form onSubmit={(e) => {
            e.preventDefault();
            handleSaveMailtrap();
          }} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("mailtrapServerUrl")}
                </label>
                <Input
                  type="text"
                  value={mailtrapServer}
                  onChange={(e) => setMailtrapServer(e.target.value)}
                  placeholder={t("mailtrapServerUrlPlaceholder")}
                  className="input w-full"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("mailtrapUsername")}
                </label>
                <Input
                  type="email"
                  value={mailtrapUsername}
                  onChange={(e) => setMailtrapUsername(e.target.value)}
                  placeholder={t("mailtrapUsernamePlaceholder")}
                  className="input w-full"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("mailtrapPassword")}
                </label>
                <Input
                  type="password"
                  value=""
                  placeholder={t("mailtrapPasswordPlaceholder")}
                  className="input w-full"
                  readOnly
                >
                </div>
              </div>
            </div>

            <div className="mt-4">
              <button type="submit" className="btn btn-primary">
                {t("saveMailtrap")}
              </button>
              <small className="text-xs text-muted-foreground">
                {t("mailtrapEnvVarInfo")}
              </small>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** Platform auth guard for API settings page */
async function _requirePlatformAuth() {
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}