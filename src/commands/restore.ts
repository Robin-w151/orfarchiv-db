import { Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { Restore } from '../services/restore';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

export const restoreCommand = Command.make(
  'restore',
  {
    file: Argument.string('file').pipe(
      Argument.withDescription('Backup JSON file (default: newest *.json in ORFARCHIV_BACKUP_DIR/<label>)'),
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
    all: Flag.boolean('all').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Restore to all targets instead of only the first one'),
    ),
  },
  ({ file, batchSize, dryRun, all }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const restore = yield* Restore;
      yield* restore.restore({
        file: Option.getOrUndefined(file),
        batchSize,
        dryRun,
        targets: all ? targets : targets.slice(0, 1),
      });
    }),
).pipe(
  Command.withDescription('Upsert news from a backup JSON file into the first target'),
  Command.withExamples([
    { command: 'db restore', description: 'Restore the newest backup of the first target' },
    { command: 'db restore --all', description: 'Restore the newest backup of every target' },
    {
      command: 'db restore --target localhost:27017 --dry-run',
      description: 'Check the newest backup of one target without writing',
    },
    {
      command: 'db restore ./backup/2026-08-29T120000Z.json --batch-size 500',
      description: 'Restore a specific backup in batches of 500',
    },
  ]),
);
