export const createConformanceCompilerAdapter = () => ({
  async compile({ entryPath }) {
    return {
      success: false,
      diagnostics: [
        {
          code: "MOCK0001",
          message: `external adapter received ${entryPath}`,
        },
      ],
    };
  },
});
