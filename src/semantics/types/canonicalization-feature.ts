let override: boolean | undefined;

const truthy = new Set(["1", "true", "on", "enabled", "enable", "yes"]);
const falsy = new Set(["0", "false", "off", "disabled", "disable", "no"]);

const parseEnvFlag = (value: string | undefined): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return undefined;
};

export const isCanonicalizationEnabled = (): boolean => {
  if (override !== undefined) return override;
  const envValue =
    parseEnvFlag(process.env.VOYD_CANONICAL_TYPES) ??
    parseEnvFlag(process.env.VOYD_ENABLE_CANONICAL_TYPES);
  return envValue ?? false;
};

export const setCanonicalizationOverride = (
  value: boolean | undefined
): void => {
  override = value;
};

export const withCanonicalization = async <T>(
  enabled: boolean,
  handler: () => T | Promise<T>
): Promise<T> => {
  const previous = override;
  const prevPrimary = process.env.VOYD_CANONICAL_TYPES;
  const prevSecondary = process.env.VOYD_ENABLE_CANONICAL_TYPES;
  const flagValue = enabled ? "1" : "0";
  override = enabled;
  process.env.VOYD_CANONICAL_TYPES = flagValue;
  process.env.VOYD_ENABLE_CANONICAL_TYPES = flagValue;
  try {
    return await handler();
  } finally {
    if (prevPrimary === undefined) delete process.env.VOYD_CANONICAL_TYPES;
    else process.env.VOYD_CANONICAL_TYPES = prevPrimary;
    if (prevSecondary === undefined)
      delete process.env.VOYD_ENABLE_CANONICAL_TYPES;
    else process.env.VOYD_ENABLE_CANONICAL_TYPES = prevSecondary;
    override = previous;
  }
};
