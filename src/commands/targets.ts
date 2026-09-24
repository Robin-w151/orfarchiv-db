import { Effect, Option } from 'effect';
import { Command } from 'effect/unstable/cli';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

export const targetsCommand = Command.make('targets', {}, () =>
  Effect.gen(function* () {
    const { target } = yield* dbCommand;
    const targetsService = yield* Targets;
    const allTargets = yield* targetsService.select(Option.none());
    const selected = yield* targetsService.select(target);
    for (const [index, { label }] of allTargets.entries()) {
      if (selected.some((selectedTarget) => selectedTarget.label === label)) {
        yield* Effect.log(`${index + 1}. ${label}`);
      }
    }
  }),
).pipe(Command.withDescription('List the labels of all configured database targets in priority order'));
