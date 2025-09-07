import type { ParsedFiles } from "./parse-directory.js";
import { parse } from "../parser.js";

// Runtime env detection without relying on DOM types
const isBrowser = () =>
  typeof (globalThis as any).process?.versions?.node === "undefined";

// Compute stdPath per environment:
// - Node: absolute filesystem path to std directory
// - Browser: symbolic "std" prefix (module registration will treat it as std root)
export const stdPath: string = isBrowser()
  ? "std"
  : decodeURIComponent(
      // The std path is only used at runtime in Node.
      // Vite warns about non-existent paths at build-time; suppress transformation.
      new URL(/* @vite-ignore */ "../../../std/", import.meta.url).pathname
    ).replace(/\/$/, "");

let cache: ParsedFiles | undefined = undefined;
export const parseStd = async () => {
  if (cache) {
    return cloneParsedFiles(cache);
  }

  // Browser path: load and parse embedded std sources via Vite's import.meta.glob
  if (isBrowser()) {
    const hasGlob = typeof (import.meta as any).glob === "function";
    let files: Record<string, string> = {};

    if (hasGlob) {
      // Preferred (build-time transformed) path
      files = import.meta.glob("../../../std/**/*.voyd", {
        eager: true,
        query: "?raw",
        import: "default",
      }) as Record<string, string>;
    } else {
      // Fallback for environments that don't transform import.meta.glob in linked deps
      // We import a module that statically imports all std files with ?raw.
      const mod = (await import("./std-raw.js")) as {
        stdRaw?: Record<string, string>;
      };
      files = (mod.stdRaw ?? {}) as Record<string, string>;
    }

    const parsed: ParsedFiles = {};
    for (const [key, source] of Object.entries(files)) {
      const stdKey = key.replace(/^.*?std\//, "std/");
      parsed[stdKey] = parse(source, stdKey);
    }

    cache = cloneParsedFiles(parsed);
    return parsed;
  }

  // Node path: read std from filesystem (lazy import to avoid bundling in browser)
  const { parseDirectory } = await import("./parse-" + "directory.js");
  const parsedFs = await parseDirectory(stdPath);
  cache = cloneParsedFiles(parsedFs);
  return parsedFs;
};

const cloneParsedFiles = (parsed: ParsedFiles) =>
  Object.entries(parsed).reduce(
    (acc, [key, value]) => ({ ...acc, [key]: value.clone() }),
    {} as ParsedFiles
  );

// Convert the object
