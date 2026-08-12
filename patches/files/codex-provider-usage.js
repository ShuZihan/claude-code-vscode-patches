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

function createConfigReader({ getRuntimeEnvironment, homeDirectory = os.homedir() } = {}) {
  return ({ cwd } = {}) => {
    const environment = {};
    Object.assign(
      environment,
      readSettingsEnvironment(path.join(homeDirectory, ".claude", "settings.json")),
      readSettingsEnvironment(
        path.join(homeDirectory, ".claude", "settings.local.json"),
      ),
    );

    if (typeof cwd === "string" && path.isAbsolute(cwd)) {
      Object.assign(
        environment,
        readSettingsEnvironment(path.join(cwd, ".claude", "settings.json")),
        readSettingsEnvironment(path.join(cwd, ".claude", "settings.local.json")),
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

function safeNumber(value) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function providerOrigin(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
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

function createNewApiAdapter({ request }) {
  return {
    id: "new-api-compatible",
    displayName: "New API-compatible",
    matches(config) {
      const origin = providerOrigin(config.baseUrl);
      return origin !== null && origin !== "https://api.deepseek.com";
    },
    async query(config, fetchedAt) {
      const origin = providerOrigin(config.baseUrl);
      const status = await request(`${origin}/api/status`);
      const siteName = status?.data?.system_name?.trim();
      const quotaPerUnit = safeNumber(status?.data?.quota_per_unit);
      if (
        status?.success !== true ||
        !siteName ||
        siteName.length > 100 ||
        quotaPerUnit === null
      ) {
        throw Object.assign(new Error("Endpoint is not New API-compatible"), {
          code: "unsupported_provider",
        });
      }
      if (quotaPerUnit === 0) {
        throw Object.assign(new Error("New API returned invalid status data"), {
          code: "invalid_response",
        });
      }
      const quotaDisplayType = status.data.quota_display_type;
      let display;
      if (quotaDisplayType === "CNY") {
        const rate = Number(status.data.usd_exchange_rate);
        if (!Number.isFinite(rate) || rate <= 0) {
          throw Object.assign(new Error("New API returned invalid CNY rate"), {
            code: "invalid_response",
          });
        }
        display = { displayType: "currency", currency: "CNY", rate };
      } else if (quotaDisplayType === "USD") {
        display = { displayType: "currency", currency: "USD", rate: 1 };
      } else if (quotaDisplayType === "TOKENS") {
        display = { displayType: "tokens" };
      } else if (quotaDisplayType === "CUSTOM") {
        const symbol = status.data.custom_currency_symbol?.trim();
        const rate = Number(status.data.custom_currency_exchange_rate);
        if (
          !symbol ||
          symbol.length > 12 ||
          !Number.isFinite(rate) ||
          rate <= 0
        ) {
          throw Object.assign(new Error("New API returned invalid custom currency"), {
            code: "invalid_response",
          });
        }
        display = { displayType: "custom", symbol, rate };
      } else {
        throw Object.assign(new Error("New API returned unsupported quota display"), {
          code: "invalid_response",
        });
      }

      let usage;
      try {
        usage = await request(`${origin}/api/usage/token/`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });
      } catch (error) {
        error.providerName = siteName;
        throw error;
      }
      const data = usage?.data;
      const totalGranted = safeNumber(data?.total_granted);
      const totalUsed = safeNumber(data?.total_used);
      const totalAvailable = safeNumber(data?.total_available);
      if (
        usage?.code !== true ||
        data?.object !== "token_usage" ||
        totalGranted === null ||
        totalUsed === null ||
        totalAvailable === null ||
        typeof data?.unlimited_quota !== "boolean" ||
        typeof data?.name !== "string" ||
        data.name.length > 100 ||
        !Number.isSafeInteger(data?.expires_at) ||
        data.expires_at < 0
      ) {
        throw Object.assign(new Error("New API returned invalid token usage"), {
          code: "invalid_response",
        });
      }
      const toDisplayValue = (quota) =>
        display.displayType === "tokens"
          ? String(quota)
          : ((quota / quotaPerUnit) * display.rate).toFixed(2);
      return {
        version: 1,
        providerId: this.id,
        providerName: siteName,
        status: "ready",
        isAvailable: data.unlimited_quota || totalAvailable > 0,
        resources: [
          {
            kind: "quota",
            ...(display.displayType === "currency"
              ? { displayType: "currency", currency: display.currency }
              : display.displayType === "custom"
                ? { displayType: "custom", symbol: display.symbol }
                : { displayType: "tokens" }),
            totalAvailable: toDisplayValue(totalAvailable),
            totalGranted: toDisplayValue(totalGranted),
            totalUsed: toDisplayValue(totalUsed),
            unlimited: data.unlimited_quota,
            tokenName: data.name,
            expiresAt: data.expires_at,
          },
        ],
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
  const normalizedBaseUrl = providerOrigin(config.baseUrl) || config.baseUrl;
  return `${adapter.id}|${normalizedBaseUrl}|${tokenHash}`;
}

function createProviderUsageModule({
  readConfig,
  request = requestJson,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  getRuntimeEnvironment,
  homeDirectory,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const resolveConfig =
    readConfig || createConfigReader({ getRuntimeEnvironment, homeDirectory });
  const adapters = [
    createDeepSeekAdapter({ request }),
    createNewApiAdapter({ request }),
  ];
  const cacheByKey = new Map();
  const inFlightByKey = new Map();
  const clients = new Map();
  let refreshTimer = null;
  let disposed = false;

  async function query({ force = false, cwd } = {}) {
    const fetchedAtMs = now();
    const fetchedAt = new Date(fetchedAtMs).toISOString();
    const config = await resolveConfig({ cwd });
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
    const cache = cacheByKey.get(key);
    if (
      !force &&
      cache &&
      fetchedAtMs - cache.createdAt < ttlMs
    ) {
      return cache.report;
    }
    const existingRequest = inFlightByKey.get(key);
    if (existingRequest) return existingRequest;

    const pending = (async () => {
      let report;
      try {
        report = await adapter.query(normalizedConfig, fetchedAt);
      } catch (error) {
        const failure =
          error?.code === "unsupported_provider"
            ? {
                version: 1,
                providerId: null,
                providerName: "当前提供商",
                status: "unsupported",
                resources: [],
                fetchedAt,
                stale: false,
              }
            : {
                version: 1,
                providerId: adapter.id,
                providerName: error?.providerName || adapter.displayName,
                status: "error",
                errorCode: errorCode(error),
                resources: [],
                fetchedAt,
                stale: false,
              };
        report =
          cache?.report.status === "ready"
            ? {
                ...cache.report,
                stale: true,
                errorCode: failure.errorCode || "unsupported_provider",
                failedAt: fetchedAt,
              }
            : failure;
      }
      cacheByKey.set(key, { createdAt: fetchedAtMs, report });
      return report;
    })();
    inFlightByKey.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inFlightByKey.get(key) === pending) inFlightByKey.delete(key);
    }
  }

  function scheduleRefresh() {
    if (disposed || refreshTimer !== null || clients.size === 0) return;
    refreshTimer = setTimer(refreshTrackedClients, ttlMs);
    refreshTimer?.unref?.();
  }

  async function refreshTrackedClients() {
    refreshTimer = null;
    if (disposed) return;
    const snapshot = [...clients.entries()];
    try {
      await Promise.allSettled(
        snapshot.map(async ([id, client]) => {
          const report = await query({ cwd: client.cwd });
          if (clients.get(id) === client) await client.onUpdate(report);
        }),
      );
    } finally {
      scheduleRefresh();
    }
  }

  function trackClient(id, { cwd, onUpdate }) {
    if (typeof onUpdate !== "function") {
      throw new TypeError("Provider usage client requires an update callback");
    }
    clients.set(id, { cwd, onUpdate });
    scheduleRefresh();
  }

  function untrackClient(id) {
    clients.delete(id);
    if (clients.size === 0 && refreshTimer !== null) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
  }

  function dispose() {
    disposed = true;
    clients.clear();
    if (refreshTimer !== null) clearTimer(refreshTimer);
    refreshTimer = null;
  }

  return Object.freeze({ dispose, query, trackClient, untrackClient });
}

module.exports = { createProviderUsageModule };
