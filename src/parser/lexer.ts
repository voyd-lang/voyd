import { Token } from "./token.js";
import { CharStream } from "./char-stream.js";
import {
  isOpChar,
  isTerminator,
  isWhitespace,
  isDigit,
  isDigitSign,
} from "./grammar.js";

export const lexer = (chars: CharStream): Token => {
  const token = new Token({
    location: chars.currentSourceLocation(),
  });

  while (chars.hasCharacters) {
    const char = chars.next;

    if (!token.hasChars && char === " ") {
      consumeSpaces(chars, token);
      break;
    }

    if (!token.hasChars && nextIsNumber(chars)) {
      consumeNumber(chars, token);
      break;
    }

    if (!token.hasChars && char === ",") {
      token.addChar(chars.consumeChar());
      break;
    }

    if (!token.hasChars && isOpChar(char)) {
      consumeOperator(chars, token);
      break;
    }

    if (!token.hasChars && isTerminator(char)) {
      token.addChar(chars.consumeChar());
      break;
    }

    // Support sharp identifiers (Used by reader macros ignores non-whitespace terminators)
    if (token.first === "#" && !isWhitespace(char)) {
      token.addChar(chars.consumeChar());
      continue;
    }

    if (char === "\t") {
      throw new Error(
        "Tabs are not supported, use four spaces for indentation"
      );
    }

    if (isTerminator(char)) {
      break;
    }

    token.addChar(chars.consumeChar());
  }

  token.setEndLocationToStartOf(chars.currentSourceLocation());
  return token;
};

const consumeOperator = (chars: CharStream, token: Token) => {
  while (isOpChar(chars.next)) {
    if (token.value === ">" && (chars.next === ">" || chars.next === ":")) {
      break; // Ugly hack to support generics, means >> is not a valid operator. At least until we write a custom parser for the generics reader macro.
    }

    token.addChar(chars.consumeChar());
  }
};

const consumeNumber = (chars: CharStream, token: Token) => {
  const isValidNumber = (str: string) =>
    /^[+-]?\d+(?:\.\d+)?([Ee]?[+-]?\d+|(?:i|f)(?:|3|6|32|64))?$/.test(str);
  const stillConsumingNumber = () =>
    chars.next &&
    (isValidNumber(token.value + chars.next) ||
      isValidNumber(token.value + chars.next + chars.at(1)));

  while (stillConsumingNumber()) {
    token.addChar(chars.consumeChar());
  }
};

const nextIsNumber = (chars: CharStream) =>
  isDigit(chars.next) ||
  (isDigitSign(chars.next) && isDigit(chars.at(1) ?? ""));

const consumeSpaces = (chars: CharStream, token: Token) => {
  while (chars.next === " " && token.length < 2) {
    token.addChar(chars.consumeChar());
  }
};
