import { Duration, Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Setup } from '../services/setup';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

const DEFAULT_WAIT_TIMEOUT = '30 minutes';

export const setupCommand = Command.make(
  'setup',
  {
    recreateSearchIndexes: Flag.Boolean('recreate-search-indexes').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Drop and recreate search indexes whose definition changed'),
    ),
    waitUntilQueryable: Flag.Boolean('wait-until-queryable').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Wait until created or recreated search indexes are queryable'),
    ),
    waitTimeout: Flag.String('wait-timeout').pipe(
      Flag.withDefault(DEFAULT_WAIT_TIMEOUT),
      Flag.mapTryCatch(
        (input) => Duration.fromInputUnsafe(input as Duration.Input),
        (error) => `a valid duration, e.g. '30 minutes' (${error instanceof Error ? error.message : error})`,
      ),
      Flag.withDescription(
        `Maximum time to wait for a search index with --wait-until-queryable (default: ${DEFAULT_WAIT_TIMEOUT})`,
      ),
    ),
  },
  ({ recreateSearchIndexes, waitUntilQueryable, waitTimeout }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const setup = yield* Setup;
      yield* setup.setup(targets, { recreateSearchIndexes, waitUntilQueryable, waitTimeout });
    }),
).pipe(Command.withDescription('Create the orfarchiv database, news collection and indexes on all targets'));
