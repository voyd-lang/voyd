import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  analyzeProject,
  autoImportActions,
  definitionsAtPosition,
  hoverAtPosition,
  renameAtPosition,
  resolveModuleRoots,
  toFileUri,
} from "../project.js";

const createProject = async (
  files: Record<string, string>,
): Promise<{ rootDir: string; filePathFor: (relativePath: string) => string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-test-"));

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const fullPath = path.join(rootDir, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents, "utf8");
    }),
  );

  return {
    rootDir,
    filePathFor: (relativePath: string) => path.join(rootDir, relativePath),
  };
};

const applyEditToSource = ({
  uri,
  source,
  version,
  text,
}: {
  uri: string;
  source: string;
  version: number;
  text: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  };
}): string => {
  const document = TextDocument.create(uri, "voyd", version, source);
  return TextDocument.applyEdits(document, [text]);
};

describe("language server project analysis", () => {
  it("uses VOYD_STD_ROOT when provided", () => {
    const previousStdRoot = process.env.VOYD_STD_ROOT;
    const stdRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "std",
      "src",
    );
    process.env.VOYD_STD_ROOT = stdRoot;

    try {
      const roots = resolveModuleRoots(path.join(os.tmpdir(), "voyd-main.voyd"));
      expect(roots.std).toBe(stdRoot);
    } finally {
      if (previousStdRoot === undefined) {
        delete process.env.VOYD_STD_ROOT;
      } else {
        process.env.VOYD_STD_ROOT = previousStdRoot;
      }
    }
  });

  it("resolves go-to-definition for imported functions", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::util::helper\n\nfn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const definitions = definitionsAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 3, character: 3 },
      });

      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.uri).toBe(toFileUri(project.filePathFor("src/util.voyd")));
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("treats symbol ranges as end-exclusive for navigation", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::util::helper\n\nfn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const definitions = definitionsAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 3, character: 8 },
      });

      expect(definitions).toHaveLength(0);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("renames local variables and references", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  let counter = 1\n  counter\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const edit = renameAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 2, character: 3 },
        newName: "total",
      });

      const changes = edit?.changes?.[toFileUri(entryPath)] ?? [];
      expect(changes.length).toBeGreaterThanOrEqual(2);
      expect(changes.every((change: { newText: string }) => change.newText === "total")).toBe(
        true,
      );
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("renames imported symbols in use statements and call sites", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::util::helper\n\nfn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const utilPath = project.filePathFor("src/util.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const edit = renameAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 3, character: 3 },
        newName: "assist",
      });

      const mainChanges = edit?.changes?.[toFileUri(entryPath)] ?? [];
      const utilChanges = edit?.changes?.[toFileUri(utilPath)] ?? [];
      expect(mainChanges.some((change) => change.range.start.line === 0)).toBe(true);
      expect(mainChanges.some((change) => change.range.start.line === 3)).toBe(true);
      expect(utilChanges.some((change) => change.range.start.line === 0)).toBe(true);
      expect(
        [...mainChanges, ...utilChanges].every(
          (change: { newText: string }) => change.newText === "assist",
        ),
      ).toBe(true);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("offers auto-import quick fixes for unknown functions", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(uri) ?? [];
      const codeActions = autoImportActions({
        analysis,
        documentUri: uri,
        diagnostics,
      });

      expect(
        codeActions.some((action) =>
          action.title.includes("Import helper from src::util"),
        ),
      ).toBe(true);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("resolves src root for nested source package entries", async () => {
    const project = await createProject({
      "main.voyd": `fn main() -> i32\n  0\n`,
      "src/pkg.voyd": `pub use self::pkgs`,
      "src/pkgs/vtrace/pkg.voyd": `pub use self::color`,
      "src/pkgs/vtrace/color.voyd": `pub fn shade() -> i32\n  0\n`,
    });

    try {
      const entryPath = project.filePathFor("src/pkgs/vtrace/pkg.voyd");
      const roots = resolveModuleRoots(entryPath);
      expect(roots.src).toBe(project.filePathFor("src"));
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("does not force src-root to a parent src directory without project entry files", async () => {
    const project = await createProject({
      "main.voyd": `fn main() -> i32\n  0\n`,
      "src/my_app/main.voyd": `fn main() -> i32\n  1\n`,
    });

    try {
      const entryPath = project.filePathFor("src/my_app/main.voyd");
      const roots = resolveModuleRoots(entryPath);
      expect(roots.src).toBe(project.filePathFor("src/my_app"));
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("resolves src root for nested source packages without src pkg/main entries", async () => {
    const project = await createProject({
      "main.voyd": `fn main() -> i32\n  0\n`,
      "src/util.voyd": `fn helper() -> i32\n  1\n`,
      "src/pkgs/vtrace/pkg.voyd": `use src::util`,
    });

    try {
      const entryPath = project.filePathFor("src/pkgs/vtrace/pkg.voyd");
      const roots = resolveModuleRoots(entryPath);
      expect(roots.src).toBe(project.filePathFor("src"));

      const analysis = await analyzeProject({
        entryPath,
        roots,
        openDocuments: new Map(),
      });
      expect(analysis.graph.modules.has("src::util")).toBe(true);
      const diagnostics = analysis.diagnosticsByUri.get(toFileUri(entryPath)) ?? [];
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.message.includes("Unable to resolve module src::util") ||
            diagnostic.message.includes("Module src::util is not available for import"),
        ),
      ).toBe(false);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("inserts auto-imports after grouped use statements in nested source packages", async () => {
    const project = await createProject({
      "src/pkg.voyd": `pub use self::pkgs`,
      "src/pkgs.voyd": `pub use self::vtrace`,
      "src/pkgs/vtrace/pkg.voyd": `pub use self::color\npub use self::io`,
      "src/pkgs/vtrace/color.voyd":
        `use super::io::{ write_line, write, StdErr }\n\npub fn shade() -> i32\n  vec3()\n`,
      "src/pkgs/vtrace/io.voyd":
        `pub fn write_line() -> i32\n  0\n\npub fn write() -> i32\n  0\n\npub obj StdErr {}\n`,
      "src/vec3.voyd": `pub fn vec3() -> i32\n  0\n`,
    });

    try {
      const entryPath = project.filePathFor("src/pkgs/vtrace/pkg.voyd");
      const colorPath = project.filePathFor("src/pkgs/vtrace/color.voyd");
      const uri = toFileUri(colorPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(uri) ?? [];
      const codeActions = autoImportActions({
        analysis,
        documentUri: uri,
        diagnostics,
      });

      const actionTitles = codeActions.map((action) => action.title);
      expect(actionTitles).toContain("Import vec3 from src::vec3");
      const vec3Action = codeActions.find((action) =>
        action.title.includes("Import vec3 from src::vec3"),
      );
      if (!vec3Action) {
        return;
      }

      const edit = vec3Action.edit?.changes?.[uri]?.[0];
      expect(edit).toBeDefined();
      if (!edit) {
        return;
      }

      const updated = applyEditToSource({
        uri,
        source:
          `use super::io::{ write_line, write, StdErr }\n\npub fn shade() -> i32\n  vec3()\n`,
        version: 1,
        text: edit,
      });

      expect(updated).toContain(
        "use super::io::{ write_line, write, StdErr }\nuse src::vec3::vec3\n\n",
      );
      expect(updated).not.toContain("StdErr\nuse src::vec3::vec3}");
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("surfaces typing diagnostics when generics miss return annotations", async () => {
    const project = await createProject({
      "src/main.voyd": `fn identity<T>(value: T)\n  value\n\nfn main() -> i32\n  let counter = 1\n  counter\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(uri) ?? [];
      expect(diagnostics.some((diagnostic) => diagnostic.code === "TY0034")).toBe(true);

      const rename = renameAtPosition({
        analysis,
        uri,
        position: { line: 5, character: 3 },
        newName: "total",
      });
      const changes = rename?.changes?.[uri] ?? [];
      expect(changes.length).toBeGreaterThanOrEqual(2);
      expect(changes.every((change) => change.newText === "total")).toBe(true);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("returns module diagnostics for malformed html syntax instead of throwing", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  <div class="open"\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(uri) ?? [];
      const diagnostic = diagnostics.find((entry) => entry.code === "MD0002");
      expect(diagnostic).toBeDefined();
      if (!diagnostic) {
        return;
      }

      expect(
        diagnostic.message.includes("Failed to parse"),
      ).toBe(true);
      expect(diagnostic.range.start.line).toBeGreaterThan(0);
      expect(diagnostic.range.end.line).toBeGreaterThanOrEqual(
        diagnostic.range.start.line,
      );
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("does not emit false unresolved-import diagnostics for std src aliases", async () => {
    const project = await createProject({
      "std/msgpack.voyd": `use src::msgpack::fns::marker\n\npub fn top() -> i32\n  marker()\n`,
      "std/msgpack/fns.voyd": `use std::fixed_array::fns::hidden\n\npub fn marker() -> i32\n  hidden()\n`,
      "std/fixed_array/fns.voyd": `pub fn hidden() -> i32\n  1\n`,
    });

    try {
      const entryPath = project.filePathFor("std/msgpack.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: {
          src: project.filePathFor("std"),
          std: project.filePathFor("std"),
        },
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(toFileUri(entryPath)) ?? [];
      expect(diagnostics).toHaveLength(0);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("returns markdown hover docs for documented symbols", async () => {
    const project = await createProject({
      "src/main.voyd": `/// Adds two numbers.\nfn add(\n  /// Left operand.\n  left: i32,\n  /// Right operand.\n  right: i32\n) -> i32\n  left + right\n\nfn main() -> i32\n  add(1, 2)\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const fnHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 10, character: 3 },
      });
      expect(fnHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nfn add(left: i32, right: i32) -> i32\n```\n\n Adds two numbers.",
      });

      const paramHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 7, character: 3 },
      });
      expect(paramHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nleft: i32\n```\n\n Left operand.",
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("returns docs for symbols declared in modules named label", async () => {
    const project = await createProject({
      "src/label.voyd": `/// Label module docs.\npub fn tagged() -> i32\n  1\n`,
      "src/main.voyd": `use src::label::all\n\nfn main() -> i32\n  tagged()\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const hover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 3, character: 3 },
      });
      expect(hover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nfn tagged() -> i32\n```\n\n Label module docs.",
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("returns inferred types for locals and generic functions", async () => {
    const project = await createProject({
      "src/main.voyd": `fn identity<T>(value: T) -> T\n  let copy = value\n  copy\n\nfn main() -> i32\n  let number = identity(42)\n  number\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const functionHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 5, character: 15 },
      });
      expect(functionHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nfn identity<T>(value: T) -> T\n```",
      });

      const localHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 6, character: 3 },
      });
      expect(localHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nnumber: i32\n```",
      });

      const genericLocalHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 2, character: 3 },
      });
      expect(genericLocalHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\ncopy: i32\n```",
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("renders optional params with source-level ? syntax in function hovers", async () => {
    const project = await createProject({
      "src/main.voyd": `fn work(id: i32, middle?: i32) -> i32\n  id\n\nfn main() -> i32\n  work(1)\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const hover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 4, character: 3 },
      });
      expect(hover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nfn work(id: i32, middle?: i32) -> i32\n```",
      });

      const optionalParamHover = hoverAtPosition({
        analysis,
        uri,
        position: { line: 0, character: 18 },
      });
      expect(optionalParamHover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nmiddle?: i32\n```",
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("uses external labels for label hover type summaries", async () => {
    const source = `fn reduce<T>(value: T, { start: T, reducer cb: (acc: T, current: T) -> T }) -> T\n  cb(start, value)\n\nfn main() -> i32\n  1.reduce start: 0 reducer: (acc, current) =>\n    acc + current\n`;
    const project = await createProject({
      "src/main.voyd": source,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const lines = source.split("\n");
      const callLine = lines.findIndex((line) => line.includes("reducer:"));
      const callChar = lines[callLine]?.indexOf("reducer") ?? -1;
      expect(callLine).toBeGreaterThanOrEqual(0);
      expect(callChar).toBeGreaterThanOrEqual(0);

      const hover = hoverAtPosition({
        analysis,
        uri,
        position: { line: callLine, character: callChar + 1 },
      });
      expect(hover?.contents).toEqual({
        kind: "markdown",
        value: "```voyd\nreducer: (T, T) -> T ! open effect row\n```",
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it(
    "renames labeled parameters, including external labels",
    async () => {
      const source = `use std::all\n\nfn reduce<T>(value: T, { start: T, reducer cb: (acc: T, current: T) -> T }) -> T\n  cb(start, value)\n\nfn main() -> i32\n  1.reduce start: 0 reducer: (acc, current) =>\n    acc + current\n`;
      const project = await createProject({
        "src/main.voyd": source,
      });

      try {
        const entryPath = project.filePathFor("src/main.voyd");
        const uri = toFileUri(entryPath);
        const analysis = await analyzeProject({
          entryPath,
          roots: resolveModuleRoots(entryPath),
          openDocuments: new Map(),
        });
        const lines = source.split("\n");
        const callLine = lines.findIndex((line) => line.includes("reducer:"));
        const callChar = lines[callLine]?.indexOf("reducer") ?? -1;
        const reducerDeclLine = lines.findIndex((line) => line.includes("reducer cb"));
        const startBodyLine = lines.findIndex((line) => line.includes("cb(start, value)"));
        expect(callLine).toBeGreaterThanOrEqual(0);
        expect(callChar).toBeGreaterThanOrEqual(0);
        expect(reducerDeclLine).toBeGreaterThanOrEqual(0);
        expect(startBodyLine).toBeGreaterThanOrEqual(0);

        const externalLabelRename = renameAtPosition({
          analysis,
          uri,
          position: { line: callLine, character: callChar + 1 },
          newName: "combine",
        });
        const externalLabelChanges = externalLabelRename?.changes?.[uri] ?? [];
        expect(
          externalLabelChanges.some((change) => change.range.start.line === reducerDeclLine),
        ).toBe(true);
        expect(externalLabelChanges.some((change) => change.range.start.line === callLine)).toBe(
          true,
        );
        expect(externalLabelChanges.every((change) => change.newText === "combine")).toBe(true);

        const startCallChar = lines[callLine]?.indexOf("start") ?? -1;
        expect(startCallChar).toBeGreaterThanOrEqual(0);
        const startRename = renameAtPosition({
          analysis,
          uri,
          position: { line: callLine, character: startCallChar + 1 },
          newName: "initial",
        });
        const startChanges = startRename?.changes?.[uri] ?? [];
        expect(startChanges.some((change) => change.range.start.line === reducerDeclLine)).toBe(
          true,
        );
        expect(startChanges.some((change) => change.range.start.line === startBodyLine)).toBe(
          true,
        );
        expect(startChanges.some((change) => change.range.start.line === callLine)).toBe(true);
        expect(startChanges.every((change) => change.newText === "initial")).toBe(true);
      } finally {
        await rm(project.rootDir, { recursive: true, force: true });
      }
    },
    15000,
  );
});
