import { describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "../../../../");
const tsxPath = resolve(repoRoot, "node_modules/.bin/tsx");
const distCliPath = resolve(repoRoot, "apps/cli/dist/cli-dev.js");
const CLI_E2E_TIMEOUT_MS = 60_000;
const cliE2eRuntime = process.env.VOYD_CLI_E2E_RUNTIME === "dist"
  ? "dist"
  : "source";

const writePackageFixture = async (packageSrcRoot: string): Promise<void> => {
  await mkdir(packageSrcRoot, { recursive: true });
  await writeFile(
    resolve(packageSrcRoot, "pkg.voyd"),
    [
      "pub use src::math::plus_one",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(packageSrcRoot, "math.voyd"),
    [
      "pub fn plus_one(value: i32) -> i32",
      "  value + 1",
      "",
    ].join("\n"),
  );
};

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-e2e-"));
  const testRoot = resolve(root, "test");
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    resolve(testRoot, "default-root.voyd"),
    [
      "use std::test::assertions::all",
      "",
      "test \"default test root\":",
      "  assert(true)",
      "",
    ].join("\n")
  );
  return root;
};

const createNodeModulesFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-node-modules-"));
  const srcRoot = resolve(root, "src");
  const packageSrcRoot = resolve(root, "node_modules", "my_pkg", "src");
  await mkdir(srcRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);

  await writeFile(
    resolve(srcRoot, "main.voyd"),
    [
      "use pkg::my_pkg::all",
      "",
      "pub fn main() -> i32",
      "  plus_one(41)",
      "",
    ].join("\n")
  );
  return root;
};

const createNodeModulesTestFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-test-node-modules-"));
  const testRoot = resolve(root, "test");
  const packageSrcRoot = resolve(root, "node_modules", "my_pkg", "src");
  await mkdir(testRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);

  await writeFile(
    resolve(testRoot, "uses_pkg.voyd"),
    [
      "use std::test::assertions::all",
      "use pkg::my_pkg::all",
      "",
      "test \"imports package in voyd test\":",
      "  assert(plus_one(1) == 2)",
      "",
    ].join("\n"),
  );
  return root;
};

const createAncestorNodeModulesFixture = async (): Promise<{
  cwd: string;
  entryPath: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-ancestor-node-modules-"));
  const srcRoot = resolve(root, "workspace", "apps", "consumer", "src");
  const packageSrcRoot = resolve(root, "workspace", "node_modules", "my_pkg", "src");
  const entryPath = resolve(srcRoot, "main.voyd");
  await mkdir(srcRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);
  await writeFile(
    entryPath,
    [
      "use pkg::my_pkg::all",
      "",
      "pub fn main() -> i32",
      "  plus_one(41)",
      "",
    ].join("\n"),
  );
  return { cwd: root, entryPath };
};

const createPkgDirRelativeFixture = async (): Promise<{
  cwd: string;
  entryPath: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-pkg-dir-relative-"));
  const srcRoot = resolve(root, "workspace", "apps", "consumer", "src");
  const packageSrcRoot = resolve(
    root,
    "workspace",
    "apps",
    "consumer",
    "pkgs",
    "my_pkg",
    "src",
  );
  const entryPath = resolve(srcRoot, "main.voyd");
  await mkdir(srcRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);
  await writeFile(
    entryPath,
    [
      "use pkg::my_pkg::all",
      "",
      "pub fn main() -> i32",
      "  plus_one(41)",
      "",
    ].join("\n"),
  );
  return { cwd: root, entryPath };
};

const createAncestorNodeModulesTestFixture = async (): Promise<{
  cwd: string;
  testRoot: string;
}> => {
  const root = await mkdtemp(
    resolve(tmpdir(), "voyd-cli-test-ancestor-node-modules-"),
  );
  const testRoot = resolve(root, "workspace", "apps", "consumer", "test");
  const packageSrcRoot = resolve(root, "workspace", "node_modules", "my_pkg", "src");
  await mkdir(testRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);
  await writeFile(
    resolve(testRoot, "uses_pkg.voyd"),
    [
      "use std::test::assertions::all",
      "use pkg::my_pkg::all",
      "",
      "test \"imports package in nested voyd test\":",
      "  assert(plus_one(1) == 2)",
      "",
    ].join("\n"),
  );
  return { cwd: root, testRoot };
};

const createPkgDirRelativeTestFixture = async (): Promise<{
  cwd: string;
  testRoot: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-test-pkg-dir-relative-"));
  const testRoot = resolve(root, "workspace", "apps", "consumer", "test");
  const packageSrcRoot = resolve(
    root,
    "workspace",
    "apps",
    "consumer",
    "pkgs",
    "my_pkg",
    "src",
  );
  await mkdir(testRoot, { recursive: true });
  await writePackageFixture(packageSrcRoot);
  await writeFile(
    resolve(testRoot, "uses_pkg.voyd"),
    [
      "use std::test::assertions::all",
      "use pkg::my_pkg::all",
      "",
      "test \"imports package from relative pkg-dir in voyd test\":",
      "  assert(plus_one(1) == 2)",
      "",
    ].join("\n"),
  );
  return { cwd: root, testRoot };
};

const createDocFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-docs-"));
  const srcRoot = resolve(root, "src");
  await mkdir(srcRoot, { recursive: true });
  await writeFile(
    resolve(srcRoot, "main.voyd"),
    [
      "//! Package docs.",
      "",
      "/// Adds values with **markdown**.",
      "/// This line should remain separate.",
      "pub fn add(",
      "  /// Left side.",
      "  /// Still left side.",
      "  left: i32,",
      "  /// Right side.",
      "  right: i32",
      ") -> i32",
      "  left + right",
      "",
      "/// Adds without arguments.",
      "pub fn add() -> i32",
      "  0",
      "",
      "/// Math helpers.",
      "pub mod math",
      "  /// Adds one.",
      "  pub fn plus_one(value: i32) -> i32",
      "    value + 1",
      "",
      "pub fn main() -> i32",
      "  add(1, 2)",
      "",
    ].join("\n"),
  );
  return root;
};

const createDanglingDocFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-docs-dangling-"));
  const srcRoot = resolve(root, "src");
  await mkdir(srcRoot, { recursive: true });
  await writeFile(
    resolve(srcRoot, "main.voyd"),
    [
      "/// I am lost.",
      "",
      "fn main() -> i32",
      "  1",
      "",
    ].join("\n"),
  );
  return root;
};

const createDiagnosticCompactionFixture = async (): Promise<{
  root: string;
  stdRoot: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-diagnostics-"));
  const srcRoot = resolve(root, "src");
  const stdRoot = resolve(root, "std");
  await mkdir(srcRoot, { recursive: true });
  await cp(resolve(repoRoot, "packages/std/src"), stdRoot, { recursive: true });

  await writeFile(
    resolve(srcRoot, "main.voyd"),
    [
      "use std::all",
      "",
      "pub fn main() -> i32",
      "  1",
      "",
    ].join("\n"),
  );

  const arrayPath = resolve(stdRoot, "array.voyd");
  const arraySource = await readFile(arrayPath, "utf8");
  await writeFile(
    arrayPath,
    arraySource.replace("pub obj Array<T> {", "pub obj Arrray<T> {"),
    "utf8",
  );

  return { root, stdRoot };
};

const sourceCliPath = resolve(repoRoot, "apps/cli/src/cli-dev.ts");

const assertCliRunnerAvailable = (): void => {
  if (cliE2eRuntime === "source" && !existsSync(tsxPath)) {
    throw new Error(`Missing tsx binary at ${tsxPath}`);
  }
  if (cliE2eRuntime === "dist" && !existsSync(distCliPath)) {
    throw new Error(
      `Missing built CLI entry at ${distCliPath}. Run npm run --workspace @voyd/cli build.`,
    );
  }
};

const runCli = (root: string, args: string[], env?: Record<string, string>) =>
  spawnSync(cliE2eRuntime === "source" ? tsxPath : process.execPath, [
    ...(cliE2eRuntime === "source"
      ? ["--conditions=development", sourceCliPath]
      : [distCliPath]),
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: CLI_E2E_TIMEOUT_MS,
  });

