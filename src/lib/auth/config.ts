import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/db/prisma";
import { loginSchema } from "@/lib/validations/auth";
import { isSessionValid } from "@/lib/auth/session";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { rateLimit, getClientIpFromHeaders } from "@/lib/security/rate-limit";
import { maskEmail } from "@/lib/utils";
import bcrypt from "bcryptjs";
import type { PlatformRole, UserStatus } from "@prisma/client";

// Session lifetime and rotation.
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours
const SESSION_UPDATE_AGE_SECONDS = 15 * 60; // refresh at most every 15 min

// Login throttling windows (per process — see rate-limit.ts for production note).
const LOGIN_LIMIT_PER_IP = 10;
const LOGIN_LIMIT_PER_EMAIL = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function requireEmailVerification(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

/**
 * Auth.js v5 configuration for AmisiBiz.
 * - Credentials provider with server-side bcrypt verification.
 * - Prisma adapter persists sessions and accounts in the database.
 * - JWT sessions carry the platform role + session version; the session callback
 *   re-reads the user on every request to enforce status and revocation.
 * - Login attempts are rate-limited and failures are audited (never logging the
 *   submitted password).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  pages: {
    signIn: "/en/login",
    error: "/en/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        // 1. Validate input shape with Zod — never trust raw browser input
        const result = loginSchema.safeParse(credentials);
        if (!result.success) return null;

        const { email, password } = result.data;

        // 2. Rate limit by IP and by email independently.
        const ip = request?.headers
          ? getClientIpFromHeaders(request.headers)
          : null;
        const ipKey = `login:ip:${ip ?? "unknown"}`;
        const emailKey = `login:email:${email}`;
        const ipLimit = await rateLimit(ipKey, {
          limit: LOGIN_LIMIT_PER_IP,
          windowMs: LOGIN_WINDOW_MS,
        });
        const emailLimit = await rateLimit(emailKey, {
          limit: LOGIN_LIMIT_PER_EMAIL,
          windowMs: LOGIN_WINDOW_MS,
        });
        if (!ipLimit.success || !emailLimit.success) {
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_LOGIN_RATE_LIMITED,
            metadata: { email: maskEmail(email) },
            ipAddress: ip,
          });
          return null;
        }

        // 3. Look up user — select only what is needed
        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
            password: true,
            platformRole: true,
            status: true,
            emailVerified: true,
            sessionVersion: true,
          },
        });

        if (!user || !user.password) {
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
            metadata: {
              email: maskEmail(email),
              reason: "invalid_credentials",
            },
            ipAddress: ip,
          });
          return null;
        }

        // 4. Check account status before verifying password (fail fast)
        if (user.status !== "ACTIVE") {
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
            userId: user.id,
            metadata: { reason: "inactive_account", status: user.status },
            ipAddress: ip,
          });
          return null;
        }

        // 5. Optional email verification gate
        if (requireEmailVerification() && !user.emailVerified) {
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
            userId: user.id,
            metadata: { reason: "email_not_verified" },
            ipAddress: ip,
          });
          return null;
        }

        // 6. Verify password with constant-time bcrypt compare
        const passwordValid = await bcrypt.compare(password, user.password);
        if (!passwordValid) {
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
            userId: user.id,
            metadata: { reason: "invalid_credentials" },
            ipAddress: ip,
          });
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
          platformRole: user.platformRole,
          status: user.status,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Persist platform role, status and session version on first sign-in.
      if (user) {
        token.platformRole = (
          user as { platformRole: PlatformRole }
        ).platformRole;
        token.status = (user as { status: UserStatus }).status;
        token.sessionVersion = (
          user as { sessionVersion: number }
        ).sessionVersion;
        if (user.id) {
          token.userId = user.id;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId && typeof token.userId === "string") {
        const freshUser = await prisma.user.findUnique({
          where: { id: token.userId },
          select: { status: true, platformRole: true, sessionVersion: true },
        });

        const tokenVersion =
          typeof token.sessionVersion === "number" ? token.sessionVersion : 0;

        // Revoked (version bumped) or invalid account — invalidate the session.
        if (!freshUser || !isSessionValid(freshUser, tokenVersion)) {
          return {
            ...session,
            user: {
              ...session.user,
              id: "",
              platformRole: "USER",
              status: "INACTIVE",
            },
            expires: new Date(0).toISOString(),
          };
        }

        session.user.id = token.userId;
        session.user.platformRole = freshUser.platformRole;
        session.user.status = freshUser.status;
      }
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id) {
        await recordAudit({
          action: AUDIT_ACTIONS.AUTH_SIGN_IN,
          userId: user.id,
          resource: "User",
          resourceId: user.id,
        });
      }
    },
    async signOut(message) {
      if (
        "token" in message &&
        message.token?.userId &&
        typeof message.token.userId === "string"
      ) {
        await recordAudit({
          action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
          userId: message.token.userId,
          resource: "User",
          resourceId: message.token.userId,
        });
      }
    },
  },
});
