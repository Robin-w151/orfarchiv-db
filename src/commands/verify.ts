import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { Targets } from '../services/targets';
import { Verify } from '../services/verify';
import { dbCommand } from './db';
import { cronFlag, keepRunningFlag } from './flags';

export const verifyCommand = Command.make(
  'verify',
  {
    keepRunning: keepRunningFlag,
    cron: cronFlag('45 2 4 * * *', 'e.g. verify every day at 04:02:45'),
  },
  ({ keepRunning, cron }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const verify = yield* Verify;
      yield* keepRunning ? verify.scheduleVerify(cron, targets) : verify.verify(targets);
    }),
).pipe(
  Command.withDescription(
    'Check that every target has the same news, embeddings and indexes; exits 1 on divergence, or notifies when kept running',
  ),
  Command.withExamples([
    { command: 'db verify', description: 'Compare every target against the first one' },
    { command: 'db verify --target orfarchiv-db-2', description: 'Only check the indexes of one target' },
    {
      command: 'db verify --keep-running --cron "45 2 4 * * *"',
      description: 'Verify every day at 04:02:45, retry once and notify on failure',
    },
  ]),
);
