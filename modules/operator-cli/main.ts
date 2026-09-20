import { run } from "./run.ts";

export const OperatorCli = {
  async main(args: string[]): Promise<void> {
    await run(args);
  },
};
