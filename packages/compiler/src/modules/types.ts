import type { Form } from "../parser/index.js";
import type { Diagnostic, SourceSpan } from "../diagnostics/index.js";

export type ModuleNamespace = "src" | "std" | "pkg";

export interface ModuleRoots {
  src: string;
  std?: string;
  /** Directory that contains installed packages. */
  pkg?: string;
  /**
   * Optional hook for resolving a package name to an absolute path. If
   * provided it takes precedence over `pkg`.
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
