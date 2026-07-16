import { describe, expect, it } from "vitest";
import { getConfigFromCli } from "../config/arg-parser.js";

const runWithArgv = (argv: string[]) => {
  const originalArgv = process.argv;
  process.argv = argv;
  try {
    return getConfigFromCli();
  } finally {
    process.argv = originalArgv;
  }
};

describe("getConfigFromCli", () => {
  it("defaults index to ./src for non-test runs", () => {
    const config = runWithArgv(["node", "voyd"]);
    expect(config.index).toBe("./src");
    expect(config.optimizationLevel).toBe("none");
    expect(config.test).toBeFalsy();
  });

  it("preserves bare --opt as the release level without consuming the input path", () => {
    const config = runWithArgv(["node", "voyd", "--opt", "./src/main.voyd"]);
    expect(config.optimizationLevel).toBe("release");
    expect(config.index).toBe("./src/main.voyd");
  });

  it.each(["none", "balanced", "release"] as const)(
    "supports the %s optimization level",
    (level) => {
      const config = runWithArgv([
        "node",
        "voyd",
        "--opt-level",
        level,
        "./src/main.voyd",
      ]);
      expect(config.optimizationLevel).toBe(level);
      expect(config.index).toBe("./src/main.voyd");
    },
  );

  it("rejects invalid optimization levels", () => {
    expect(() => runWithArgv(["node", "voyd", "--opt-level", "fast"])).toThrow(
      /invalid optimization level/,
    );
  });

  it("rejects combining --opt with --opt-level", () => {
    expect(() =>
      runWithArgv(["node", "voyd", "--opt", "--opt-level", "balanced"]),
    ).toThrow(/--opt and --opt-level cannot be used together/);
  });

  it("defaults test root to repo for `voyd test`", () => {
    const config = runWithArgv(["node", "voyd", "test"]);
    expect(config.index).toBe(".");
    expect(config.test).toBe(true);
  });

  it("collects repeatable --pkg-dir options", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--pkg-dir",
      "./node_modules",
      "--pkg-dir",
      "../vendor/packages",
    ]);
    expect(config.pkgDirs).toEqual(["./node_modules", "../vendor/packages"]);
  });

  it("supports `voyd doc` with default source root", () => {
    const config = runWithArgv(["node", "voyd", "doc"]);
    expect(config.doc).toBe(true);
    expect(config.index).toBe("./src");
    expect(config.docFormat).toBe("html");
  });

  it("supports `voyd docs` alias with explicit output path", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "docs",
      "./demo",
      "--out",
      "docs.html",
    ]);
    expect(config.doc).toBe(true);
    expect(config.index).toBe("./demo");
    expect(config.docOut).toBe("docs.html");
  });

  it("supports JSON doc output format", () => {
    const config = runWithArgv(["node", "voyd", "doc", "--format", "json"]);
    expect(config.doc).toBe(true);
    expect(config.docFormat).toBe("json");
  });

  it("supports `voyd bootstrap` with the default vx-spa template", () => {
    const config = runWithArgv(["node", "voyd", "bootstrap", "demo-app"]);
    expect(config.bootstrap).toBe(true);
    expect(config.bootstrapDir).toBe("demo-app");
    expect(config.bootstrapTemplate).toBe("vx-spa");
  });

  it("supports `voyd bootstrap --template web-ssr`", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "bootstrap",
      "demo-app",
      "--template",
      "web-ssr",
    ]);
    expect(config.bootstrap).toBe(true);
    expect(config.bootstrapDir).toBe("demo-app");
    expect(config.bootstrapTemplate).toBe("web-ssr");
  });

  it("supports bootstrap dry-run, force, and published-package flags", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "bootstrap",
      "--dry-run",
      "--force",
      "--published",
    ]);
    expect(config.bootstrap).toBe(true);
    expect(config.bootstrapDir).toBe(".");
    expect(config.bootstrapDryRun).toBe(true);
    expect(config.bootstrapForce).toBe(true);
    expect(config.bootstrapUsePublished).toBe(true);
  });

  it("parses package adapter and application registry generation", () => {
    const adapter = runWithArgv([
      "node",
      "voyd",
      "generate",
      "adapter",
      "./src",
      "--out",
      "./generated/adapter",
    ]);
    expect(adapter.generateAdapter).toBe(true);
    expect(adapter.index).toBe("./src");
    expect(adapter.generateOut).toBe("./generated/adapter");

    const registry = runWithArgv([
      "node",
      "voyd",
      "generate",
      "registry",
      "./src/main.voyd",
    ]);
    expect(registry.generateAdapterRegistry).toBe(true);
  });

  it("parses `voyd test` when global options come first", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--pkg-dir",
      "./vendor",
      "test",
      "./suite",
    ]);
    expect(config.test).toBe(true);
    expect(config.index).toBe("./suite");
    expect(config.pkgDirs).toEqual(["./vendor"]);
  });

  it("parses `voyd doc` when global options come first", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--pkg-dir=./vendor",
      "doc",
      "./src/pkg.voyd",
    ]);
    expect(config.doc).toBe(true);
    expect(config.index).toBe("./src/pkg.voyd");
    expect(config.pkgDirs).toEqual(["./vendor"]);
  });

  it("parses reporter when passed to `voyd test`", () => {
    const config = runWithArgv(["node", "voyd", "test", "--reporter", "doc"]);
    expect(config.test).toBe(true);
    expect(config.doc).toBe(false);
    expect(config.testReporter).toBe("doc");
  });

  it("does not treat --entry values as subcommands", () => {
    const config = runWithArgv(["node", "voyd", "--run", "--entry", "test"]);
    expect(config.run).toBe(true);
    expect(config.test).toBeFalsy();
    expect(config.doc).toBe(false);
    expect(config.entry).toBe("test");
  });

  it("parses --run-wasm when the wasm path appears before --entry", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--run-wasm",
      "./dist/module.wasm",
      "--entry",
      "custom_main",
    ]);
    expect(config.runWasm).toBe(true);
    expect(config.index).toBe("./dist/module.wasm");
    expect(config.entry).toBe("custom_main");
  });

  it("parses --run-wasm when the wasm path appears after --entry", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--run-wasm",
      "--entry",
      "custom_main",
      "./dist/module.wasm",
    ]);
    expect(config.runWasm).toBe(true);
    expect(config.index).toBe("./dist/module.wasm");
    expect(config.entry).toBe("custom_main");
  });

  it("parses --run-wasm when --entry uses an inline value", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--run-wasm",
      "./dist/module.wasm",
      "--entry=custom_main",
    ]);
    expect(config.runWasm).toBe(true);
    expect(config.index).toBe("./dist/module.wasm");
    expect(config.entry).toBe("custom_main");
  });
});
