import { z } from "zod";

export const releaseFakeStateSchema = z.object({
  compare: z.record(z.string(), z.string()),
  tags: z.record(z.string(), z.string()),
  releases: z.record(z.string(), z.string()),
  releaseBodies: z.record(z.string(), z.string()).optional(),
});
export type ReleaseFakeState = z.infer<typeof releaseFakeStateSchema>;

export const releaseFakeFaultSchema = z.object({ kind: z.string(), remaining: z.number() });
export type ReleaseFakeFault = z.infer<typeof releaseFakeFaultSchema>;
