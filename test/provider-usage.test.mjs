import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const providerUsagePath = new URL(
  "../patches/files/codex-provider-usage.js",
  import.meta.url,
);
const providerUsageSource = readFileSync(providerUsagePath, "utf8");
const providerUsageModule = { exports: {} };
const providerUsageRequire = createRequire(providerUsagePath);
new Function("require", "module", "exports", providerUsageSource)(
  providerUsageRequire,
  providerUsageModule,
  providerUsageModule.exports,
);
const { createProviderUsageModule } = providerUsageModule.exports;

const config = {
  baseUrl: "https://api.deepseek.com",
  token: "test-token",
};
const response = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "10.00",
      granted_balance: "0.00",
      topped_up_balance: "10.00",
    },
  ],
};

test("each chat reads only its own project CC settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "provider-usage-projects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  for (const directory of [home, projectA, projectB]) {
    mkdirSync(join(directory, ".claude"), { recursive: true });
  }
  writeFileSync(
    join(projectA, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com",
        ANTHROPIC_AUTH_TOKEN: "project-a-key",
      },
    }),
  );
  writeFileSync(
    join(projectB, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://new-api.project-b.example/v1",
        ANTHROPIC_AUTH_TOKEN: "project-b-key",
      },
    }),
  );

  const requestedUrls = [];
  const usage = createProviderUsageModule({
    homeDirectory: home,
    getWorkspaceRoots: () => [projectA, projectB],
    getRuntimeEnvironment: () => ({}),
    request: async (url) => {
      requestedUrls.push(url);
      if (url === "https://api.deepseek.com/user/balance") return response;
      if (url === "https://new-api.project-b.example/api/status") {
        return {
          success: true,
          data: {
            system_name: "Project B API",
            quota_per_unit: 500_000,
            quota_display_type: "USD",
          },
        };
      }
      if (url === "https://new-api.project-b.example/api/usage/token/") {
        return {
          code: true,
          data: {
            object: "token_usage",
            name: "Project B Key",
            total_granted: 1_000_000,
            total_used: 250_000,
            total_available: 750_000,
            unlimited_quota: false,
            expires_at: 0,
          },
        };
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    },
  });

  const reportA = await usage.query({ cwd: projectA });
  const reportB = await usage.query({ cwd: projectB });

  assert.equal(reportA.providerId, "deepseek");
  assert.equal(reportB.providerName, "Project B API");
  assert.deepEqual(requestedUrls, [
    "https://api.deepseek.com/user/balance",
    "https://new-api.project-b.example/api/status",
    "https://new-api.project-b.example/api/usage/token/",
  ]);
});

test("manual refresh bypasses a fresh local cache", async () => {
  let currentTime = Date.parse("2026-08-11T08:00:00.000Z");
  let requestCount = 0;
  const usage = createProviderUsageModule({
    readConfig: () => config,
    request: async () => {
      requestCount += 1;
      return response;
    },
    now: () => currentTime,
    ttlMs: 60_000,
  });

  const first = await usage.query();
  currentTime += 1;
  const refreshed = await usage.query({ force: true });

  assert.equal(requestCount, 2);
  assert.notStrictEqual(refreshed, first);
});

test("concurrent balance queries share one provider request", async () => {
  let requestCount = 0;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const usage = createProviderUsageModule({
    readConfig: () => config,
    request: () => {
      requestCount += 1;
      return responsePromise;
    },
  });

  const reports = Promise.all([
    usage.query(),
    usage.query({ force: true }),
  ]);
  await Promise.resolve();
  await Promise.resolve();
  resolveResponse(response);
  await reports;

  assert.equal(requestCount, 1);
});