describe("voyd cli test discovery", { timeout: CLI_E2E_TIMEOUT_MS }, () => {
  it(
    "defaults test root to repo root when no path is provided",
    async () => {
      assertCliRunnerAvailable();

      const root = await createFixture();
      try {
        const result = runCli(root, ["test"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("voyd cli package resolution", { timeout: CLI_E2E_TIMEOUT_MS }, () => {
  it(
    "defaults package lookup to node_modules",
    async () => {
      assertCliRunnerAvailable();

      const root = await createNodeModulesFixture();
      try {
        const result = runCli(root, ["--emit-ir-ast"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd compile failed: ${output}`);
        }

        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "walks ancestor directories for node_modules relative to the entry path",
    async () => {
      assertCliRunnerAvailable();

      const fixture = await createAncestorNodeModulesFixture();
      try {
        const result = runCli(fixture.cwd, ["--emit-ir-ast", fixture.entryPath]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd compile failed: ${output}`);
        }

        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(fixture.cwd, { recursive: true, force: true });
      }
    },
  );

  it(
    "resolves --pkg-dir relative to the target source root",
    async () => {
      assertCliRunnerAvailable();

      const fixture = await createPkgDirRelativeFixture();
      try {
        const result = runCli(fixture.cwd, [
          "--emit-ir-ast",
          fixture.entryPath,
          "--pkg-dir",
          "../pkgs",
        ]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd compile failed: ${output}`);
        }

        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(fixture.cwd, { recursive: true, force: true });
      }
    },
  );

  it(
    "defaults voyd test package lookup to node_modules",
    async () => {
      assertCliRunnerAvailable();

      const root = await createNodeModulesTestFixture();
      try {
        const result = runCli(root, ["test"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "walks ancestor directories for node_modules in voyd test mode",
    async () => {
      assertCliRunnerAvailable();

      const fixture = await createAncestorNodeModulesTestFixture();
      try {
        const result = runCli(fixture.cwd, ["test", fixture.testRoot]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(fixture.cwd, { recursive: true, force: true });
      }
    },
    CLI_E2E_TIMEOUT_MS,
  );

  it(
    "resolves --pkg-dir relative to the test root",
    async () => {
      assertCliRunnerAvailable();

      const fixture = await createPkgDirRelativeTestFixture();
      try {
        const result = runCli(fixture.cwd, [
          "test",
          fixture.testRoot,
          "--pkg-dir",
          "../pkgs",
        ]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(fixture.cwd, { recursive: true, force: true });
      }
    },
  );
});

describe("voyd cli docs command", { timeout: CLI_E2E_TIMEOUT_MS }, () => {
  it("emits legible HTML docs with hierarchical navigation", async () => {
    assertCliRunnerAvailable();

    const root = await createDocFixture();
    try {
      const result = runCli(root, ["doc"]);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0) {
        throw new Error(`voyd doc failed: ${output}`);
      }

      const docsPath = resolve(root, "docs.html");
      const html = await readFile(docsPath, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("Docs Index");
      expect(html).toContain("Table of Contents");
      expect(html).toContain("id=\"module-src-main\"");
      expect(html).toContain("id=\"module-src-main-math\"");
      expect(html).toContain("<details>");
      expect(html).toContain("id=\"function-src-main-add\"");
      expect(html).toContain("id=\"function-src-main-add-1\"");
      expect(html).toContain("<strong>markdown</strong>");
      expect(html).toContain("Left side.<br />");
      expect(html).toContain("Still left side.</p>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports JSON documentation output", async () => {
    assertCliRunnerAvailable();

    const root = await createDocFixture();
    try {
      const result = runCli(root, ["doc", "--format", "json"]);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0) {
        throw new Error(`voyd doc --format json failed: ${output}`);
      }

      const docsPath = resolve(root, "docs.json");
      const json = JSON.parse(await readFile(docsPath, "utf8")) as {
        modules: Array<{
          id: string;
          functions: Array<{
            name: string;
            parameterDocs: Array<{ name: string; documentation: string }>;
          }>;
        }>;
      };
      const mainModule = json.modules.find((module) => module.id === "src::main");
      expect(mainModule).toBeDefined();
      const addFn = mainModule?.functions.find((fn) => fn.name === "add");
      expect(addFn).toBeDefined();
      const leftDoc = addFn?.parameterDocs.find((param) => param.name === "left");
      expect(leftDoc?.documentation).toBe(" Left side.\n Still left side.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails with diagnostics when doc comments are dangling", async () => {
    assertCliRunnerAvailable();

    const root = await createDanglingDocFixture();
    try {
      const result = runCli(root, ["doc"]);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("MD0004");
      expect(output).toContain("Dangling doc comment");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps --out off top-level help and scoped to doc help", async () => {
    assertCliRunnerAvailable();

    const root = await createFixture();
    try {
      const mainHelp = runCli(root, ["--help"]);
      const mainOutput = `${mainHelp.stdout ?? ""}${mainHelp.stderr ?? ""}`;
      expect(mainHelp.status).toBe(0);
      expect(mainOutput).toContain("Commands:");
      expect(mainOutput).toContain("doc [index]");
      expect(mainOutput).not.toContain("--out <path>");

      const docHelp = runCli(root, ["doc", "--help"]);
      const docOutput = `${docHelp.stdout ?? ""}${docHelp.stderr ?? ""}`;
      expect(docHelp.status).toBe(0);
      expect(docOutput).toContain("--out <path>");
      expect(docOutput).toContain("--format <format>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("voyd cli diagnostics output", { timeout: CLI_E2E_TIMEOUT_MS }, () => {
  it("suppresses duplicate diagnostics and prints a summary", async () => {
    assertCliRunnerAvailable();

    const fixture = await createDiagnosticCompactionFixture();
    try {
      const result = runCli(
        fixture.root,
        ["--emit-ir-ast"],
        { VOYD_STD_ROOT: fixture.stdRoot },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain("TY9999");
      expect(output).toContain("Suppressed ");
      expect(output).toContain("import diagnostics above display limit");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
