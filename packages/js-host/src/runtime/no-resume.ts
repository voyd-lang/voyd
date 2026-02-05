const NO_RESUME_BRAND = Symbol.for("voyd.no-resume");

export type NoResume<T = unknown> = {
  readonly [NO_RESUME_BRAND]: true;
  readonly value: T;
};

export const noResume = <T>(value: T): NoResume<T> => ({
  [NO_RESUME_BRAND]: true,
  value,
});

export const isNoResume = (value: unknown): value is NoResume => {
  if (!value || typeof value !== "object") return false;
  return (value as Record<symbol, unknown>)[NO_RESUME_BRAND] === true;
};
