import type { Form } from "../parser/index.js";
import type { Diagnostic, SourceSpan } from "../diagnostics/index.js";

export type ModuleNamespace = "src" | "std" | "pkg";

export interface ModuleRoots {
  src: string;
  std?: string;
  /**
   * Legacy package search directory that contains installed packages.
   * Prefer `pkgDirs` for new callers.
   */
  pkg?: string;
  /**
   * Additional directories that contain installed packages. Packages are
   * discovered at `<pkgDir>/<packageName>/src`.
   */
  pkgDirs?: readonly string[];
  /**
   * Optional hook for resolving a package name to an absolute path. If
   * provided it takes precedence over `pkg` and `pkgDirs`.
   * The returned path can point to either the package directory
   * (`.../<packageName>`) or directly to the package source directory
   * (`.../<packageName>/src`).
   */
  resolvePackageRoot?: (packageName: string) => string | undefined | Promise<string | undefined>;
}

export interface ModulePath {
  namespace: ModuleNamespace;
  segments: readonly string[];
  /**
   * Present only for `pkg` modules. Represents the top-level package name that
   * owns the module path.
   */
  packageName?: string;
}

export interface ModulePathAdapter {
  resolve(path: string): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
  normalize?: (path: string) => string;
}

export type ModuleOrigin =
  | { kind: "file"; filePath: string }
  | { kind: "inline"; parentId: string; name: string; span?: SourceSpan };

export type ModuleDependencyKind = "use" | "export";

export interface ModuleDependency {
  kind: ModuleDependencyKind;
  path: ModulePath;
  span?: SourceSpan;
}

export interface ModuleNode {
  /** Stable identifier; file-backed modules use their absolute file path. */
  id: string;
  path: ModulePath;
  origin: ModuleOrigin;
  ast: Form;
  source: string;
  dependencies: readonly ModuleDependency[];
  /**
   * Functional macro names exported from this module after macro-expansion.
   * Includes local `pub macro` exports and `pub use` re-exports.
   */
  macroExports?: readonly string[];
}

export interface ModuleDiagnostic {
  kind: "missing-module" | "io-error";
  message: string;
  requested: ModulePath;
  importer?: string;
  span?: SourceSpan;
}

export interface ModuleGraph {
  entry: string;
  modules: Map<string, ModuleNode>;
  diagnostics: readonly Diagnostic[];
}

export interface ModuleHost {
  path: ModulePathAdapter;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<readonly string[]>;
  fileExists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
}
