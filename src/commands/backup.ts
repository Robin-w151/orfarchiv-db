import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Backup } from '../services/backup';
import { Targets } from '../services/targets';
import { parseDiskLimit } from '../shared/disk';
import { dbCommand } from './db';
import { cronFlag, keepRunningFlag } from './flags';

const countFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.filter(
      (count) => count >= 1,
      () => `--${name} must be at least 1`,
    ),
    Flag.optional,
    Flag.withDescription(description),
  );

export const backupCommand = Command.make(
  'backup',
  {
    keepRunning: keepRunningFlag,
    cron: cronFlag('0 0 3 * * *', 'e.g. backup every day at 3am'),
    keepDaily: countFlag('keep-daily', 'Keep the newest backup of each of the newest n days per target'),
    keepMonthly: countFlag('keep-monthly', 'Keep the newest backup of each of the newest n months per target'),
    diskPaths: Flag.String('disk-path').pipe(
      Flag.atLeast(0),
      Flag.withDescription('Check the disk usage of this path after each backup (repeatable, default: backup dir)'),
    ),
    diskMaxUsage: Flag.String('disk-max-usage').pipe(
      Flag.withDefault('80%'),
      Flag.mapTryCatch(parseDiskLimit, (error) => (error instanceof Error ? error.message : String(error))),
      Flag.withDescription('Notify when a disk path reaches this usage, e.g. 80% or 60GiB (default: 80%)'),
    ),
  },
  ({ keepRunning, cron, keepDaily, keepMonthly, diskPaths, diskMaxUsage }) =>
    Effect.gen(function* () {
      const { target } = yield* dbCommand;
      const targetsService = yield* Targets;
      const targets = yield* targetsService.select(target);
      const backup = yield* Backup;
      const options = {
        retention:
          Option.isSome(keepDaily) || Option.isSome(keepMonthly)
            ? { keepDaily: Option.getOrElse(keepDaily, () => 0), keepMonthly: Option.getOrElse(keepMonthly, () => 0) }
            : undefined,
        diskPaths,
        diskMaxUsage,
      };
      yield* keepRunning ? backup.scheduleBackups(cron, targets, options) : backup.createBackup(targets, options);
    }),
).pipe(
  Command.withDescription('Export all news of each target to a JSON file in ORFARCHIV_BACKUP_DIR/<label>'),
  Command.withExamples([
    { command: 'db backup', description: 'Create a single backup of every target' },
    { command: 'db backup --target localhost:27017', description: 'Create a single backup of one target' },
    { command: 'db backup --keep-running --cron "0 0 3 * * *"', description: 'Create a backup every day at 3am' },
    {
      command: 'db backup --keep-daily 7 --keep-monthly 12',
      description: 'Create a backup, then prune all but 7 daily and 12 monthly backups per target',
    },
    {
      command: 'db backup --disk-path /app/backup --disk-path /data/db --disk-max-usage 60GiB',
      description: 'Create a backup, then notify if either path has 60 GiB or more in use',
    },
  ]),
);
