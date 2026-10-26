import { Err, fromThrowable } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { createDatabase, databaseExists } from "./creation.ts";
import { openDatabase } from "./database.ts";
import { compatibility } from "./compatibility.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";
import { registerProject, lookupProject, type RegisteredProject } from "./projects.ts";
import {
  registerSource,
  readSources,
  type SourceRow as StoredSource,
  type AssignmentRow as StoredAssignment,
} from "./sources.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

/** Only explicit registration may create state. Connections never leave this owner. */
export const DeviceState = {
  checkCompatibility(paths: Paths) {
    return compatibility(paths);
  },
  registerSource(
    paths: Paths,
    checkout: string,
    source: StoredSource,
    assignments: StoredAssignment[],
  ) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail: "Register the project explicitly before registering a source.",
        });
      using client = openDatabase(paths.database, false);
      return registerSource(client, checkout, source, assignments);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  readSources(paths: Paths, repository: string, sourceId?: string) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail: "Register the project explicitly before reading sources.",
        });
      using client = openDatabase(paths.database, true);
      return readSources(client, repository, sourceId);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
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
