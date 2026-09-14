import { Cron, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Backup } from '../services/backup';

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
      const backup = yield* Backup;
      yield* keepRunning ? backup.scheduleBackups(cron) : backup.createBackup();
    }),
).pipe(
  Command.withDescription('Export all news to a JSON file in ORFARCHIV_BACKUP_DIR'),
  Command.withExamples([
    { command: 'db backup', description: 'Create a single backup' },
    { command: 'db backup --keep-running --cron "0 0 3 * * *"', description: 'Create a backup every day at 3am' },
  ]),
);
