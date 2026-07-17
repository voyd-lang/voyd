import { resolveVoydPackageDirectories } from "@voyd-lang/lib/package-directories.js";

export const resolvePackageDirs = ({
  srcRoot,
  additionalPkgDirs,
}: {
  srcRoot: string;
  additionalPkgDirs: readonly string[];
}): string[] => {
  return resolveVoydPackageDirectories({
    sourceRoot: srcRoot,
    additionalPackageDirectories: additionalPkgDirs,
  });
};
