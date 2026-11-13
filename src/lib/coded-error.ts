/** A runtime or SQLite error that names its failure with a string code. */
export type CodedError = Error & { readonly code: string };

export function isCodedError(cause: unknown): cause is CodedError {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string";
}
