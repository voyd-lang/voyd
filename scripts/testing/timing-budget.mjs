import { basename } from "node:path";

export const fileBudgetMs = (file, budget) => {
  const normalizedFile = file.file.replaceAll("\\", "/");
  const pathOverride = Object.entries(budget.maxFileMsByPathSuffix ?? {}).find(
    ([suffix]) => {
      const normalizedSuffix = suffix.replaceAll("\\", "/");
      return (
        normalizedFile === normalizedSuffix ||
        normalizedFile.endsWith(`/${normalizedSuffix}`)
      );
    },
  );

  return (
    pathOverride?.[1] ??
    budget.maxFileMsByBasename?.[basename(file.file)] ??
    budget.maxFileMs
  );
};
