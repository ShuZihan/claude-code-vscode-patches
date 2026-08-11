"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 64_000;

function readSettingsEnvironment(filename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    return parsed && typeof parsed.env === "object" ? parsed.env : {};
  } catch {
    return {};
  }
}

function createConfigReader({ getRuntimeEnvironment, getWorkspaceRoots } = {}) {
  return () => {
    const environment = {};
    Object.assign(
      environment,
      readSettingsEnvironment(path.join(os.homedir(), ".claude", "settings.json")),
      readSettingsEnvironment(
        path.join(os.homedir(), ".claude", "settings.local.json"),
      ),
    );

    const roots = typeof getWorkspaceRoots === "function" ? getWorkspaceRoots() : [];
    for (const root of Array.isArray(roots) ? roots : []) {
      if (typeof root !== "string" || !path.isAbsolute(root)) continue;
      Object.assign(
        environment,
        readSettingsEnvironment(path.join(root, ".claude", "settings.json")),
        readSettingsEnvironment(path.join(root, ".claude", "settings.local.json")),
      );
    }

    const runtimeEnvironment =
      typeof getRuntimeEnvironment === "function" ? getRuntimeEnvironment() : process.env;
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]) {
      if (typeof runtimeEnvironment?.[name] === "string" && runtimeEnvironment[name]) {
        environment[name] = runtimeEnvironment[name];
      }
    }

    return {
      baseUrl: environment.ANTHROPIC_BASE_URL || "",
      token:
        environment.ANTHROPIC_AUTH_TOKEN || environment.ANTHROPIC_API_KEY || "",
    };
  };
}

function requestJson(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
      },
      (response) => {
        let body = "";
        let tooLarge = false;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
            tooLarge = true;
            request.destroy(new Error("Provider response exceeded the size limit"));
          }
        });
        response.on("end", () => {
          if (tooLarge) return;
          let data = null;
          try {
            data = body ? JSON.parse(body) : null;
          } catch {
            reject(Object.assign(new Error("Provider returned invalid JSON"), { code: "invalid_json" }));
            return;
          }
          if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
            const error = new Error("Provider usage request failed");
            error.statusCode = response.statusCode || 500;
            error.providerMessage =
              data?.error?.message || data?.message || "Provider request failed";
            reject(error);
            return;
          }
          resolve(data);
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("Provider usage request timed out"), { code: "timeout" }));
    });
    request.on("error", reject);
    request.end();
  });
}

function safeDecimal(value) {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
    ? value
    : null;
}

function createDeepSeekAdapter({ request }) {
  return {
    id: "deepseek",
    displayName: "DeepSeek",
    matches(config) {
      try {
        const base = new URL(config.baseUrl);
        return base.protocol === "https:" && base.hostname === "api.deepseek.com";
      } catch {
        return false;
      }
    },
    async query(config, fetchedAt) {
      const data = await request("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      if (
        !data ||
        typeof data.is_available !== "boolean" ||
        !Array.isArray(data.balance_infos)
      ) {
        throw Object.assign(new Error("DeepSeek returned an invalid balance response"), {
          code: "invalid_response",
        });
      }

      const resources = data.balance_infos.map((balance) => {
        const currency = balance?.currency;
        const totalBalance = safeDecimal(balance?.total_balance);
        const grantedBalance = safeDecimal(balance?.granted_balance);
        const toppedUpBalance = safeDecimal(balance?.topped_up_balance);
        if (
          !["CNY", "USD"].includes(currency) ||
          totalBalance === null ||
          grantedBalance === null ||
          toppedUpBalance === null
        ) {
          throw Object.assign(new Error("DeepSeek returned malformed balance fields"), {
            code: "invalid_response",
          });
        }
        return {
          kind: "money",
          currency,
          totalBalance,
          grantedBalance,
          toppedUpBalance,
        };
      });

      return {
        version: 1,
        providerId: this.id,
        providerName: this.displayName,
        status: "ready",
        isAvailable: data.is_available,
        resources,
        fetchedAt,
        stale: false,
      };
    },
  };
}

function errorCode(error) {
  if (error?.statusCode === 401) return "unauthorized";
  if (error?.statusCode === 403) return "forbidden";
  if (error?.statusCode === 429) return "rate_limited";
  if (error?.statusCode >= 500) return "provider_unavailable";
  if (typeof error?.code === "string") return error.code;
  return "network_error";
}

function configCacheKey(adapter, config) {
  const tokenHash = crypto
    .createHash("sha256")
    .update(config.token)
    .digest("hex")
    .slice(0, 16);
  return `${adapter.id}|${config.baseUrl}|${tokenHash}`;
}

function createProviderUsageModule({
  readConfig,
  request = requestJson,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  getRuntimeEnvironment,
  getWorkspaceRoots,
} = {}) {
  const resolveConfig =
    readConfig || createConfigReader({ getRuntimeEnvironment, getWorkspaceRoots });
  const adapters = [createDeepSeekAdapter({ request })];
  let cache = null;

  async function query({ force = false } = {}) {
    const fetchedAtMs = now();
    const fetchedAt = new Date(fetchedAtMs).toISOString();
    const config = await resolveConfig();
    const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl : "";
    const token = typeof config?.token === "string" ? config.token : "";
    const normalizedConfig = { baseUrl, token };
    const adapter = adapters.find((candidate) => candidate.matches(normalizedConfig));

    if (!adapter) {
      return {
        version: 1,
        providerId: null,
        providerName: "当前提供商",
        status: baseUrl ? "unsupported" : "unconfigured",
        resources: [],
        fetchedAt,
        stale: false,
      };
    }
    if (!token) {
      return {
        version: 1,
        providerId: adapter.id,
        providerName: adapter.displayName,
        status: "unconfigured",
        resources: [],
        fetchedAt,
        stale: false,
      };
    }

    const key = configCacheKey(adapter, normalizedConfig);
    if (!force && cache?.key === key && fetchedAtMs - cache.createdAt < ttlMs) {
      return cache.report;
    }

    try {
      const report = await adapter.query(normalizedConfig, fetchedAt);
      cache = { key, createdAt: fetchedAtMs, report };
      return report;
    } catch (error) {
      return {
        version: 1,
        providerId: adapter.id,
        providerName: adapter.displayName,
        status: "error",
        errorCode: errorCode(error),
        resources: [],
        fetchedAt,
        stale: false,
      };
    }
  }

  return Object.freeze({ query });
}

module.exports = { createProviderUsageModule };
