import { OperatorInstallation } from "../modules/operator-installation/main.ts";

const path = new URL("../schemas/generated/config.schema.json", import.meta.url).pathname;
const generated = `${JSON.stringify(OperatorInstallation.configJsonSchema(), null, 2)}\n`;

if (Bun.argv.includes("--check")) {
  const current = await Bun.file(path).text();
  if (current !== generated) {
    console.error("schemas/generated/config.schema.json is stale. Run bun run schema:generate.");
    process.exitCode = 1;
  }
} else {
  await Bun.write(path, generated);
}
