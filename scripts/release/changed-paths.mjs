import { execFileSync } from "node:child_process";
import { repoRoot } from "./manifest.mjs";

export const changedPaths = ({ cwd = repoRoot } = {}) =>
  execFileSync("git", ["diff", "--name-only", "-z", "--"], {
    cwd,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  })
    .split("\0")
    .filter(Boolean);
