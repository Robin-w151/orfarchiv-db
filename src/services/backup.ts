import type { Target } from '#common/targets';
import { NodeFileSystem } from '@effect/platform-node';
import { ByteSize, Context, Cron, Duration, Effect, FileSystem, Layer, Result, Schedule, Sink, Stream } from 'effect';
import { join } from 'node:path';
import {
  diskUsage,
  exceedsDiskLimit,
  formatBytes,
  formatDiskLimit,
  formatDiskUsage,
  type DiskLimit,
} from '../shared/disk';
import { BackupError, formatDefect, formatError, IOError } from '../shared/error';
import { selectBackupsToPrune, type RetentionPolicy } from '../shared/retention';
import { Database } from './database';
import { Environment } from './env';
import { logNotificationState, Notifier } from './notifier';

const BACKUP_TIMEOUT = Duration.minutes(15);
const WRITE_BATCH_SIZE = 1000;

export interface BackupOptions {
  readonly retention?: RetentionPolicy;
  readonly diskPaths: ReadonlyArray<string>;
  readonly diskMaxUsage: DiskLimit;
}

export class Backup extends Context.Service<Backup>()('Backup', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const database = yield* Database;
    const fs = yield* FileSystem.FileSystem;
    const notifier = yield* Notifier;
    return defineService({ environment, database, fs, notifier });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Database.layer),
    Layer.provide(Environment.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(Notifier.layer),
  );
}

