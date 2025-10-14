import { readFileSync } from "node:fs";

const fixturePath = new URL(
  "./voyd/map-recursive-union-north-star.voyd",
  import.meta.url
);

export const mapRecursiveUnionNorthStarVoyd = readFileSync(
  fixturePath,
  "utf8"
);
