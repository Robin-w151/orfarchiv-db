import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { TargetError } from '../shared/error';
import { Sync } from '../services/sync';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

export const syncCommand = Command.make(
  'sync',
  {
    from: Flag.string('from').pipe(Flag.withDescription('Label of the target to copy from')),
    to: Flag.string('to').pipe(Flag.withDescription('Label of the target to copy into')),
    since: Flag.date('since').pipe(
      Flag.optional,
      Flag.withDescription('Only copy stories with a timestamp at or after this ISO date'),
    ),
    batchSize: Flag.integer('batch-size').pipe(
      Flag.withDefault(1000),
      Flag.withDescription('Documents per bulk write (default: 1000)'),
    ),
    dryRun: Flag.boolean('dry-run').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Count the stories that would be copied without writing'),
    ),
  },
  ({ from, to, since, batchSize, dryRun }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      if (Option.isSome(target)) {
        return yield* new TargetError({ message: 'sync does not support --target, use --from and --to.' });
      }

      const targetsService = yield* Targets;
      const [fromTarget] = yield* targetsService.select(Option.some(from));
      const [toTarget] = yield* targetsService.select(Option.some(to));
      const sync = yield* Sync;
      yield* sync.sync({ from: fromTarget, to: toTarget, since: Option.getOrUndefined(since), dryRun, batchSize });
    }),
).pipe(
  Command.withDescription('Upsert all news including embeddings from one target into another'),
  Command.withExamples([
    {
      command: 'db sync --from orfarchiv-db-1 --to orfarchiv-db-2 --dry-run',
      description: 'Count the stories that would be copied',
    },
    { command: 'db sync --from orfarchiv-db-1 --to orfarchiv-db-2', description: 'Copy every story' },
    {
      command: 'db sync --from orfarchiv-db-1 --to orfarchiv-db-2 --since 2026-01-01T00:00:00Z',
      description: 'Copy only stories published since 2026-01-01',
    },
  ]),
);
