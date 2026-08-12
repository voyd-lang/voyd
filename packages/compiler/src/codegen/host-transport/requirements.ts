import type { BoundaryExportsOption } from "../context.js";

export const boundaryExportsEnabled = (
  option: BoundaryExportsOption | undefined,
): boolean =>
  option !== false &&
  option !== "off" &&
  (typeof option !== "object" || option.mode !== "off");

export const requiresSelectedHostTransport = ({
  effectsHostBoundary,
  boundaryExports,
}: {
  effectsHostBoundary?: "selected" | "off";
  boundaryExports?: BoundaryExportsOption;
}): boolean =>
  effectsHostBoundary !== "off" || boundaryExportsEnabled(boundaryExports);
