import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  EntraAuthError,
  getBearerToken,
  getEntraAuthConfig,
  verifyEntraToken,
  type EntraAuthConfig,
} from "./entraAuth.js";

const config: EntraAuthConfig = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  audience: "22222222-2222-4222-8222-222222222222",
  requiredScope: "Banking.Access",
};

async function createToken(
  privateKey: CryptoKey,
  overrides: {
    audience?: string;
    expiration?: string | number;
    scope?: string;
    tenantId?: string;
  } = {}
): Promise<string> {
  const tenantId = overrides.tenantId ?? config.tenantId;
  return new SignJWT({
    tid: tenantId,
    scp: overrides.scope ?? config.requiredScope,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(overrides.audience ?? config.audience)
    .setSubject("33333333-3333-4333-8333-333333333333")
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? "5m")
    .sign(privateKey);
}

test("Entra configuration is optional only when no values are set", () => {
  assert.equal(getEntraAuthConfig({}), undefined);
  assert.throws(
    () =>
      getEntraAuthConfig({
        ENTRA_TENANT_ID: config.tenantId,
      }),
    /must all be set/
  );
});

test("bearer token parsing rejects missing and malformed headers", () => {
  assert.equal(getBearerToken("Bearer token-value"), "token-value");
  assert.throws(() => getBearerToken(undefined), EntraAuthError);
  assert.throws(() => getBearerToken("Basic credentials"), EntraAuthError);
  assert.throws(() => getBearerToken("Bearer token extra"), EntraAuthError);
});

test("valid Entra access tokens are accepted", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await createToken(privateKey);
  const payload = await verifyEntraToken(token, config, publicKey);

  assert.equal(payload.tid, config.tenantId);
  assert.equal(payload.scp, config.requiredScope);
});

test("tokens with the wrong audience are rejected", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await createToken(privateKey, { audience: "wrong-audience" });

  await assert.rejects(
    verifyEntraToken(token, config, publicKey),
    (error: unknown) =>
      error instanceof EntraAuthError &&
      error.status === 401 &&
      error.code === "invalid_token"
  );
});

test("expired tokens are rejected", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await createToken(privateKey, {
    expiration: Math.floor(Date.now() / 1000) - 60,
  });

  await assert.rejects(
    verifyEntraToken(token, config, publicKey),
    (error: unknown) =>
      error instanceof EntraAuthError &&
      error.status === 401 &&
      error.code === "invalid_token"
  );
});

test("tokens without the required delegated scope are forbidden", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await createToken(privateKey, { scope: "Other.Scope" });

  await assert.rejects(
    verifyEntraToken(token, config, publicKey),
    (error: unknown) =>
      error instanceof EntraAuthError &&
      error.status === 403 &&
      error.code === "insufficient_scope"
  );
});
