/**
 * Apple-account-scoped video-review allowance.
 *
 * A verified AppTransaction proves a stable download identity (also after reinstall).
 * A matching, unexpired StoreKit transaction grants the Pro tier.
 * D1 reserves one credit atomically BEFORE any model is called.
 */
import { Buffer } from "node:buffer";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import type { Env } from "./index";

const BUNDLE_ID = "app.rork.n0fxahjvl615phn2ux36f";
const PRO_IDS = new Set([
  `${BUNDLE_ID}.pro.monthly`,
  `${BUNDLE_ID}.pro.yearly`,
]);
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

type QuotaBody = { appTransactionJWS?: unknown; subscriptionJWS?: unknown };
type Identity = { id: string; tier: "free" | "pro"; limit: number };
type DBRow = { used: number };

export const monthKeyUTC = (date: Date): string => date.toISOString().slice(0, 7);
export const allowance = (pro: boolean): number => pro ? 10 : 1;

function reply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: HEADERS });
}

function fail(status: number, code: string, message: string): Response {
  return reply({ error: { code, message } }, status);
}

function selectEnvironment(token: string, env: Env): Environment {
  // This value only selects which verifier to try. Nothing is trusted until
  // Apple's certificate-chain/JWS signature and app identifiers are verified.
  try {
    const raw = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (decoded.environment === "Sandbox" || decoded.receiptType === "Sandbox") {
      if (env.ALLOW_SANDBOX_IAP !== "true") throw new Error("Sandbox disabled");
      return Environment.SANDBOX;
    }
  } catch (error) {
    throw new Error("Missing or disallowed Apple app transaction");
  }
  return Environment.PRODUCTION;
}

async function identify(body: QuotaBody, env: Env): Promise<Identity> {
  if (typeof body.appTransactionJWS !== "string" || body.appTransactionJWS.length > 20000) {
    throw new Error("Missing signed App Store identity");
  }
  if (!env.APPLE_ROOT_CA_BASE64 || !env.APP_APPLE_ID) {
    throw new Error("Apple verification is not configured");
  }

  const environment = selectEnvironment(body.appTransactionJWS, env);
  const verifier = new SignedDataVerifier(
    [Buffer.from(env.APPLE_ROOT_CA_BASE64, "base64")],
    false,
    environment,
    BUNDLE_ID,
    environment === Environment.PRODUCTION ? Number(env.APP_APPLE_ID) : undefined,
  );
  const app = await verifier.verifyAndDecodeAppTransaction(body.appTransactionJWS);
  if (typeof app.appTransactionId !== "string" || !app.appTransactionId) {
    throw new Error("Apple did not provide an app transaction ID");
  }
  // A sandbox and production download MUST NOT share an allowance.
  const id = `${environment}:${app.appTransactionId}`;

  let pro = false;
  if (typeof body.subscriptionJWS === "string" && body.subscriptionJWS.length <= 20000) {
    try {
      const sub = await verifier.verifyAndDecodeTransaction(body.subscriptionJWS);
      pro = Boolean(
        sub.appTransactionId === app.appTransactionId &&
        typeof sub.productId === "string" &&
        PRO_IDS.has(sub.productId) &&
        typeof sub.expiresDate === "number" &&
        sub.expiresDate > Date.now() &&
        !sub.revocationDate &&
        !sub.isUpgraded,
      );
    } catch {
      // An invalid, expired, or unrelated transaction must NEVER grant Pro.
      pro = false;
    }
  }
  return { id, tier: pro ? "pro" : "free", limit: allowance(pro) };
}

async function usedCredits(env: Env, id: string, month: string): Promise<number> {
  const row = await env.VIDEO_QUOTA_DB.prepare(
    "SELECT used FROM video_review_quota WHERE account_id = ? AND month_key = ?",
  ).bind(id, month).first() as DBRow | null;
  return row?.used ?? 0;
}

async function reserve(env: Env, identity: Identity, month: string): Promise<number | null> {
  // ON CONFLICT and WHERE are executed atomically by D1; concurrent requests
  // cannot both claim the final credit.
  const row = await env.VIDEO_QUOTA_DB.prepare(`
    INSERT INTO video_review_quota (account_id, month_key, used)
    VALUES (?, ?, 1)
    ON CONFLICT(account_id, month_key)
    DO UPDATE SET used = used + 1 WHERE used < ?
    RETURNING used
  `).bind(identity.id, month, identity.limit).first() as DBRow | null;
  return row?.used ?? null;
}

async function refund(env: Env, id: string, month: string): Promise<void> {
  await env.VIDEO_QUOTA_DB.prepare(
    "UPDATE video_review_quota SET used = MAX(0, used - 1) WHERE account_id = ? AND month_key = ?",
  ).bind(id, month).run();
}

async function parseRequest(request: Request): Promise<QuotaBody | null> {
  try {
    const value = await request.clone().json();
    return value && typeof value === "object" ? value as QuotaBody : null;
  } catch {
    return null;
  }
}

export async function checkVideoQuota(request: Request, env: Env): Promise<Response> {
  const body = await parseRequest(request);
  if (!body) return fail(400, "invalid_json", "Provide signed App Store identity.");
  if (!env.VIDEO_QUOTA_DB) return fail(503, "quota_unavailable", "Video review is temporarily unavailable.");
  try {
    const identity = await identify(body, env);
    const month = monthKeyUTC(new Date());
    const used = await usedCredits(env, identity.id, month);
    return reply({
      tier: identity.tier, month, limit: identity.limit,
      used, remaining: Math.max(0, identity.limit - used),
    });
  } catch (error) {
    console.error("Video quota lookup failed", String(error));
    return fail(503, "quota_unavailable", "Video review credits could not be checked.");
  }
}

export async function withVideoQuota(
  request: Request,
  env: Env,
  generate: () => Promise<Response>,
): Promise<Response> {
  const body = await parseRequest(request);
  if (!body) return fail(400, "invalid_json", "Provide signed App Store identity.");
  if (!env.VIDEO_QUOTA_DB) return fail(503, "quota_unavailable", "Video review is temporarily unavailable.");

  let identity: Identity;
  try {
    identity = await identify(body, env);
  } catch (error) {
    console.error("Apple entitlement verification failed", String(error));
    return fail(403, "identity_unverified", "Couldn't verify App Store access. Try again later.");
  }

  const month = monthKeyUTC(new Date());
  let used: number | null;
  try {
    used = await reserve(env, identity, month);
  } catch (error) {
    console.error("Video quota reservation failed", String(error));
    return fail(503, "quota_unavailable", "Video review is temporarily unavailable.");
  }
  if (used === null) {
    return fail(429, "quota_exhausted",
      identity.tier === "pro"
        ? "You've used all 10 video reviews this month. Your credits reset next month."
        : "You've used your free video review this month. Upgrade for 10 reviews per month.");
  }

  try {
    const response = await generate();
    if (!response.ok) {
      try { await refund(env, identity.id, month); }
      catch (error) { console.error("Video quota refund failed", String(error)); }
    }
    return response;
  } catch (error) {
    try { await refund(env, identity.id, month); }
    catch (refundError) { console.error("Video quota refund failed", String(refundError)); }
    throw error;
  }
}
