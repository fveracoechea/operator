/*
 * Preloaded into one CLI run by a test (`STATE_LOST_AFTER_PLAN`). Once the run writes a publish
 * or recall plan file, the crew state goes away, so the next read of the run is the approval read
 * of the apply, and that read cannot find the state.
 */
const PLAN_STORE = "/.operator/local/publish-plans/";
const write = Bun.write;

Object.assign(Bun, {
  async write(destination: unknown, input: unknown, options?: unknown) {
    const written: unknown = await Reflect.apply(write, Bun, [destination, input, options]);
    const path = String(destination);
    if (path.includes(PLAN_STORE)) {
      const local = `${path.slice(0, path.indexOf(PLAN_STORE))}/.operator/local`;
      await Bun.$`mkdir -p ${local}/lost-state`.quiet();
      await Bun.$`mv ${local}/crew-state.sqlite ${local}/lost-state/`.quiet();
      await Bun.$`mv -f ${local}/crew-state.sqlite-wal ${local}/crew-state.sqlite-shm ${local}/lost-state/`
        .quiet()
        .nothrow();
    }
    return written;
  },
});
