import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { changedPaths } from "./changed-paths.mjs";

let repository;

afterEach(() => {
  if (repository) {
    rmSync(repository, { recursive: true, force: true });
    repository = undefined;
  }
});

it("reads unstaged paths without truncating or unquoting them", () => {
  repository = mkdtempSync(path.join(tmpdir(), "voyd-release-paths-"));
  const paths = [
    "apps/cli/package.json",
    'release files/package "notes".json',
  ];

  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  paths.forEach((relativePath) => {
    const absolutePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "before\n");
  });
  execFileSync("git", ["add", "--", ...paths], { cwd: repository });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Voyd Test",
      "-c",
      "user.email=test@voyd.dev",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repository },
  );

  expect(changedPaths({ cwd: repository })).toEqual([]);

  paths.forEach((relativePath) => {
    writeFileSync(path.join(repository, relativePath), "after\n");
  });

  const porcelain = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: repository,
    encoding: "utf8",
  });
  const statuses = porcelain.split("\n").filter(Boolean);
  expect(statuses).toHaveLength(paths.length);
  expect(statuses.every((status) => status.startsWith(" M "))).toBe(true);
  expect(changedPaths({ cwd: repository })).toEqual(paths);
});
