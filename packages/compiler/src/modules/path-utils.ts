type ParsedPath = {
  root: string;
  segments: string[];
};

const normalizeSlashes = (value: string): string => value.replace(/\\/g, "/");

const splitSegments = (value: string): string[] =>
  value.split("/").filter(Boolean);

const parsePath = (value: string): ParsedPath => {
  const normalized = normalizeSlashes(value);
  if (!normalized) return { root: "", segments: [] };

  const driveMatch = normalized.match(/^([A-Za-z]:)(\/|$)/);
  if (driveMatch) {
    const rest = normalized.slice(driveMatch[0].length);
    return { root: `${driveMatch[1]}/`, segments: splitSegments(rest) };
  }

  if (normalized.startsWith("//")) {
    const rest = normalized.slice(2);
    return { root: "//", segments: splitSegments(rest) };
  }

  if (normalized.startsWith("/")) {
    const rest = normalized.slice(1);
    return { root: "/", segments: splitSegments(rest) };
  }

  return { root: "", segments: splitSegments(normalized) };
};

const normalizeSegments = (
  segments: readonly string[],
  allowAboveRoot: boolean
): string[] => {
  const normalized: string[] = [];

  segments.forEach((segment) => {
    if (!segment || segment === ".") return;
    if (segment === "..") {
      const canPop =
        normalized.length > 0 && normalized[normalized.length - 1] !== "..";
      if (canPop) {
        normalized.pop();
        return;
      }
      if (allowAboveRoot) {
        normalized.push("..");
      }
      return;
    }
    normalized.push(segment);
  });

  return normalized;
};

const formatPath = ({ root, segments }: ParsedPath): string => {
  const body = segments.join("/");
  if (!root) return body;
  return body ? `${root}${body}` : root;
};

export const normalizePath = (value: string): string => {
  if (!value) return "";
  const parsed = parsePath(value);
  const normalized = normalizeSegments(parsed.segments, parsed.root === "");
  return formatPath({ root: parsed.root, segments: normalized });
};

export const isAbsolutePath = (value: string): boolean =>
  Boolean(parsePath(value).root);

export const resolvePath = (value: string): string => {
  if (!value) return "/";
  const normalized = normalizePath(value);
  if (isAbsolutePath(normalized)) return normalized;
  return normalizePath(`/${normalized}`);
};

export const joinPath = (...parts: string[]): string => {
  if (parts.length === 0) return "";

  const initial = { root: "", segments: [] as string[] };
  const combined = parts.reduce((acc, part) => {
    if (!part) return acc;
    const parsed = parsePath(part);
    const segments = [...acc.segments, ...parsed.segments];
    if (parsed.root) {
      return { root: parsed.root, segments: parsed.segments };
    }
    return { root: acc.root, segments };
  }, initial);

  const normalized = normalizeSegments(
    combined.segments,
    combined.root === ""
  );
  return formatPath({ root: combined.root, segments: normalized });
};

export const relativePath = (from: string, to: string): string => {
  const fromParsed = parsePath(from);
  const toParsed = parsePath(to);

  if (fromParsed.root !== toParsed.root) {
    return normalizePath(to);
  }

  const fromSegments = normalizeSegments(fromParsed.segments, false);
  const toSegments = normalizeSegments(toParsed.segments, false);
  const min = Math.min(fromSegments.length, toSegments.length);

  let shared = 0;
  while (shared < min && fromSegments[shared] === toSegments[shared]) {
    shared += 1;
  }

  const up = Array.from({ length: fromSegments.length - shared }, () => "..");
  const down = toSegments.slice(shared);
  return [...up, ...down].join("/");
};

export const basename = (value: string, ext = ""): string => {
  const parsed = parsePath(value);
  const last = parsed.segments.at(-1) ?? "";
  if (!ext || !last.endsWith(ext)) return last;
  return last.slice(0, -ext.length);
};

export const dirname = (value: string): string => {
  const parsed = parsePath(value);
  if (parsed.segments.length === 0) return parsed.root || ".";
  const segments = parsed.segments.slice(0, -1);
  const dir = formatPath({ root: parsed.root, segments });
  return dir || (parsed.root ? parsed.root : ".");
};
