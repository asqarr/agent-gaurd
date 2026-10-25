import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function configured(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function isStrongSecret(name) {
  const value = process.env[name]?.trim() ?? "";
  return value.length >= 32 && !/^(change-|replace_|secret|password)/i.test(value);
}

function isValidTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value ?? "");
}

function checkUrl(name, { https = false } = {}) {
  try {
    const url = new URL(process.env[name] ?? "");
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
      fail(`${name} must be a clean HTTP(S) origin.`);
    } else if (https && url.protocol !== "https:") {
      fail(`${name} must use HTTPS in production.`);
    }
    return url;
  } catch {
    fail(`${name} is missing or invalid.`);
    return null;
  }
}

async function checkDatabase() {
  if (!configured("DATABASE_URL")) {
    fail("DATABASE_URL is missing.");
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    const [migrationFiles, migrationRows] = await Promise.all([
      readdir(join(root, "apps/api/migrations")),
      pool.query("SELECT version FROM schema_migrations"),
    ]);
    const expected = migrationFiles
      .filter((file) => file.endsWith(".sql"))
      .map((file) => basename(file, ".sql"));
    const applied = new Set(migrationRows.rows.map((row) => row.version));
    for (const version of expected) {
      if (!applied.has(version)) fail(`Database migration ${version} is not applied.`);
    }
  } catch (error) {
    if (production) fail(`Database check failed: ${error instanceof Error ? error.message : String(error)}`);
    else warn(`Database check could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkProductionCompose() {
  try {
    const compose = await readFile(join(root, "docker-compose.prod.yml"), "utf8");
    for (const name of [
      "MY_TRONLINK_PUBLIC_ADDRESS",
      "TRON_USDT_CONTRACT",
      "TRON_GRID_URL",
      "TRONSCAN_API_URL",
      "TRON_PRO_API_KEY",
      "TRON_MAX_LOOKBACK_MS",
      "TRON_REQUEST_TIMEOUT_MS",
    ]) {
      if (!compose.includes(`${name}:`)) fail(`docker-compose.prod.yml does not pass ${name} to the API.`);
    }
    if (!compose.includes("image: caddy:")) fail("Production Compose must terminate public traffic with Caddy HTTPS.");
    if (!compose.includes("apps/backup/Dockerfile") || !compose.includes("postgres-backup-loop.sh") || !compose.includes("BACKUP_AGE_RECIPIENT")) {
      fail("Production Compose must include encrypted, verified PostgreSQL backups.");
    }
    await readFile(join(root, "Caddyfile"), "utf8");
    await readFile(join(root, "scripts/postgres-backup-loop.sh"), "utf8");
  } catch (error) {
    fail(`Production compose could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkConfiguration() {
  if (production) {
    if (process.env.NODE_ENV !== "production") fail("NODE_ENV must be production.");
    const domain = process.env.DOMAIN?.trim().toLowerCase() ?? "";
    const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
    if (!validDomain) {
      fail("DOMAIN must be a real bare hostname without a scheme, port, or path.");
    } else if (domain.includes("example.")) {
      fail("DOMAIN still uses an example placeholder.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ACME_EMAIL ?? "") || /example\./i.test(process.env.ACME_EMAIL ?? "")) {
      fail("ACME_EMAIL must be a real monitored email address for certificate notices.");
    }
    const webOrigin = checkUrl("WEB_ORIGIN", { https: true });
    const siteUrl = checkUrl("VITE_SITE_URL", { https: true });
    if (domain && webOrigin?.origin !== `https://${domain}`) fail("WEB_ORIGIN must exactly match https://DOMAIN.");
    if (domain && siteUrl?.origin !== `https://${domain}`) fail("VITE_SITE_URL must exactly match https://DOMAIN.");
    if (!isStrongSecret("JWT_SECRET")) fail("JWT_SECRET is missing or uses a placeholder.");
    if (!isStrongSecret("AGENT_SECRET")) fail("AGENT_SECRET is missing or uses a placeholder.");
    if (!isStrongSecret("POSTGRES_PASSWORD")) fail("POSTGRES_PASSWORD is missing or too weak.");
    const uniqueSecrets = ["JWT_SECRET", "AGENT_SECRET", "POSTGRES_PASSWORD"];
    if (new Set(uniqueSecrets.map((name) => process.env[name])).size !== uniqueSecrets.length) {
      fail("JWT_SECRET, AGENT_SECRET, and POSTGRES_PASSWORD must all be different values.");
    }
    if (process.env.AUTH_COOKIE !== "__Host-agentguard_session") {
      fail("AUTH_COOKIE must use __Host-agentguard_session for production-only Secure cookie scoping.");
    }
    if (process.env.TRUST_PROXY !== "2") fail("TRUST_PROXY must be 2 for the Caddy → Nginx → API proxy chain.");
    try {
      const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
      if (databaseUrl.protocol !== "postgresql:" || databaseUrl.hostname !== "postgres") {
        fail("DATABASE_URL must point to the private PostgreSQL Compose service.");
      }
      if (decodeURIComponent(databaseUrl.username) !== process.env.POSTGRES_USER) {
        fail("DATABASE_URL username must match POSTGRES_USER.");
      }
      if (decodeURIComponent(databaseUrl.password) !== process.env.POSTGRES_PASSWORD) {
        fail("DATABASE_URL password must match POSTGRES_PASSWORD.");
      }
      if (decodeURIComponent(databaseUrl.pathname.slice(1)) !== process.env.POSTGRES_DB) {
        fail("DATABASE_URL database name must match POSTGRES_DB.");
      }
    } catch {
      fail("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (process.env.REQUIRE_EMAIL_VERIFICATION === "true") {
      try {
        const emailWebhook = new URL(process.env.AUTH_EMAIL_WEBHOOK_URL ?? "");
        if (emailWebhook.protocol !== "https:" || /example\./i.test(emailWebhook.hostname)) {
          fail("AUTH_EMAIL_WEBHOOK_URL must be a real HTTPS delivery endpoint.");
        }
      } catch {
        fail("AUTH_EMAIL_WEBHOOK_URL is required when email verification is enabled.");
      }
    } else {
      warn("Email verification is bypassed for the portfolio launch; enable it before accepting production users.");
    }
    if (process.env.ALLOW_PRIVATE_AGENT_ENDPOINTS === "true") fail("ALLOW_PRIVATE_AGENT_ENDPOINTS must be false in production.");
    if (process.env.BACKUP_PATH === "./backups" || !configured("BACKUP_PATH")) {
      warn("The default backup path is on the VPS. Configure encrypted off-site copies and complete a restore drill before accepting customer data.");
    }
    if (!/^age1[0-9a-z]{50,}$/.test(process.env.BACKUP_AGE_RECIPIENT ?? "")) {
      fail("BACKUP_AGE_RECIPIENT must be a valid age public recipient; never place the private identity on the VPS.");
    }
  }

  if (!configured("MY_TRONLINK_PUBLIC_ADDRESS") || !isValidTronAddress(process.env.MY_TRONLINK_PUBLIC_ADDRESS?.trim())) {
    if (production) fail("MY_TRONLINK_PUBLIC_ADDRESS must be a valid TRON public address.");
    else warn("MY_TRONLINK_PUBLIC_ADDRESS is missing or invalid; direct payment checkout is unavailable.");
  }
  if ((process.env.TRON_USDT_CONTRACT ?? "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t") !== "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t") {
    fail("TRON_USDT_CONTRACT must remain the mainnet USDT-TRC20 contract.");
  }
  for (const name of ["TRON_GRID_URL", "TRONSCAN_API_URL"]) {
    try {
      if (new URL(process.env[name] ?? "").protocol !== "https:") fail(`${name} must use HTTPS.`);
    } catch {
      fail(`${name} is missing or invalid.`);
    }
  }
}

await checkProductionCompose();
checkConfiguration();
await checkDatabase();

console.log(`Launch preflight (${production ? "production" : "development"})`);
if (failures.length) {
  console.log("\nBLOCKERS:");
  failures.forEach((message) => console.log(`- ${message}`));
}
if (warnings.length) {
  console.log("\nWARNINGS:");
  warnings.forEach((message) => console.log(`- ${message}`));
}
if (!failures.length) console.log("\nREADY: no blocking configuration issues detected.");
process.exitCode = failures.length ? 1 : 0;
