import { RequestHandler } from "express";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface EntraAuthConfig {
  tenantId: string;
  audience: string;
  requiredScope: string;
}

export class EntraAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope"
  ) {
    super(message);
    this.name = "EntraAuthError";
  }
}

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getEntraAuthConfig(
  environment: NodeJS.ProcessEnv = process.env
): EntraAuthConfig | undefined {
  const tenantId = environment.ENTRA_TENANT_ID?.trim();
  const audience = environment.ENTRA_AUDIENCE?.trim();
  const requiredScope = environment.ENTRA_REQUIRED_SCOPE?.trim();
  const configuredValues = [tenantId, audience, requiredScope].filter(Boolean);

  if (configuredValues.length === 0) {
    return undefined;
  }
  if (!tenantId || !audience || !requiredScope) {
    throw new Error(
      "ENTRA_TENANT_ID, ENTRA_AUDIENCE, and ENTRA_REQUIRED_SCOPE must all be set to enable the authenticated MCP endpoint."
    );
  }
  if (!tenantIdPattern.test(tenantId)) {
    throw new Error("ENTRA_TENANT_ID must be a Microsoft Entra tenant GUID.");
  }
  if (/\s/.test(audience)) {
    throw new Error("ENTRA_AUDIENCE cannot contain whitespace.");
  }
  if (/\s/.test(requiredScope)) {
    throw new Error("ENTRA_REQUIRED_SCOPE must contain exactly one scope value.");
  }

  return {
    tenantId: tenantId.toLowerCase(),
    audience,
    requiredScope,
  };
}

export function getBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    throw new EntraAuthError("A bearer token is required.", 401, "invalid_token");
  }
  return match[1];
}

export async function verifyEntraToken(
  token: string,
  config: EntraAuthConfig,
  key: CryptoKey | JWTVerifyGetKey
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      audience: config.audience,
      issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    }));
  } catch {
    throw new EntraAuthError(
      "The bearer token is invalid.",
      401,
      "invalid_token"
    );
  }

  if (
    typeof payload.tid !== "string" ||
    payload.tid.toLowerCase() !== config.tenantId
  ) {
    throw new EntraAuthError(
      "The bearer token is invalid.",
      401,
      "invalid_token"
    );
  }

  const scopes =
    typeof payload.scp === "string" ? payload.scp.split(/\s+/) : [];
  if (!scopes.includes(config.requiredScope)) {
    throw new EntraAuthError(
      "The bearer token does not contain the required scope.",
      403,
      "insufficient_scope"
    );
  }

  return payload;
}

export function createEntraAuthMiddleware(
  config: EntraAuthConfig
): RequestHandler {
  const key = createRemoteJWKSet(
    new URL(
      `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`
    )
  );

  return async (req, res, next) => {
    try {
      const token = getBearerToken(req.header("authorization"));
      res.locals.entraClaims = await verifyEntraToken(token, config, key);
      next();
    } catch (error) {
      if (!(error instanceof EntraAuthError)) {
        next(error);
        return;
      }

      const challenge =
        error.status === 403
          ? `Bearer error="${error.code}", scope="${config.requiredScope}"`
          : `Bearer error="${error.code}"`;
      res.set("WWW-Authenticate", challenge);
      res.status(error.status).json({
        error: error.code,
        error_description: error.message,
      });
    }
  };
}
