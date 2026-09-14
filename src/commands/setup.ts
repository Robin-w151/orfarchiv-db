import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { Setup } from '../services/setup';

export const setupCommand = Command.make('setup', {}, () =>
  Effect.gen(function* () {
    const setup = yield* Setup;
    yield* setup.setup();
  }),
).pipe(Command.withDescription('Create the orfarchiv database, news collection and indexes'));
