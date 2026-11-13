import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { main } from "./cli.ts";
import { OperatorCli } from "./modules/operator-cli/main.ts";

afterEach(() => {
  mock.restore();
});

test("passes the arguments to the Operator CLI and waits for it", async () => {
  const calls: string[][] = [];
  let finished = false;
  spyOn(OperatorCli, "main").mockImplementation(async (args) => {
    calls.push(args);
    await Bun.sleep(1);
    finished = true;
  });

  await main(["--version", "--json"]);

  expect(calls).toEqual([["--version", "--json"]]);
  expect(finished).toBe(true);
});
