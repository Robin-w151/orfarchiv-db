import type { Target } from '#common/targets';
import { NodeFileSystem } from '@effect/platform-node';
import { Context, Cron, Duration, Effect, FileSystem, Layer, Result, Schedule, Sink, Stream } from 'effect';
import { join } from 'node:path';
import { BackupError, formatError, IOError } from '../shared/error';
import { Database } from './database';
import { Environment } from './env';

const BACKUP_TIMEOUT = Duration.minutes(5);
const WRITE_BATCH_SIZE = 1000;

export class Backup extends Context.Service<Backup>()('Backup', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    const database = yield* Database;
    const fs = yield* FileSystem.FileSystem;
    return defineService({ environment, database, fs });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Database.layer),
    Layer.provide(Environment.layer),
    Layer.provide(NodeFileSystem.layer),
  );
}

function defineService({
  environment,
  database,
  fs,
}: {
  environment: typeof Environment.Service;
  database: typeof Database.Service;
  fs: FileSystem.FileSystem;
}) {
  function createBackup(targets: ReadonlyArray<Target>) {
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
              yield* Effect.logError(`Backup of '${target.label}' failed: ${formatError(result.failure)}`);
            }

            return result;
          }),
        { concurrency: 'unbounded' },
      );

      if (results.every(Result.isFailure)) {
        return yield* new BackupError({ message: `All ${targets.length} backup targets failed.` });
      }
    });
  }

  function scheduleBackups(cron: Cron.Cron, targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      const schedule = Schedule.cron(cron);
      yield* Effect.schedule(
        createBackup(targets).pipe(Effect.catchTag('BackupError', (error) => Effect.logWarning(error.message))),
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
