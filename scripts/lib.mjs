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
    "let o=e.sessions.value,r=i.value,s=to(()=>{let k=new Set(o.map((D)=>D.sessionId.value));return r.filter((D)=>!k.has(D.sessionId))",
    "let o=e.sessions.value,r=i.value,s=to(()=>{let k=new Set([...o.map((D)=>D.sessionId.value),...e.locallyDeletedSessionIds]);return r.filter((D)=>!k.has(D.sessionId))",
    1,
    "session deletion synthetic state guard",
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
