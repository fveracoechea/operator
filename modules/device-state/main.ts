import { Err, fromThrowable } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { createDatabase, databaseExists } from "./creation.ts";
import { openDatabase } from "./database.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";
import { registerProject, lookupProject, type RegisteredProject } from "./projects.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

/** Only explicit registration may create state. Connections never leave this owner. */
export const DeviceState = {
  registerProject(paths: Paths, project: RegisteredProject) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database)) return createDatabase(paths, project);
      using client = openDatabase(paths.database, false);
      return registerProject(client, project);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  lookupProject(paths: Paths, checkout: string, repositories: string[]) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail:
            "The device database is missing. Run operator project register explicitly in the controlling checkout.",
        });
      using client = openDatabase(paths.database, true);
      return lookupProject(client, checkout, repositories);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
};
