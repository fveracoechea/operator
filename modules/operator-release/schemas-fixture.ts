import { z } from "zod";

export const packageSchema = z.looseObject({
  version: z.string(),
  license: z.string().optional(),
  exports: z.record(z.string(), z.unknown()).optional(),
});

export const jsrSchema = z.looseObject({
  license: z.string(),
  imports: z.record(z.string(), z.string()),
});

export const releaseSchema = z.looseObject({
  version: z.string(),
  commit: z.string(),
  artifactIdentity: z.string(),
  builtAt: z.string(),
});

export const versionSchema = z.object({ data: z.looseObject({ operatorVersion: z.string() }) });
