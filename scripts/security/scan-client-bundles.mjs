#!/usr/bin/env node
/**
 * Proof 8, automated (task #37c).
 *
 * "Privileged database credentials are absent from client bundles" used to be a
 * claim backed by review. It is now a check that fails the build: anything that
 * reaches a browser — the Next.js client chunks, static assets and any server
 * code that got inlined into them — is scanned for the shapes a Supabase secret
 * key, a service-role JWT, a database connection string with an embedded
 * password, or a bearer token would take.
 *
 * Deliberate choices:
 *
 * - It scans build OUTPUT, not source. Source may legitimately name these
 *   secrets (env validation, this file's own patterns). The question proof 8 asks
 *   is what ships to a client.
 * - The patterns are structural, never a literal value. A committed copy of a real
 *   credential would turn this scanner into the leak it is looking for.
 * - `sb_publishable_*` and the anon key are expected in the client and are not
 *   findings. The secret-family key (`sb_secret_*`), the service-role token and
 *   any `postgres://user:password@` URL are.
 * - JWT-shaped candidates are confirmed by decoding the header segment and looking
 *   for `alg`/`typ`, because minified chunks are full of base64-looking noise.
 * - Findings print the file, the line number and a redacted window around the
 *   match. Never the whole match: a credential is exactly what it is.
 *
 * Usage:
 *   node scripts/security/scan-client-bundles.mjs [dir ...]
 *
 * With no arguments it scans apps/web/.next/static (the client bundle) and, when
 * present, apps/web/.next/server — the server tree is included because a secret
 * that reaches it must not be reachable from a client chunk either, and inlining
 * can move code between the two.
 *
 * Exit 0 = clean, 1 = findings, 2 = could not run (missing build output).
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const RULES = [
  {
    id: "supabase-secret-key",
    what: "Supabase secret API key (sb_secret_*)",
    pattern: /\bsb_secret_[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "service-role-token",
    what: "Supabase service-role token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    confirm: looksLikeJwt,
  },
  {
    id: "service-role-literal",
    what: "literal service_role credential marker",
    pattern: /["']service_role["']/g,
  },
  {
    id: "postgres-url-with-password",
    what: "Postgres connection string with an embedded password",
    pattern:
      /\bpost(?:gres|gresql):\/\/[^\s"'`)\\]{1,200}?:[^\s"'`)\\@]{1,200}?@/g,
    // Our own error messages legitimately show the shape an operator should use
    // ("postgresql://amisibiz_app:<password>@<host>…"). A real credential never
    // contains a placeholder marker, so demanding that keeps the check honest
    // without blinding it to an actual password.
    confirm: (c) => !/[<>]|\$\{/.test(c),
  },
  {
    id: "supabase-jwt-secret-assignment",
    what: "Supabase JWT signing secret material",
    pattern: /SUPABASE_JWT_SECRET\s*[:=]\s*["'][^"']{16,}["']/g,
  },
];

/** Confirm a JWT candidate really decodes to a header with alg/typ. */
function looksLikeJwt(candidate) {
  const header = candidate.split(".")[0];
  try {
    const json = Buffer.from(header, "base64url").toString("utf8");
    return /"(?:alg|typ)"\s*:/.test(json);
  } catch {
    return false;
  }
}

const SKIP_EXT = new Set([
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".avif",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function defaultTargets() {
  const candidates = [
    join(ROOT, "apps", "web", ".next", "static"),
    join(ROOT, "apps", "web", ".next", "server"),
  ];
  return candidates.filter((c) => existsSync(c));
}

const args = process.argv.slice(2);
const targets =
  args.length > 0 ? args.map((a) => join(ROOT, a)) : defaultTargets();

if (targets.length === 0) {
  console.error(
    "scan-client-bundles: no build output to scan.\n" +
      "  Run the production build first (pnpm build), or pass a directory:\n" +
      "    node scripts/security/scan-client-bundles.mjs apps/web/.next/static",
  );
  process.exit(2);
}

const findings = [];
let filesScanned = 0;
let bytesScanned = 0;

for (const target of targets) {
  if (!existsSync(target)) {
    console.error(
      `scan-client-bundles: missing target ${relative(ROOT, target)}`,
    );
    process.exit(2);
  }
  for (const file of walk(target)) {
    if (SKIP_EXT.has(file.slice(file.lastIndexOf(".")).toLowerCase())) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable or binary-incompatible; not a client script
    }
    filesScanned += 1;
    bytesScanned += Buffer.byteLength(text);
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(text)) !== null) {
        const candidate = m[0];
        if (rule.confirm && !rule.confirm(candidate)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        findings.push({
          rule: rule.id,
          what: rule.what,
          file: relative(ROOT, file).split(sep).join("/"),
          line,
          excerpt: redact(text, m.index, candidate.length),
        });
        if (rule.pattern.global === false) break;
      }
    }
  }
}

function redact(text, index, length) {
  const head = text.slice(Math.max(0, index - 24), index);
  const tail = text.slice(index + length, index + length + 24);
  const mask =
    length <= 12
      ? "•".repeat(length)
      : `${text[index]}${"•".repeat(6)}${text[index + length - 1]}`;
  return `${head.replace(/\s+/g, " ")}${mask}${tail.replace(/\s+/g, " ")}`;
}

console.log(
  `scan-client-bundles: ${filesScanned} file(s), ${(bytesScanned / 1024 / 1024).toFixed(1)} MB scanned ` +
    `across ${targets.map((t) => relative(ROOT, t).split(sep).join("/")).join(", ")}`,
);

if (findings.length === 0) {
  console.log(
    `clean — no ${RULES.map((r) => r.what).join(", ")} reached the scanned output.`,
  );
  process.exit(0);
}

console.error(
  `\nFAIL: ${findings.length} finding(s) — proof 8 (privileged credentials absent from client bundles):\n`,
);
for (const f of findings) {
  console.error(`  [${f.rule}] ${f.file}:${f.line}`);
  console.error(`      ${f.what}`);
  console.error(`      …${f.excerpt}…`);
}
console.error(
  "\nA finding here means a privileged value reached code a client can read. " +
    "Treat the value as compromised: rotate it, remove it from the bundle, and " +
    "re-run this scan. Never add it to an allow-list.",
);
process.exit(1);
