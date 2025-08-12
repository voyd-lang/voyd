import { Token } from "./token.js";
import { CharStream } from "./char-stream.js";
import {
  isOpChar,
  isTerminator,
  isWhitespace,
  isDigit,
  isDigitSign,
} from "./grammar.js";

/**
 * Tracks the current nesting depth of angle brackets during tokenization.
 * This allows the lexer to differentiate between `>>` used to close generics
 * and `>>` used as an operator.
 */
let angleBracketDepth = 0;

export const resetLexerState = () => {
  angleBracketDepth = 0;
};

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

  updateAngleBracketDepth(token, chars);

  return token;
};

const consumeOperator = (chars: CharStream, token: Token) => {
  while (isOpChar(chars.next)) {
    if (token.value === ">" && (angleBracketDepth > 0 || chars.next === ":")) {
      break;
    }

    token.addChar(chars.consumeChar());
  }
};

const updateAngleBracketDepth = (token: Token, chars: CharStream) => {
  if (token.value === "<" && !isWhitespace(chars.next)) {
    angleBracketDepth += 1;
  } else if (token.value === ">" && angleBracketDepth > 0) {
    angleBracketDepth -= 1;
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
