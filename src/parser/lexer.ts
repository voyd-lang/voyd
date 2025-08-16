import { Token } from "./token.js";
import { CharStream } from "./char-stream.js";
import {
  isOpChar,
  isTerminator,
  isWhitespace,
  isDigit,
  isDigitSign,
} from "./grammar.js";

const NUMBER_REGEX = /^[+-]?\d+(?:\.\d+)?([Ee]?[+-]?\d+|(?:i|f)(?:|3|6|32|64))?$/;

/**
 * Lexer that tracks angle bracket nesting depth so that `>>` can be
 * tokenized either as two closing brackets (inside generics) or as a shift
 * operator (outside generics).
 */
export class Lexer {
  private angleBracketDepth = 0;

  tokenize(chars: CharStream): Token {
    const token = new Token({
      location: chars.currentSourceLocation(),
    });

    while (chars.hasCharacters) {
      const char = chars.next;

      if (!token.hasChars && char === " ") {
        this.consumeSpaces(chars, token);
        break;
      }

      if (!token.hasChars && this.nextIsNumber(chars)) {
        this.consumeNumber(chars, token);
        break;
      }

      if (!token.hasChars && char === ",") {
        token.addChar(chars.consumeChar());
        break;
      }

      if (!token.hasChars && isOpChar(char)) {
        this.consumeOperator(chars, token);
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
          "Tabs are not supported, use four spaces for indentation",
        );
      }

      if (isTerminator(char)) {
        break;
      }

      token.addChar(chars.consumeChar());
    }

    token.setEndLocationToStartOf(chars.currentSourceLocation());

    this.updateAngleBracketDepth(token, chars);

    return token;
  }

  private consumeOperator(chars: CharStream, token: Token) {
    while (isOpChar(chars.next)) {
      if (token.value === ">" && (this.angleBracketDepth > 0 || chars.next === ":")) {
        break;
      }

      token.addChar(chars.consumeChar());
    }
  }

  private updateAngleBracketDepth(token: Token, chars: CharStream) {
    if (token.value === "<" && !isWhitespace(chars.next)) {
      this.angleBracketDepth += 1;
    } else if (token.value === ">" && this.angleBracketDepth > 0) {
      this.angleBracketDepth -= 1;
    }
  }

  private consumeNumber(chars: CharStream, token: Token) {
    while (true) {
      const next = chars.next;
      if (
        !next ||
        (!NUMBER_REGEX.test(token.value + next) &&
          !NUMBER_REGEX.test(token.value + next + (chars.at(1) ?? "")))
      ) {
        break;
      }
      token.addChar(chars.consumeChar());
    }
  }

  private nextIsNumber(chars: CharStream) {
    return (
      isDigit(chars.next) ||
      (isDigitSign(chars.next) && isDigit(chars.at(1) ?? ""))
    );
  }

  private consumeSpaces(chars: CharStream, token: Token) {
    while (chars.next === " " && token.length < 2) {
      token.addChar(chars.consumeChar());
    }
  }
}

