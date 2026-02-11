export const TEST_ID_PREFIX = "__test__";

export const isGeneratedTestId = (id: string): boolean =>
  id.startsWith(TEST_ID_PREFIX);
