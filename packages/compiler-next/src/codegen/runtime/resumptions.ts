export type TailResumptionGuard<T, R = unknown> = {
  resume: (value: T) => R;
  finalize: () => void;
  callCount: () => number;
};

const defaultViolation = (message: string): never => {
  throw new Error(message);
};

export const createTailResumptionGuard = <T, R = unknown>({
  resume,
  label = "tail continuation",
  onViolation = defaultViolation,
}: {
  resume: (value: T) => R;
  label?: string;
  onViolation?: (message: string) => never;
}): TailResumptionGuard<T, R> => {
  let calls = 0;

  const guardedResume = (value: T): R => {
    calls += 1;
    if (calls > 1) {
      return onViolation(
        `${label} must be resumed exactly once (observed ${calls})`
      );
    }
    return resume(value);
  };

  const finalize = (): void => {
    if (calls !== 1) {
      onViolation(`${label} must be resumed exactly once (observed ${calls})`);
    }
  };

  return {
    resume: guardedResume,
    finalize,
    callCount: () => calls,
  };
};