function defineService({
  environment,
  database,
  fs,
  notifier,
}: {
  environment: typeof Environment.Service;
  database: typeof Database.Service;
  fs: FileSystem.FileSystem;
  notifier: typeof Notifier.Service;
}) {
  function createBackup(targets: ReadonlyArray<Target>, options: BackupOptions) {
    return Effect.gen(function* () {
      const results = yield* Effect.forEach(
        targets,
        (target) =>
          Effect.gen(function* () {
            const result = yield* backupTarget(target).pipe(
              Effect.timeoutOrElse({
                duration: BACKUP_TIMEOUT,
                orElse: () =>
                  Effect.fail(new BackupError({ message: `Timed out after ${Duration.format(BACKUP_TIMEOUT)}.` })),
              }),
              Effect.result,
            );

            if (Result.isFailure(result)) {
              const message = `Backup of '${target.label}' failed: ${formatError(result.failure)}`;
              yield* Effect.logError(message);
              yield* notifier.notify(`🔴 orfarchiv ${message}`);
            } else if (options.retention) {
              yield* pruneBackups(target, options.retention);
            }

            return result;
          }),
        { concurrency: 'unbounded' },
      );

      yield* checkDisk(options);

      if (results.every(Result.isFailure)) {
        return yield* new BackupError({ message: `All ${targets.length} backup targets failed.` });
      }
    });
  }

  function scheduleBackups(cron: Cron.Cron, targets: ReadonlyArray<Target>, options: BackupOptions) {
    return Effect.gen(function* () {
      yield* logNotificationState(notifier);
      const schedule = Schedule.cron(cron);
      yield* Effect.schedule(
        createBackup(targets, options).pipe(
          Effect.catchTag('BackupError', (error) => Effect.logWarning(error.message)),
          Effect.catchDefect((defect) =>
            Effect.gen(function* () {
              yield* Effect.logError(`Backup crashed: ${formatDefect(defect, { withStack: true })}`);
              yield* notifier.notify(`🔴 orfarchiv backup crashed\n${formatDefect(defect)}`);
            }),
          ),
        ),
        schedule,
      );
    });
  }

  function backupTarget(target: Target) {
    return Effect.gen(function* () {
      const backupPath = join(yield* environment.backupDir, target.label);
      const backupFilePath = join(backupPath, `${getTimestamp()}.json`);
      const partialFilePath = `${backupFilePath}.partial`;

      yield* Effect.log(`[${target.label}] Connecting to DB...`);
      const connection = yield* database.connect(target);

      yield* fs
        .makeDirectory(backupPath, { recursive: true })
        .pipe(Effect.mapError((error) => new IOError({ message: 'Failed to create backup directory.', cause: error })));

      yield* Effect.log(`[${target.label}] Streaming data to backup file...`);
      yield* Stream.make('[').pipe(
        Stream.concat(
          connection.streamAllNews().pipe(
            Stream.zipWithIndex,
            Stream.map(([story, index]) => (index === 0 ? '' : ',') + JSON.stringify(story)),
          ),
        ),
        Stream.concat(Stream.make(']')),
        Stream.grouped(WRITE_BATCH_SIZE),
        Stream.map((parts) => parts.join('')),
        Stream.encodeText,
        Stream.run(
          fs
            .sink(partialFilePath)
            .pipe(Sink.mapError((error) => new IOError({ message: 'Failed to write backup file.', cause: error }))),
        ),
        Effect.onError(() => fs.remove(partialFilePath).pipe(Effect.ignore)),
      );

      yield* fs
        .rename(partialFilePath, backupFilePath)
        .pipe(Effect.mapError((error) => new IOError({ message: 'Failed to finalize backup file.', cause: error })));

      yield* Effect.log(`[${target.label}] Backup file ${backupFilePath} created.`);
    }).pipe(Effect.scoped);
  }

  function pruneBackups(target: Target, retention: RetentionPolicy) {
    return Effect.gen(function* () {
      const backupPath = join(yield* environment.backupDir, target.label);
      const fileNames = yield* fs.readDirectory(backupPath);
      const prunable = selectBackupsToPrune(fileNames, retention);
      yield* Effect.forEach(
        prunable,
        (fileName) =>
          fs
            .remove(join(backupPath, fileName))
            .pipe(Effect.andThen(Effect.log(`[${target.label}] Pruned backup file ${fileName}.`))),
        { concurrency: 'unbounded', discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = `Pruning backups of '${target.label}' failed: ${formatError(error)}`;
          yield* Effect.logError(message);
          yield* notifier.notify(`🔴 orfarchiv ${message}`);
        }),
      ),
    );
  }

  function checkDisk(options: BackupOptions) {
    return Effect.gen(function* () {
      const backupDir = yield* environment.backupDir;
      const paths = options.diskPaths.length > 0 ? options.diskPaths : [backupDir];
      const results = yield* Effect.forEach(paths, (path) =>
        Effect.tryPromise({
          try: () => diskUsage(path),
          catch: (error) => new IOError({ message: `Failed to read disk usage of '${path}'.`, cause: error }),
        }).pipe(Effect.result),
      );
      const usages = results.filter(Result.isSuccess).map((result) => result.success);
      const unreadable = results.flatMap((result, index) => (Result.isFailure(result) ? [paths[index]] : []));
      const backupSizes = yield* backupSizesPerLabel(backupDir).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Failed to read backup sizes: ${formatError(error)}`).pipe(
            Effect.as<ReadonlyArray<[string, ByteSize.ByteSize]>>([]),
          ),
        ),
      );

      const usageSummaries = [
        ...usages.map(formatDiskUsage),
        ...unreadable.map((path) => `${path}: unreadable`),
        ...backupSizes.map(([label, size]) => `${join(backupDir, label)}: ${formatBytes(size)} of backups`),
      ];
      yield* Effect.forEach(usageSummaries, (summary) => Effect.log(`Disk usage ${summary}`), { discard: true });

      for (const result of results) {
        if (Result.isFailure(result)) {
          const message = `Disk check failed: ${formatError(result.failure)}`;
          yield* Effect.logError(message);
          yield* notifier.notify(`🔴 orfarchiv ${message}`);
        }
      }

      const exceeded = usages.filter((usage) => exceedsDiskLimit(usage, options.diskMaxUsage));
      if (exceeded.length > 0) {
        const limit = formatDiskLimit(options.diskMaxUsage);
        yield* Effect.logWarning(
          `Disk usage limit ${limit} reached on ${exceeded.map((usage) => `'${usage.path}'`).join(', ')}.`,
        );
        yield* notifier.notify([`🟠 orfarchiv disk usage limit ${limit} reached`, ...usageSummaries].join('\n'));
      }
    });
  }

  function backupSizesPerLabel(backupDir: string) {
    return Effect.gen(function* () {
      const sizes: Array<[string, ByteSize.ByteSize]> = [];
      for (const label of yield* fs.readDirectory(backupDir)) {
        const labelPath = join(backupDir, label);
        if ((yield* fs.stat(labelPath)).type !== 'Directory') {
          continue;
        }

        let size = ByteSize.zero;
        for (const fileName of yield* fs.readDirectory(labelPath)) {
          size = ByteSize.sum(size, (yield* fs.stat(join(labelPath, fileName))).size);
        }
        sizes.push([label, size]);
      }
      return sizes;
    });
  }

  return {
    createBackup,
    scheduleBackups,
  };
}

function getTimestamp(): string {
  const now = new Date();
  const nowString = now.toISOString();
  return nowString.replaceAll(':', '').split('.')[0] + 'Z';
}
