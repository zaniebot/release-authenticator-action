const proxyEnvironmentKeys = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
];

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function getBooleanInput(name) {
  const upper = name.replace(/ /g, "_").toUpperCase();
  const value =
    process.env[`INPUT_${upper}`] ||
    process.env[`INPUT_${upper.replace(/-/g, "_")}`] ||
    "";
  const normalized = value.trim().toLowerCase();

  if (normalized === "" || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error(`Invalid boolean input for ${name}: ${value}`);
}

function getState(name) {
  return process.env[`STATE_${name}`] || "";
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

function tokenExpiresIn(expiresAt) {
  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  return Math.round((expiry - now) / 1000);
}

function isRetryableStatus(status) {
  return retryableStatuses.has(status);
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    return Math.max(retryAt - Date.now(), 0);
  }

  return null;
}

function getRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, 30000);
  }

  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function revokeTokenWithRetry(apiUrl, token, retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/installation/token`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
      });

      if (response.status === 204) {
        return "revoked";
      }

      if (response.status === 401) {
        return "already-invalid";
      }

      lastError = new Error(
        `Token revocation failed with status ${response.status}`,
      );
      if (attempt > retries || !isRetryableStatus(response.status)) {
        break;
      }

      const delayMs = getRetryDelayMs(
        attempt,
        response.headers.get("retry-after"),
      );
      info(
        `Token revocation attempt ${attempt} failed with status ${response.status}, retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt > retries) {
        break;
      }

      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      info(`Token revocation attempt ${attempt} failed, retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Token revocation failed");
}

async function run() {
  try {
    const skipTokenRevoke = getBooleanInput("skip-token-revoke");
    if (skipTokenRevoke) {
      info("Token revocation skipped");
      return;
    }

    const token = getState("token");
    if (!token) {
      info("No token found in state");
      return;
    }

    const expiresAt = getState("expiresAt");
    if (expiresAt && tokenExpiresIn(expiresAt) < 0) {
      info("Token already expired, skipping revocation");
      return;
    }

    ensureNativeProxySupport();

    const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(
      /\/$/,
      "",
    );
    const result = await revokeTokenWithRetry(apiUrl, token);

    if (result === "already-invalid") {
      info("Token already invalid, skipping revocation");
      return;
    }

    info("Token revoked");
  } catch (error) {
    setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  ensureNativeProxySupport,
  getBooleanInput,
  getState,
  getRetryDelayMs,
  isRetryableStatus,
  parseRetryAfterMs,
  revokeTokenWithRetry,
  tokenExpiresIn,
};
