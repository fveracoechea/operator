/** The three steps of one tracker update. Each one is recorded and recovered on its own. */
export const TRACKER_STEPS = ["resolution", "completion", "map_amendment"] as const;

export type TrackerStep = (typeof TRACKER_STEPS)[number];

export type TrackerTarget = { repository: string; issue: number };

/**
 * What one tracker provider can actually guarantee.
 * Each field is a verified capability, never an assumption carried over from another provider.
 */
export type Capabilities = {
  provider: string;
  /** The provider can add a comment that carries an operation marker and exact content. */
  comments: boolean;
  /** The provider can complete a ticket with an explicit reason. */
  completion: boolean;
  /** The provider can replace a shared body under a conditional write that another writer loses. */
  bodyReplacementGuard: boolean;
  /** The provider accepts a caller key that makes one creation apply at most once. */
  exactlyOnceWrites: boolean;
};

/**
 * GitHub is the only provider this release implements.
 * Body replacement has no conditional write on the issues endpoint, and comment creation has no
 * server retry key, so both are recorded as absent rather than assumed.
 */
const providers: Record<string, Capabilities | undefined> = {
  github: {
    provider: "github",
    comments: true,
    completion: true,
    bodyReplacementGuard: false,
    exactlyOnceWrites: false,
  },
};

export function capabilitiesOf(provider: string): Capabilities | null {
  return providers[provider] ?? null;
}

export function isTrackerStep(value: string): value is TrackerStep {
  return TRACKER_STEPS.some((step) => step === value);
}
