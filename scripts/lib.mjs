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
