import { Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { Restore } from '../services/restore';

export const restoreCommand = Command.make(
  'restore',
  {
    file: Argument.string('file').pipe(
      Argument.withDescription('Backup JSON file (default: newest *.json in ORFARCHIV_BACKUP_DIR)'),
      Argument.optional,
    ),
    batchSize: Flag.integer('batch-size').pipe(
      Flag.withDefault(1000),
      Flag.withDescription('Documents per bulk write (default: 1000)'),
    ),
    dryRun: Flag.boolean('dry-run').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Parse and report without writing'),
    ),
  },
  ({ file, batchSize, dryRun }) =>
    Effect.gen(function* () {
      const restore = yield* Restore;
      yield* restore.restore({ file: Option.getOrUndefined(file), batchSize, dryRun });
    }),
).pipe(
  Command.withDescription('Upsert news from a backup JSON file'),
  Command.withExamples([
    { command: 'db restore', description: 'Restore the newest backup' },
    {
      command: 'db restore ./backup/2026-08-29T120000Z.json --batch-size 500',
      description: 'Restore a specific backup in batches of 500',
    },
  ]),
);
