import { sha256Hex } from "../../utils/sha256.js";

const PREFIX = "sha256:";

/** Compacts persisted exact query inputs without using the former unsafe
 * 32-bit equality hash. Normal in-process analysis keeps exact strings and
 * pays this cost only when exporting or consuming a durable artifact. */
export const persistedBorrowQueryInput = (input: string): string =>
  input.startsWith(PREFIX)
    ? input
    : `${PREFIX}${sha256Hex(new TextEncoder().encode(input))}`;

export const borrowQueryInputsEqual = (
  previous: string,
  current: string,
): boolean =>
  previous.startsWith(PREFIX)
    ? previous === persistedBorrowQueryInput(current)
    : previous === current;

export const persistedBorrowQueryOutput = (output: unknown): string =>
  `${PREFIX}${sha256Hex(new TextEncoder().encode(JSON.stringify(output)))}`;
