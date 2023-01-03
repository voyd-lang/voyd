import { ReaderMacro } from "./types.mjs";
import { Comment } from "../lib/index.mjs";

export const comment: ReaderMacro = {
  tag: /^\/\/[^\s]*$/,
  macro: (file, { token }) => {
    let comment = "";

    while (file.hasCharacters) {
      if (file.next === "\n") break;
      comment += file.consume();
    }

    return new Comment({
      location: {
        ...token.location,
        endIndex: file.position,
      },
      value: `//${comment}`,
    });
  },
};
