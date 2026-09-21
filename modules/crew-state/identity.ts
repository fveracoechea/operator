import { ContentIdentity } from "../content-identity/main.ts";

export function identityOf(value: unknown): string {
  return ContentIdentity.of(value);
}

/** An assignment is named by its source and its key inside that source, so it cannot duplicate. */
export function assignmentId(sourceId: string, sourceKey: string): string {
  return identityOf({ sourceId, sourceKey }).slice(0, 32);
}
