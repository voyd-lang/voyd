import { isRecord, readField, toNumberOrUndefined, toStringOrUndefined } from "./helpers.js";

export const isAbortLikeError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  const code = isRecord(error) ? toStringOrUndefined(readField(error, "code")) : undefined;
  if (code === "ABORT_ERR" || code === "ERR_CANCELED") {
    return true;
  }
  const name = isRecord(error) ? toStringOrUndefined(readField(error, "name")) : undefined;
  if (name === "AbortError") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("aborted") || message.includes("timed out");
};

export const fetchErrorCode = (error: unknown): number =>
  isAbortLikeError(error) ? 2 : 1;

export const fetchErrorMessage = (error: unknown): string => {
  if (isAbortLikeError(error)) {
    return "fetch request timed out or was aborted";
  }
  return error instanceof Error ? error.message : String(error);
};

export const isInputClosedError = (error: unknown): boolean => {
  if (isAbortLikeError(error)) {
    return true;
  }
  const code = isRecord(error) ? toStringOrUndefined(readField(error, "code")) : undefined;
  if (code === "ERR_USE_AFTER_CLOSE") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("readline was closed") ||
    message.includes("input closed") ||
    message.includes("end of input")
  );
};

export const inputErrorCode = (error: unknown): number =>
  isInputClosedError(error) ? 2 : 1;

export const inputErrorMessage = (error: unknown): string => {
  if (isInputClosedError(error)) {
    return "input stream was closed or aborted";
  }
  return error instanceof Error ? error.message : String(error);
};

export const outputErrorCode = (error: unknown): number => {
  const errno = isRecord(error) ? readField(error, "errno") : undefined;
  const parsed = toNumberOrUndefined(errno);
  return parsed === undefined ? 1 : parsed;
};

export const outputErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
