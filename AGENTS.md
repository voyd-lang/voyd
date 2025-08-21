# Voyd Programming Language

This repository contains the implementation of the voyd programming language.
voyd is a level between rust and typescript in terms of abstraction. It
compiles to webassembly.

# Testing

This repo uses vitest for testing. You can run the full test
suite with `npm test`.

There is also a command line you can execute with tsx `src/cli/cli-dev.ts`.
You can use it to parse voyd files, or run any voyd file that exports a `main`
function. See `src/cli/exec.ts` for a list of commands, (camel case is converted
to cli friendly form. `emitParserAst` becomes `--emit-parser-ast` for example).

You should generally add unit tests (especially e2e ones like those in
`src/__tests__) when adding new features or fixing bugs.

Note: If tests fail and you are out of time, commit your results anyway and
inform the user of the test failure. Its better to be able to try and debug
the code than to have the work thrown away.

# Style Guide

- Avoid deeply nested code
- Use early returns rather than large if chains
- Keep things as functional as practical
- Break large chunks of code down into smaller functions