test("interleaved chats keep separate provider caches", async () => {
  const configs = {
    "/project-a": config,
    "/project-b": {
      baseUrl: "https://project-b.example/v1",
      token: "project-b-key",
    },
  };
  const requestedUrls = [];
  const usage = createProviderUsageModule({
    readConfig: ({ cwd }) => configs[cwd],
    request: async (url) => {
      requestedUrls.push(url);
      if (url === "https://api.deepseek.com/user/balance") return response;
      if (url === "https://project-b.example/api/status") {
        return {
          success: true,
          data: {
            system_name: "Project B",
            quota_per_unit: 500_000,
            quota_display_type: "USD",
          },
        };
      }
      return {
        code: true,
        data: {
          object: "token_usage",
          name: "Project B Key",
          total_granted: 1_000_000,
          total_used: 250_000,
          total_available: 750_000,
          unlimited_quota: false,
          expires_at: 0,
        },
      };
    },
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
  });

  await usage.query({ cwd: "/project-a" });
  await usage.query({ cwd: "/project-b" });
  await usage.query({ cwd: "/project-a" });

  assert.equal(
    requestedUrls.filter(
      (url) => url === "https://api.deepseek.com/user/balance",
    ).length,
    1,
  );
});

test("equivalent provider URLs share one normalized cache", async () => {
  let activeBaseUrl = "https://api.deepseek.com";
  let requestCount = 0;
  const usage = createProviderUsageModule({
    readConfig: () => ({ ...config, baseUrl: activeBaseUrl }),
    request: async () => {
      requestCount += 1;
      return response;
    },
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
  });

  await usage.query();
  activeBaseUrl = "https://api.deepseek.com/v1/";
  await usage.query();

  assert.equal(requestCount, 1);
});

test("a failed refresh preserves the last successful balance as stale", async () => {
  let currentTime = Date.parse("2026-08-11T08:00:00.000Z");
  let shouldFail = false;
  const usage = createProviderUsageModule({
    readConfig: () => config,
    request: async () => {
      if (shouldFail) throw new Error("offline");
      return response;
    },
    now: () => currentTime,
  });

  const successful = await usage.query();
  currentTime += 60_000;
  shouldFail = true;
  const stale = await usage.query({ force: true });

  assert.equal(stale.status, "ready");
  assert.equal(stale.stale, true);
  assert.equal(stale.errorCode, "network_error");
  assert.equal(stale.fetchedAt, successful.fetchedAt);
  assert.deepEqual(stale.resources, successful.resources);
});

