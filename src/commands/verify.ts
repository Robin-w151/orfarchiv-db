import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { Targets } from '../services/targets';
import { Verify } from '../services/verify';
import { dbCommand } from './db';

export const verifyCommand = Command.make('verify', {}, () =>
  Effect.gen(function* () {
    const { target } = yield* dbCommand;
    const targetsService = yield* Targets;
    const targets = yield* targetsService.select(target);
    const verify = yield* Verify;
    yield* verify.verify(targets);
  }),
).pipe(
  Command.withDescription('Check that every target has the same news, embeddings and indexes; exits 1 on divergence'),
  Command.withExamples([
    { command: 'db verify', description: 'Compare every target against the first one' },
    { command: 'db verify --target orfarchiv-db-2', description: 'Only check the indexes of one target' },
  ]),
);
