export function countOccurrences(source, needle) {
  if (!needle) throw new Error("needle must not be empty");
  return source.split(needle).length - 1;
}

export function replaceExact(
  source,
  needle,
  replacement,
  expectedCount,
  label,
) {
  const actualCount = countOccurrences(source, needle);
  if (actualCount !== expectedCount) {
    throw new Error(
      `${label}: expected ${expectedCount} match(es), found ${actualCount}`,
    );
  }
  return source.split(needle).join(replacement);
}

export function buildCopyMarkdownSnippet(source) {
  const successIcon =
    'function CodexCopySuccessIcon(e){return b("svg",{width:16,height:16,viewBox:"0 0 16 16",fill:"none","aria-hidden":!0,...e,children:b("path",{d:"M3.5 8.25 6.5 11l6-6",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round"})})}';
  const withOwnedSuccessIcon = replaceExact(
    source,
    "function CodexCopyMarkdownButton",
    `${successIcon}function CodexCopyMarkdownButton`,
    1,
    "copy Markdown success icon",
  );
  return replaceExact(
    withOwnedSuccessIcon,
    "b(tb,{size:14})",
    'b(CodexCopySuccessIcon,{className:"codexCopyMarkdownIcon"})',
    1,
    "copy Markdown success state",
  );
}

export function discoverReactHookBindings(source) {
  const discover = (pattern, label) => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(`${label}: expected 1 match, found ${matches.length}`);
    }
    return matches[0][1];
  };
  return {
    useState: discover(
      /([A-Za-z_$][\w$]*)=function\(e\)\{return [A-Za-z_$][\w$]*\.current\.useState\(e\)\}/g,
      "React useState binding",
    ),
    useEffect: discover(
      /([A-Za-z_$][\w$]*)=function\(e,t\)\{return [A-Za-z_$][\w$]*\.current\.useEffect\(e,t\)\}/g,
      "React useEffect binding",
    ),
  };
}

export function bindOwnedReactHooks(source, { useState }) {
  return replaceExact(
    source,
    "ie(!1)",
    `${useState}(!1)`,
    1,
    "owned React useState binding",
  );
}

export function verifyOwnedReactRuntimeBindings(source) {
  const hooks = discoverReactHookBindings(source);
  const stateCalls = [
    ...source.matchAll(
      /function Codex(?:CopyMarkdownButton|ForkAnswerButton)\([^]*?let\[[^\]]+\]=([A-Za-z_$][\w$]*)\(!1\)/g,
    ),
  ].map((match) => match[1]);
  if (
    stateCalls.length !== 2 ||
    stateCalls.some((binding) => binding !== hooks.useState)
  ) {
    throw new Error(
      `owned components call ${stateCalls.join(", ") || "no state hook"}, vendor useState is ${hooks.useState}`,
    );
  }

  const providerCwd = source.indexOf("ClaudeCodexProviderUsage?.setCwd");
  if (providerCwd < 0) throw new Error("provider cwd effect is missing");
  const providerPrefix = source.slice(providerCwd - 180, providerCwd);
  const effectCall = providerPrefix.match(
    /([A-Za-z_$][\w$]*)\(\(\)=>\{window\.__claudeCodexProviderUsageCwd=/,
  )?.[1];
  if (effectCall !== hooks.useEffect) {
    throw new Error(
      `provider cwd calls ${effectCall || "no effect hook"}, vendor useEffect is ${hooks.useEffect}`,
    );
  }

  if (!/\bb=([A-Za-z_$][\w$]*),I=\1;/.test(source)) {
    throw new Error("owned JSX bindings b/I are not the vendor JSX factory aliases");
  }
  return hooks;
}

export function patchSessionDeletionState(source) {
  let patched = replaceExact(
    source,
    "listSessionsPromise;lastLocalRenameAt=new Map;",
    "listSessionsPromise;locallyDeletedSessionIds=new Set;lastLocalRenameAt=new Map;",
    1,
    "session deletion local state",
  );
  patched = replaceExact(
    patched,
    'async deleteSession(e){if(this.sessions.value=this.sessions.value.filter((i)=>i!==e),this.activeSession.value===e){if(this.activeSession.value=this.sessions.value[0],!this.activeSession.value)this.createSession()}let t=e.sessionId.value;if(t)await(await this.getConnection()).deleteSession(t)}',
    'async deleteSession(e){let t=e.sessionId.value;if(t)this.locallyDeletedSessionIds.add(t);if(this.sessions.value=this.sessions.value.filter((i)=>i!==e&&(!t||i.sessionId.value!==t)),this.activeSession.value===e){if(this.activeSession.value=this.sessions.value[0],!this.activeSession.value)this.createSession()}if(t)try{await(await this.getConnection()).deleteSession(t)}catch(i){this.locallyDeletedSessionIds.delete(t),await this.listSessions();throw i}}',
    1,
    "session deletion optimistic hide",
  );
  patched = replaceExact(
    patched,
    "for(let a of i.sessions){if(!a.isCurrentWorkspace)continue;let l=o.find",
    "for(let a of i.sessions){if(!a.isCurrentWorkspace||this.locallyDeletedSessionIds.has(a.id))continue;let l=o.find",
    1,
    "session deletion in-flight list guard",
  );
  return replaceExact(
    patched,
    "let r=e.sessions.value,s=i.value,a=Jn(()=>{let R=new Set(r.map((N)=>N.sessionId.value));return s.filter((N)=>!R.has(N.sessionId))",
    "let r=e.sessions.value,s=i.value,a=Jn(()=>{let R=new Set([...r.map((N)=>N.sessionId.value),...e.locallyDeletedSessionIds]);return s.filter((N)=>!R.has(N.sessionId))",
    1,
    "session deletion synthetic state guard",
  );
}

export function patchThinkingDurationState(source) {
  return replaceExact(
    source,
    "get durationMillis(){if(!this.startTime)return null;if(this.endTime)return this.endTime-this.startTime;return Date.now()-this.startTime}",
    "get durationMillis(){if(!this.startTime)return null;if(this.endTime)return this.endTime-this.startTime;if(!this.partial)return Math.max(0,this.lastModifiedTime-this.startTime);return Date.now()-this.startTime}",
    1,
    "thinking final duration freeze",
  );
}

export function shouldQuery({
  lastCheckedAt,
  now = Date.now(),
  intervalMs,
  force = false,
}) {
  if (force) return true;
  const previous = Date.parse(lastCheckedAt || "");
  return !Number.isFinite(previous) || now - previous >= intervalMs;
}

export function compareNumericVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) throw new Error(`invalid numeric version: ${value}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function selectMarketplaceVersion(payload, targetPlatform) {
  const extension = payload?.results?.[0]?.extensions?.[0];
  if (!extension) throw new Error("Marketplace response contained no extension");
  const version = extension.versions?.find(
    (candidate) => candidate.targetPlatform === targetPlatform,
  );
  if (!version?.version || !version?.fallbackAssetUri) {
    throw new Error(
      `Marketplace response contained no ${targetPlatform} package`,
    );
  }
  return {
    extensionId: `${extension.publisher?.publisherName}.${extension.extensionName}`,
    version: version.version,
    targetPlatform,
    lastUpdated: version.lastUpdated || null,
    downloadUrl: `${version.fallbackAssetUri}/Microsoft.VisualStudio.Services.VSIXPackage`,
  };
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(name, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.set(name, argv[++index]);
    } else {
      values.set(name, true);
    }
  }
  return values;
}
