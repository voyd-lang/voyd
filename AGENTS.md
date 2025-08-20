# Testing

This repo uses vitest for testing. You can run the full test
suite with `npm test`.

Additionally, you can parse, compile, and run voyd files locally
with the `vt` command (a bin script in package.json). See `src/cli/exec.ts`
for a list of commands, (camel case is converted to --emit-parser-ast for
example)

You should generally add unit tests (especially e2e ones like those in `src/__tests__) when adding new features or fixing bugs

# Style Guide

- Avoid deeply nested code
- Use early returns rather than large if chains
- Keep things as functional as practical
- Break large chunks of code down into smaller functions
