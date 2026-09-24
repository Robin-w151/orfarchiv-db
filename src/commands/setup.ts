import { Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Setup } from '../services/setup';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

export const setupCommand = Command.make(
  'setup',
  {
    recreateSearchIndexes: Flag.boolean('recreate-search-indexes').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Drop and recreate search indexes whose definition changed'),
    ),
  },
  ({ recreateSearchIndexes }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const setup = yield* Setup;
      yield* setup.setup(targets, { recreateSearchIndexes });
    }),
).pipe(Command.withDescription('Create the orfarchiv database, news collection and indexes on all targets'));