test("the host scheduler refreshes a tracked chat once after a delayed tick", async () => {
  let currentTime = Date.parse("2026-08-11T08:00:00.000Z");
  let requestCount = 0;
  const timers = [];
  const updates = [];
  const usage = createProviderUsageModule({
    readConfig: () => config,
    request: async () => {
      requestCount += 1;
      return response;
    },
    now: () => currentTime,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  await usage.query({ cwd: "/project-a" });
  usage.trackClient("chat-a", {
    cwd: "/project-a",
    onUpdate: (report) => updates.push(report),
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);

  currentTime += 5 * 60_000;
  await timers[0].callback();

  assert.equal(requestCount, 2);
  assert.equal(updates.length, 1);
  assert.equal(timers.length, 2);
});

test("one closed client cannot stop later scheduled refreshes", async () => {
  let currentTime = Date.parse("2026-08-11T08:00:00.000Z");
  const timers = [];
  const usage = createProviderUsageModule({
    readConfig: () => config,
    request: async () => response,
    now: () => currentTime,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  await usage.query();
  usage.trackClient("chat-a", {
    cwd: "/project-a",
    onUpdate: () => {
      throw new Error("webview was disposed");
    },
  });
  currentTime += 60_000;

  await assert.doesNotReject(timers[0].callback());
  assert.equal(timers.length, 2);
});

test("scheduled refresh re-reads a chat whose provider changed", async () => {
  let currentTime = Date.parse("2026-08-11T08:00:00.000Z");
  let activeConfig = config;
  const timers = [];
  const requestedUrls = [];
  const updates = [];
  const usage = createProviderUsageModule({
    readConfig: () => activeConfig,
    request: async (url) => {
      requestedUrls.push(url);
      if (url === "https://api.deepseek.com/user/balance") return response;
      if (url === "https://new-provider.example/api/status") {
        return {
          success: true,
          data: {
            system_name: "New Provider",
            quota_per_unit: 500_000,
            quota_display_type: "USD",
          },
        };
      }
      return {
        code: true,
        data: {
          object: "token_usage",
          name: "Project Key",
          total_granted: 1_000_000,
          total_used: 250_000,
          total_available: 750_000,
          unlimited_quota: false,
          expires_at: 0,
        },
      };
    },
    now: () => currentTime,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  await usage.query({ cwd: "/project-a" });
  usage.trackClient("chat-a", {
    cwd: "/project-a",
    onUpdate: (report) => updates.push(report),
  });
  activeConfig = {
    baseUrl: "https://new-provider.example/v1",
    token: "new-provider-key",
  };
  currentTime += 60_000;
  await timers[0].callback();

  assert.deepEqual(requestedUrls, [
    "https://api.deepseek.com/user/balance",
    "https://new-provider.example/api/status",
    "https://new-provider.example/api/usage/token/",
  ]);
  assert.equal(updates[0].providerName, "New Provider");
});

test("New API reports the configured site name and CNY token quota", async () => {
  const responses = [
    {
      success: true,
      data: {
        system_name: "星河 API",
        quota_per_unit: 500_000,
        quota_display_type: "CNY",
        usd_exchange_rate: 7.2,
      },
    },
    {
      code: true,
      data: {
        object: "token_usage",
        name: "Claude Code",
        total_granted: 5_000_000,
        total_used: 1_250_000,
        total_available: 3_750_000,
        unlimited_quota: false,
        expires_at: 0,
      },
    },
  ];
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://new-api.example/v1",
      token: "sk-new-api-test",
    }),
    request: async () => responses.shift(),
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
  });

  const report = await usage.query();

  assert.deepEqual(report, {
    version: 1,
    providerId: "new-api-compatible",
    providerName: "星河 API",
    status: "ready",
    isAvailable: true,
    resources: [
      {
        kind: "quota",
        displayType: "currency",
        currency: "CNY",
        totalAvailable: "54.00",
        totalGranted: "72.00",
        totalUsed: "18.00",
        unlimited: false,
        tokenName: "Claude Code",
        expiresAt: 0,
      },
    ],
    fetchedAt: "2026-08-11T08:00:00.000Z",
    stale: false,
  });
});

test("New API honors a site's custom quota currency", async () => {
  const responses = [
    {
      success: true,
      data: {
        system_name: "星河 API",
        quota_per_unit: 500_000,
        quota_display_type: "CUSTOM",
        custom_currency_symbol: "星币",
        custom_currency_exchange_rate: 2.5,
      },
    },
    {
      code: true,
      data: {
        object: "token_usage",
        name: "Claude Code",
        total_granted: 2_000_000,
        total_used: 1_000_000,
        total_available: 1_000_000,
        unlimited_quota: false,
        expires_at: 0,
      },
    },
  ];
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://new-api.example",
      token: "sk-new-api-test",
    }),
    request: async () => responses.shift(),
  });

  const report = await usage.query();

  assert.deepEqual(report.resources, [
    {
      kind: "quota",
      displayType: "custom",
      symbol: "星币",
      totalAvailable: "5.00",
      totalGranted: "10.00",
      totalUsed: "5.00",
      unlimited: false,
      tokenName: "Claude Code",
      expiresAt: 0,
    },
  ]);
});

