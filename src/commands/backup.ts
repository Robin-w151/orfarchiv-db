import { Cron, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Backup } from '../services/backup';
import { Targets } from '../services/targets';
import { dbCommand } from './db';

export const backupCommand = Command.make(
  'backup',
  {
    keepRunning: Flag.boolean('keep-running').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Keep running until interrupted'),
    ),
    cron: Flag.string('cron').pipe(
      Flag.withDefault('0 0 3 * * *'),
      Flag.mapTryCatch(
        (cron) => Cron.parseUnsafe(cron),
        (error) => `a valid cron expression (${error instanceof Error ? error.message : error})`,
      ),
      Flag.withDescription('Interval in cron syntax (default: 0 0 3 * * *, e.g. backup every day at 3am)'),
    ),
  },
  ({ keepRunning, cron }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const backup = yield* Backup;
      yield* keepRunning ? backup.scheduleBackups(cron, targets) : backup.createBackup(targets);
    }),
).pipe(
  Command.withDescription('Export all news of each target to a JSON file in ORFARCHIV_BACKUP_DIR/<label>'),
  Command.withExamples([
    { command: 'db backup', description: 'Create a single backup of every target' },
    { command: 'db backup --target localhost:27017', description: 'Create a single backup of one target' },
    { command: 'db backup --keep-running --cron "0 0 3 * * *"', description: 'Create a backup every day at 3am' },
  ]),
);
