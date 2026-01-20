export const formatTestExportName = ({
  moduleId,
  testId,
}: {
  moduleId: string;
  testId: string;
}): string => `${moduleId}::${testId}`;
