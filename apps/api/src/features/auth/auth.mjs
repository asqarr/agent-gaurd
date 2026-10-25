import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../../core/config.mjs";
import {
  createRefreshSession as createRefreshSessionRecord,
  findUserById,
  revokeRefreshSession as revokeRefreshSessionRecord,
  rotateRefreshSession,
} from "../../infrastructure/repository.mjs";

const maxAgeSeconds = 60 * 60 * 24 * 7;
const refreshMaxAgeSeconds = 60 * 60 * 24 * 30;
const refreshCookieName = `${config.authCookie}_refresh`;

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createActionToken(prefix = "ag_action") {
  const raw = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

export function hashActionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const bytes = [];
  for (const character of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid MFA secret.");
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function createMfaSecret() {
  return base32Encode(randomBytes(20));
}

export function createOtpAuthUri({ secret, email, issuer = "AgentGuard" }) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function totpForCounter(secret, counter) {
  const digest = createHmac("sha1", base32Decode(secret))
    .update(Buffer.from(counter.toString(16).padStart(16, "0"), "hex"))
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(value % 1000000).padStart(6, "0");
}

export function verifyMfaCode(secret, code, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code))) return false;
  const currentCounter = Math.floor(now / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    const expected = Buffer.from(totpForCounter(secret, currentCounter + offset));
    const actual = Buffer.from(String(code));
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

export function issueMfaChallenge(user) {
  return jwt.sign(
    { sub: user.id, userId: user.id, purpose: "mfa_login" },
    config.jwtSecret,
    { expiresIn: "5m" },
  );
}

export function verifyMfaChallenge(token) {
  const claims = jwt.verify(token, config.jwtSecret);
  if (claims.purpose !== "mfa_login") throw new Error("Invalid MFA challenge.");
  return claims;
}

export function issueSession(user) {
  return jwt.sign(
    {
      sub: user.id,
      userId: user.id,
      workspaceId: user.workspaceId,
      workspaceName: user.workspaceName,
      email: user.email,
      name: user.name,
      role: user.role,
      sessionVersion: Number(user.sessionVersion ?? user.session_version ?? 0),
    },
    config.jwtSecret,
    { expiresIn: "7d" },
  );
}

function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createRefreshToken() {
  return `ag_refresh_${randomBytes(32).toString("base64url")}`;
}

function toSessionUser(user) {
  return {
    id: user.user_id ?? user.id,
    email: user.email,
    name: user.name,
    workspaceId: user.workspaceId ?? user.workspace_id,
    workspaceName: user.workspaceName ?? user.workspace_name,
    role: user.role,
    sessionVersion: Number(
      user.sessionVersion ??
        user.session_version ??
        user.current_session_version ??
        0,
    ),
  };
}

function requestMetadata(req) {
  return {
    userAgent: typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 500)
      : null,
    ipAddress: typeof req.ip === "string" ? req.ip.slice(0, 100) : null,
  };
}

export function setSessionCookie(res, token) {
  const flags = [
    `${config.authCookie}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.isProduction) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

export function setRefreshSessionCookie(res, token) {
  const flags = [
    `${refreshCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${refreshMaxAgeSeconds}`,
  ];
  if (config.isProduction) flags.push("Secure");
  res.append("Set-Cookie", flags.join("; "));
}

export function clearSessionCookie(res) {
  const secure = config.isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${config.authCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function clearRefreshSessionCookie(res) {
  const secure = config.isProduction ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${refreshCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function readCookie(header, name) {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function readToken(req) {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return readCookie(req.headers.cookie, config.authCookie);
}

async function createRefreshSession(res, user, req) {
  const sessionUser = toSessionUser(user);
  const token = createRefreshToken();
  const metadata = requestMetadata(req);
  await createRefreshSessionRecord({
    sessionId: `refresh-${randomUUID()}`,
    userId: sessionUser.id,
    tokenHash: hashRefreshToken(token),
    sessionVersion: sessionUser.sessionVersion,
    expiresAt: new Date(Date.now() + refreshMaxAgeSeconds * 1000),
    ...metadata,
  });
  setRefreshSessionCookie(res, token);
  return sessionUser;
}

async function rotateRefreshSessionFromRequest(req, res) {
  const currentToken = readCookie(req.headers.cookie, refreshCookieName);
  if (!currentToken) return null;

  const nextToken = createRefreshToken();
  const metadata = requestMetadata(req);
  const user = await rotateRefreshSession({
    tokenHash: hashRefreshToken(currentToken),
    nextSessionId: `refresh-${randomUUID()}`,
    nextTokenHash: hashRefreshToken(nextToken),
    nextExpiresAt: new Date(Date.now() + refreshMaxAgeSeconds * 1000),
    ...metadata,
  });
  if (!user) return null;

  const sessionUser = toSessionUser(user);
  setSessionCookie(res, issueSession(sessionUser));
  setRefreshSessionCookie(res, nextToken);
  return sessionUser;
}

function authContext(user) {
  const sessionUser = toSessionUser(user);
  return {
    ...sessionUser,
    userId: sessionUser.id,
    sub: sessionUser.id,
  };
}

function authError(req, res, status, error) {
  return res.status(status).json({ error, requestId: req.requestId });
}

export async function requireAuth(req, res, next) {
  const hasBearerToken = req.headers.authorization?.startsWith("Bearer ");
  let token;
  try {
    token = readToken(req);
  } catch {
    return authError(req, res, 401, "Session expired or invalid.");
  }
  if (!token) {
    if (hasBearerToken) {
      return authError(req, res, 401, "Authentication required.");
    }
    try {
      const refreshed = await rotateRefreshSessionFromRequest(req, res);
      if (!refreshed) {
        return authError(req, res, 401, "Authentication required.");
      }
      req.auth = authContext(refreshed);
      return next();
    } catch {
      return authError(req, res, 401, "Session expired or invalid.");
    }
  }

  try {
    const claims = jwt.verify(token, config.jwtSecret);
    const user = await findUserById(claims.userId ?? claims.sub);
    if (!user || user.workspace_id !== claims.workspaceId) {
      return authError(req, res, 401, "Session is no longer active.");
    }
    if (
      claims.sessionVersion !== undefined &&
      Number(claims.sessionVersion) !== Number(user.session_version ?? 0)
    ) {
      return authError(req, res, 401, "Session is no longer active.");
    }
    const issuedAtMs = claims.iat ? (Number(claims.iat) + 1) * 1000 : 0;
    if (
      issuedAtMs &&
      user.password_changed_at &&
      new Date(user.password_changed_at).getTime() > issuedAtMs
    ) {
      return authError(req, res, 401, "Session is no longer active.");
    }
    req.auth = {
      ...claims,
      workspaceId: user.workspace_id,
      role: user.role,
      email: user.email,
      name: user.name,
    };
    next();
  } catch (error) {
    if (error?.name === "TokenExpiredError" && !hasBearerToken) {
      try {
        const refreshed = await rotateRefreshSessionFromRequest(req, res);
        if (refreshed) {
          req.auth = authContext(refreshed);
          return next();
        }
      } catch {
        // Fall through to the same authentication error as any invalid session.
      }
    }
    return authError(req, res, 401, "Session expired or invalid.");
  }
}

export async function startRefreshSession(res, user, req) {
  return createRefreshSession(res, user, req);
}

export async function revokeRefreshSession(req, res) {
  const token = readCookie(req.headers.cookie, refreshCookieName);
  if (token) await revokeRefreshSessionRecord(hashRefreshToken(token));
  clearSessionCookie(res);
  clearRefreshSessionCookie(res);
}
