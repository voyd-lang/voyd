import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../..");

const npmTarget = ({
  packRequiredFiles,
  packForbiddenPatterns = [],
  relatedTests = [],
  ...target
}) => ({
  ...target,
  kind: "npm",
  access: "public",
  packRequiredFiles,
  packForbiddenPatterns,
  relatedTests,
});

export const releaseTargets = {
  "@voyd-lang/std": npmTarget({
    workspace: "@voyd-lang/std",
    cwd: "packages/std",
    description: "Voyd standard library source bundle",
    packRequiredFiles: ["package.json", "src/pkg.voyd", "dist/.placeholder"],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "@voyd-lang/lib": npmTarget({
    workspace: "@voyd-lang/lib",
    cwd: "packages/lib",
    description: "Shared Voyd runtime and tooling helpers",
    packRequiredFiles: [
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
      "assets/voyd.tmLanguage.json",
      "assets/voyd-markdown-injection.json",
    ],
    packForbiddenPatterns: [/^src\//, /^dist\/__tests__\//, /^dist\/.*\/src\//],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "@voyd-lang/compiler": npmTarget({
    workspace: "@voyd-lang/compiler",
    cwd: "packages/compiler",
    description: "Voyd compiler pipeline",
    packRequiredFiles: ["package.json", "dist/pipeline.js", "dist/pipeline.d.ts"],
    packForbiddenPatterns: [
      /^src\//,
      /^dist\/__tests__\//,
      /^dist\/.*\/__tests__\//,
      /\.test\.(d\.ts|d\.ts\.map|js|js\.map)$/,
    ],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "@voyd-lang/js-host": npmTarget({
    workspace: "@voyd-lang/js-host",
    cwd: "packages/js-host",
    description: "Voyd JS host runtime",
    packRequiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    packForbiddenPatterns: [
      /^src\//,
      /^dist\/__tests__\//,
      /\.test\.(d\.ts|d\.ts\.map|js|js\.map)$/,
    ],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "@voyd-lang/sdk": npmTarget({
    workspace: "@voyd-lang/sdk",
    cwd: "packages/sdk",
    description: "Public Voyd SDK",
    packRequiredFiles: [
      "package.json",
      "dist/node.js",
      "dist/node.d.ts",
      "dist/browser/index.js",
      "dist/compiler.js",
      "dist/compiler.d.ts",
    ],
    packForbiddenPatterns: [
      /^src\//,
      /^dist\/__tests__\//,
      /^dist\/.*\/src\//,
      /\.test\.(d\.ts|d\.ts\.map|js|js\.map)$/,
    ],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "@voyd-lang/language-server": npmTarget({
    workspace: "@voyd-lang/language-server",
    cwd: "packages/language-server",
    description: "Voyd language server",
    packRequiredFiles: [
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/server.js",
      "dist/server.d.ts",
    ],
    packForbiddenPatterns: [/^src\//, /^dist\/__tests__\//],
    relatedTests: ["own"],
  }),
  "@voyd-lang/reference": npmTarget({
    workspace: "@voyd-lang/reference",
    cwd: "packages/reference",
    description: "Voyd language reference bundle",
    packRequiredFiles: [
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
      "index.d.ts",
    ],
    packForbiddenPatterns: [/^docs\//, /^spec\//, /^scripts\//],
    relatedTests: [],
  }),
  "@voyd-lang/cli": npmTarget({
    workspace: "@voyd-lang/cli",
    cwd: "apps/cli",
    description: "Voyd CLI",
    packRequiredFiles: [
      "package.json",
      "bin/voyd.js",
      "dist/cli.js",
      "dist/exec.js",
      "dist/test-runner.js",
    ],
    packForbiddenPatterns: [/^src\//, /^dist\/__tests__\//],
    relatedTests: ["own", "smoke", "cli-dist"],
  }),
  "voyd-vscode": {
    kind: "vscode",
    workspace: "voyd-vscode",
    cwd: "apps/vscode",
    description: "Voyd VSCode extension",
    relatedTests: ["own"],
  },
};

export const orderedTargetNames = Object.keys(releaseTargets);

export const getTarget = (targetName) => {
  const target = releaseTargets[targetName];
  if (!target) {
    throw new Error(`Unknown release target: ${targetName}`);
  }
  return target;
};

export const resolveTargetCwd = (targetName) =>
  path.join(repoRoot, getTarget(targetName).cwd);

export const readJson = (filePath) =>
  JSON.parse(fs.readFileSync(filePath, "utf8"));

export const readTargetPackageJson = (targetName) =>
  readJson(path.join(resolveTargetCwd(targetName), "package.json"));

export const parseTargetSelection = (argv) => {
  const targets = [];
  let all = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg === "--target" || arg === "--targets") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      targets.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=") || arg.startsWith("--targets=")) {
      const value = arg.split("=")[1] ?? "";
      targets.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }

  const selected = all ? orderedTargetNames : targets;
  const deduped = Array.from(new Set(selected));
  deduped.forEach(getTarget);

  if (deduped.length === 0) {
    throw new Error("Select at least one release target with --target or use --all.");
  }

  return deduped;
};

export const collectPublishDependencies = (targetName) => {
  const packageJson = readTargetPackageJson(targetName);
  const dependencyFields = [
    packageJson.dependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].filter(Boolean);

  return dependencyFields.flatMap((field) =>
    Object.keys(field).filter((depName) => depName in releaseTargets),
  );
};
