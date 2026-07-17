import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type VoydPackageDirectoryIssue = {
  manifestPath: string;
  message: string;
};

export type VoydPackageDirectoryInspection = {
  packageDirectories: string[];
  manifestPaths: string[];
  issues: VoydPackageDirectoryIssue[];
};

export const resolveVoydPackageDirectories = ({
  sourceRoot,
  additionalPackageDirectories = [],
}: {
  sourceRoot: string;
  additionalPackageDirectories?: readonly string[];
}): string[] => {
  const inspection = inspectVoydPackageDirectories({
    sourceRoot,
    additionalPackageDirectories,
  });
  if (inspection.issues.length > 0) {
    throw new Error(inspection.issues.map(({ message }) => message).join("\n"));
  }
  return inspection.packageDirectories;
};

export const inspectVoydPackageDirectories = ({
  sourceRoot,
  additionalPackageDirectories = [],
}: {
  sourceRoot: string;
  additionalPackageDirectories?: readonly string[];
}): VoydPackageDirectoryInspection => {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const explicitDirectories = additionalPackageDirectories.map((directory) =>
    path.resolve(resolvedSourceRoot, directory),
  );
  const ancestorDirectories = collectAncestorDirectories(resolvedSourceRoot);
  const manifestPaths = ancestorDirectories.map((directory) =>
    path.join(directory, "package.json"),
  );
  const inspectedManifests = manifestPaths.map(inspectPackageManifest);
  const configuredDirectories = inspectedManifests.flatMap(
    ({ packageDirectories }) => packageDirectories,
  );
  const nodeModulesDirectories = ancestorDirectories.map((directory) =>
    path.join(directory, "node_modules"),
  );

  return {
    packageDirectories: dedupePaths([
      ...explicitDirectories,
      ...configuredDirectories,
      ...nodeModulesDirectories,
    ]),
    manifestPaths,
    issues: inspectedManifests.flatMap(({ issues }) => issues),
  };
};

const collectAncestorDirectories = (startDirectory: string): string[] => {
  const directories: string[] = [];
  let current = path.resolve(startDirectory);

  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
};

const inspectPackageManifest = (
  manifestPath: string,
): Pick<VoydPackageDirectoryInspection, "packageDirectories" | "issues"> => {
  if (!existsSync(manifestPath)) {
    return { packageDirectories: [], issues: [] };
  }

  const manifestResult = readPackageJson(manifestPath);
  if (!manifestResult.success) {
    return {
      packageDirectories: [],
      issues: [{ manifestPath, message: manifestResult.message }],
    };
  }

  const manifest = manifestResult.value;
  if (!isRecord(manifest) || !isRecord(manifest.voyd)) {
    return { packageDirectories: [], issues: [] };
  }

  const configured = manifest.voyd.packageDirectories;
  if (configured === undefined) {
    return { packageDirectories: [], issues: [] };
  }
  if (
    !Array.isArray(configured) ||
    configured.some((entry) => !isNonEmptyString(entry))
  ) {
    return {
      packageDirectories: [],
      issues: [
        {
          manifestPath,
          message: `Invalid voyd.packageDirectories in ${manifestPath}: expected an array of non-empty strings`,
        },
      ],
    };
  }

  const manifestDirectory = path.dirname(manifestPath);
  return {
    packageDirectories: configured.map((entry) =>
      path.resolve(manifestDirectory, entry),
    ),
    issues: [],
  };
};

const readPackageJson = (
  manifestPath: string,
): { success: true; value: unknown } | { success: false; message: string } => {
  try {
    return {
      success: true,
      value: JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Unable to read ${manifestPath}: ${message}`,
    };
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dedupePaths = (paths: readonly string[]): string[] =>
  Array.from(new Set(paths));
