/** What the release fakes hold, so the fake and the tests that seed it agree on one shape. */
export type ReleaseFakeState = {
  compare: Record<string, string>;
  tags: Record<string, string>;
  releases: Record<string, string>;
};

export type ReleaseFakeFault = { kind: string; remaining: number };
