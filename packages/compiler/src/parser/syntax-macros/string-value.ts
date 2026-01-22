import {
  type Expr,
  Form,
  IntAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";

export const parseStringValue = (expr?: Expr): string | null => {
  if (!expr) {
    return null;
  }

  if (isIdentifierAtom(expr)) {
    return expr.value;
  }

  if (!isForm(expr) || (!expr.calls("new_string") && !expr.callsInternal("new_string"))) {
    return null;
  }

  const bytesExpr = extractBytesExpr(expr);
  if (!bytesExpr) {
    return null;
  }

  const bytes = extractBytes(bytesExpr);
  if (!bytes) {
    return null;
  }

  return decodeUtf8Bytes(bytes);
};

const extractBytesExpr = (expr: Form): Form | null => {
  const rawValue = expr.at(1);
  if (!isForm(rawValue)) {
    return null;
  }

  if (rawValue.callsInternal("fixed_array_literal")) {
    return rawValue;
  }

  if (rawValue.calls("FixedArray")) {
    return rawValue;
  }

  if (!formCallsInternal(rawValue, "object_literal")) {
    return null;
  }

  const fromField = rawValue.rest.find((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      return false;
    }
    const key = entry.at(1);
    return isIdentifierAtom(key) && key.value === "from";
  });

  if (!fromField || !isForm(fromField)) {
    return null;
  }

  const fromValue = fromField.at(2);
  if (!isForm(fromValue)) {
    return null;
  }

  return fromValue;
};

const extractBytes = (form: Form): number[] | null => {
  const bytes: number[] = [];
  let sawValue = false;

  form.rest.forEach((entry, index) => {
    if (index === 0 && isForm(entry) && entry.callsInternal("generics")) {
      return;
    }

    if (entry instanceof IntAtom) {
      sawValue = true;
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        bytes.push(parsed);
      }
      return;
    }

    if (isIdentifierAtom(entry)) {
      sawValue = true;
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        bytes.push(parsed);
      }
    }
  });

  if (bytes.length === 0 && sawValue) {
    return null;
  }

  return bytes;
};

const decodeUtf8Bytes = (bytes: number[]): string => {
  let result = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (!isByte(b0)) {
      result += "\ufffd";
      i += 1;
      continue;
    }

    if (b0 <= 0x7f) {
      result += String.fromCharCode(b0);
      i += 1;
      continue;
    }

    if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = bytes[i + 1];
      if (isContinuationByte(b1)) {
        const codePoint = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
        result += String.fromCodePoint(codePoint);
        i += 2;
        continue;
      }
    }

    if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (isValidThreeByteLead(b0, b1, b2)) {
        const codePoint =
          ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        result += String.fromCodePoint(codePoint);
        i += 3;
        continue;
      }
    }

    if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (isValidFourByteLead(b0, b1, b2, b3)) {
        const codePoint =
          ((b0 & 0x07) << 18) |
          ((b1 & 0x3f) << 12) |
          ((b2 & 0x3f) << 6) |
          (b3 & 0x3f);
        result += String.fromCodePoint(codePoint);
        i += 4;
        continue;
      }
    }

    result += "\ufffd";
    i += 1;
  }

  return result;
};

const isByte = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 0xff;

const isContinuationByte = (value: number | undefined): value is number =>
  isByte(value) && value >= 0x80 && value <= 0xbf;

const isValidThreeByteLead = (
  b0: number,
  b1: number | undefined,
  b2: number | undefined
): boolean => {
  if (!isContinuationByte(b1) || !isContinuationByte(b2)) {
    return false;
  }
  if (b0 === 0xe0 && b1 < 0xa0) {
    return false;
  }
  if (b0 === 0xed && b1 > 0x9f) {
    return false;
  }
  return true;
};

const isValidFourByteLead = (
  b0: number,
  b1: number | undefined,
  b2: number | undefined,
  b3: number | undefined
): boolean => {
  if (!isContinuationByte(b1) || !isContinuationByte(b2) || !isContinuationByte(b3)) {
    return false;
  }
  if (b0 === 0xf0 && b1 < 0x90) {
    return false;
  }
  if (b0 === 0xf4 && b1 > 0x8f) {
    return false;
  }
  return true;
};
