const crypto = require("node:crypto");
const fs = require("node:fs");

const proxyEnvironmentKeys = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
];

function envKeysForInput(name) {
  const upper = name.replace(/ /g, "_").toUpperCase();
  return [`INPUT_${upper}`, `INPUT_${upper.replace(/-/g, "_")}`];
}

function getInput(name, { required = false } = {}) {
  const value = envKeysForInput(name)
    .map((key) => process.env[key])
    .find((candidate) => typeof candidate === "string");

  if (required && (!value || value.trim() === "")) {
    throw new Error(`Missing required input: ${name}`);
  }

  return (value || "").trim();
}

function getBooleanInput(name) {
  const value = getInput(name).toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Invalid boolean input for ${name}: ${value}`);
}

function proxyEnvironmentConfigured() {
  return proxyEnvironmentKeys.some((key) => {
    const value = process.env[key];
    return typeof value === "string" && value !== "";
  });
}

function nativeProxySupportEnabled() {
  return process.env.NODE_USE_ENV_PROXY === "1";
}

function ensureNativeProxySupport() {
  if (!proxyEnvironmentConfigured() || nativeProxySupportEnabled()) {
    return;
  }

  throw new Error(
    "A proxy environment variable is set, but Node.js native proxy support is not enabled. Set NODE_USE_ENV_PROXY=1 for this action step.",
  );
}

function info(message) {
  console.log(message);
}

function setFailed(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function setSecret(value) {
  console.log(`::add-mask::${value}`);
}

function appendEnvFile(path, key, value) {
  if (!path) {
    throw new Error(`Missing environment file for ${key}`);
  }
  fs.appendFileSync(path, `${key}=${value}\n`);
}

function setOutput(name, value) {
  appendEnvFile(process.env.GITHUB_OUTPUT, name, value);
}

function saveState(name, value) {
  appendEnvFile(process.env.GITHUB_STATE, name, value);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 3) {
  const method = (options?.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    throw new Error(
      `fetchWithRetry only supports GET/HEAD/OPTIONS requests, got ${method}`,
    );
  }

  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 500 && response.status < 600) {
        throw new Error(`request failed with status ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt > retries) break;

      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      info(`Request attempt ${attempt} failed, retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getAudience(exchangeUrl, audienceInput) {
  if (audienceInput) return audienceInput;
  return new URL(exchangeUrl).origin;
}

async function getIDToken(audience) {
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

  if (!requestToken || !requestUrl) {
    throw new Error(
      "Missing GitHub Actions OIDC environment variables; set 'id-token: write'",
    );
  }

  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await fetchWithRetry(url, {
    headers: {
      authorization: `Bearer ${requestToken}`,
    },
  });

  const body = await response.json();
  if (!response.ok || typeof body.value !== "string") {
    throw new Error("Failed to fetch GitHub Actions OIDC token");
  }

  return body.value;
}

async function run() {
  try {
    ensureNativeProxySupport();

    const exchangeUrl = getInput("url", { required: true });
    const audience = getAudience(exchangeUrl, getInput("audience"));
    const expiresIn = getInput("expires-in");
    const skipTokenRevoke = getBooleanInput("skip-token-revoke");

    info(`Requesting GitHub Actions OIDC token for audience: ${audience}`);
    const oidcToken = await getIDToken(audience);

    const url = new URL(exchangeUrl);
    if (expiresIn) {
      url.searchParams.set("expires_in", expiresIn);
    }

    info(`Exchanging OIDC token with ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${oidcToken}`,
      },
    });

    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(
        `Exchange server returned non-JSON response with status ${response.status}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        body.error || `Exchange failed with status ${response.status}`,
      );
    }

    if (typeof body.token !== "string" || body.token.length === 0) {
      throw new Error("Exchange response did not include a token");
    }

    setSecret(body.token);
    info(`Received installation token (sha256: ${hashToken(body.token)})`);

    setOutput("token", body.token);
    if (typeof body.expires_at === "string") {
      setOutput("expires-at", body.expires_at);
    }
    if (typeof body.repository === "string") {
      setOutput("repository", body.repository);
    }
    if (typeof body.ref === "string") {
      setOutput("ref", body.ref);
    }

    if (!skipTokenRevoke) {
      saveState("token", body.token);
      if (typeof body.expires_at === "string") {
        saveState("expiresAt", body.expires_at);
      }
    }
  } catch (error) {
    setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  ensureNativeProxySupport,
  getInput,
  getBooleanInput,
  getAudience,
};
