/** Herdr links one plugin by this id. Another plugin with it is never replaced. */
export const pluginId = "operator";

/**
 * The running release's manifest file. The release build ships it at the same path beside this
 * module, so a source checkout, a source install, and the JSR artifact all link the bytes they run.
 */
export const pluginManifestFile = Bun.fileURLToPath(
  new URL("./herdr-plugin.toml", import.meta.url),
);
