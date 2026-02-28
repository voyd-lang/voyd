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
    expect(config.test).toBeFalsy();
  });

  it("defaults test root to repo for `voyd test`", () => {
    const config = runWithArgv(["node", "voyd", "test"]);
    expect(config.index).toBe(".");
    expect(config.test).toBe(true);
  });

  it("defaults test root to repo for --test", () => {
    const config = runWithArgv(["node", "voyd", "--test"]);
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
    const config = runWithArgv([
      "node",
      "voyd",
      "doc",
      "--format",
      "json",
    ]);
    expect(config.doc).toBe(true);
    expect(config.docFormat).toBe("json");
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

  it("does not treat --reporter values as subcommands", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--test",
      "--reporter",
      "doc",
    ]);
    expect(config.test).toBe(true);
    expect(config.doc).toBe(false);
    expect(config.testReporter).toBe("doc");
  });

  it("does not treat --run-entry values as subcommands", () => {
    const config = runWithArgv([
      "node",
      "voyd",
      "--run",
      "--run-entry",
      "test",
    ]);
    expect(config.run).toBe(true);
    expect(config.test).toBe(false);
    expect(config.doc).toBe(false);
    expect(config.runEntry).toBe("test");
  });
});
