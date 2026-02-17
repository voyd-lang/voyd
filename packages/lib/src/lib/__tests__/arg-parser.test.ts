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
  });

  it("supports `voyd docs` alias with explicit output path", () => {
    const config = runWithArgv(["node", "voyd", "docs", "./demo", "--out", "docs.html"]);
    expect(config.doc).toBe(true);
    expect(config.index).toBe("./demo");
    expect(config.docOut).toBe("docs.html");
  });
});
