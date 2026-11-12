/** Port for reporting unexpected failures; `main.ts` provides the concrete sink. */
export type Logger = {
  readonly error: (error: unknown) => void;
};