test("New API reports USD quota without applying a CNY exchange rate", async () => {
  const responses = [
    {
      success: true,
      data: {
        system_name: "USD API",
        quota_per_unit: 500_000,
        quota_display_type: "USD",
      },
    },
    {
      code: true,
      data: {
        object: "token_usage",
        name: "Claude Code",
        total_granted: 1_000_000,
        total_used: 250_000,
        total_available: 750_000,
        unlimited_quota: false,
        expires_at: 0,
      },
    },
  ];
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://usd-api.example",
      token: "sk-new-api-test",
    }),
    request: async () => responses.shift(),
  });

  const report = await usage.query();

  assert.deepEqual(report.resources, [
    {
      kind: "quota",
      displayType: "currency",
      currency: "USD",
      totalAvailable: "1.50",
      totalGranted: "2.00",
      totalUsed: "0.50",
      unlimited: false,
      tokenName: "Claude Code",
      expiresAt: 0,
    },
  ]);
});

test("New API preserves raw quota when the site displays tokens", async () => {
  const responses = [
    {
      success: true,
      data: {
        system_name: "Token API",
        quota_per_unit: 500_000,
        quota_display_type: "TOKENS",
      },
    },
    {
      code: true,
      data: {
        object: "token_usage",
        name: "Claude Code",
        total_granted: 1_000_000,
        total_used: 250_000,
        total_available: 750_000,
        unlimited_quota: false,
        expires_at: 0,
      },
    },
  ];
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://token-api.example/v1",
      token: "sk-new-api-test",
    }),
    request: async () => responses.shift(),
  });

  const report = await usage.query();

  assert.deepEqual(report.resources, [
    {
      kind: "quota",
      displayType: "tokens",
      totalAvailable: "750000",
      totalGranted: "1000000",
      totalUsed: "250000",
      unlimited: false,
      tokenName: "Claude Code",
      expiresAt: 0,
    },
  ]);
});

test("an unknown Anthropic-compatible endpoint is not reported as New API", async () => {
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://proxy.example/v1",
      token: "sk-proxy-test",
    }),
    request: async () => ({ success: true, data: { service: "proxy" } }),
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
  });

  const report = await usage.query();

  assert.deepEqual(report, {
    version: 1,
    providerId: null,
    providerName: "当前提供商",
    status: "unsupported",
    resources: [],
    fetchedAt: "2026-08-11T08:00:00.000Z",
    stale: false,
  });
});

test("changing the CC provider bypasses the previous provider cache", async () => {
  let activeConfig = config;
  const responses = [
    response,
    {
      success: true,
      data: {
        system_name: "星河 API",
        quota_per_unit: 500_000,
        quota_display_type: "CNY",
        usd_exchange_rate: 7.2,
      },
    },
    {
      code: true,
      data: {
        object: "token_usage",
        name: "Claude Code",
        total_granted: 5_000_000,
        total_used: 1_250_000,
        total_available: 3_750_000,
        unlimited_quota: false,
        expires_at: 0,
      },
    },
  ];
  const usage = createProviderUsageModule({
    readConfig: () => activeConfig,
    request: async () => responses.shift(),
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
    ttlMs: 60_000,
  });

  const deepSeekReport = await usage.query();
  activeConfig = {
    baseUrl: "https://new-api.example/v1",
    token: "sk-new-api-test",
  };
  const newApiReport = await usage.query();

  assert.equal(deepSeekReport.providerId, "deepseek");
  assert.equal(newApiReport.providerId, "new-api-compatible");
  assert.equal(newApiReport.providerName, "星河 API");
});

test("New API keeps the detected site name when its key is rejected", async () => {
  const responses = [
    {
      success: true,
      data: {
        system_name: "星河 API",
        quota_per_unit: 500_000,
        quota_display_type: "CNY",
        usd_exchange_rate: 7.2,
      },
    },
    Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
  ];
  const usage = createProviderUsageModule({
    readConfig: () => ({
      baseUrl: "https://new-api.example",
      token: "sk-expired",
    }),
    request: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    now: () => Date.parse("2026-08-11T08:00:00.000Z"),
  });

  const report = await usage.query();

  assert.equal(report.providerId, "new-api-compatible");
  assert.equal(report.providerName, "星河 API");
  assert.equal(report.status, "error");
  assert.equal(report.errorCode, "unauthorized");
});
