import { NodeFileSystem } from '@effect/platform-node';
import { Context, Cron, Duration, Effect, FileSystem, Layer, Schedule } from 'effect';
import { join } from 'node:path';
import { IOError } from '../shared/error';
import { Database } from './database';
import { Environment } from './env';

const BACKUP_TIMEOUT = Duration.minutes(5);

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
  function createBackup() {
    return exportNews().pipe(Effect.timeout(BACKUP_TIMEOUT));
  }

  function scheduleBackups(cron: Cron.Cron) {
    return Effect.gen(function* () {
      const schedule = Schedule.cron(cron);
      yield* Effect.schedule(
        createBackup().pipe(
          Effect.catchTag('TimeoutError', () => Effect.logWarning('Scheduled task ran into a timeout')),
        ),
        schedule,
      );
    });
  }

  function exportNews() {
    return Effect.gen(function* () {
      const news = yield* fetchNews();

      yield* Effect.log('Persisting data to backup file...');
      const timestamp = getTimestamp();
      const backupPath = yield* environment.backupDir;
      const backupFilePath = join(backupPath, `${timestamp}.json`);

      yield* fs
        .makeDirectory(backupPath, { recursive: true })
        .pipe(Effect.mapError((error) => new IOError({ message: 'Failed to create backup directory.', cause: error })));
      yield* fs
        .writeFileString(backupFilePath, JSON.stringify(news))
        .pipe(Effect.mapError((error) => new IOError({ message: 'Failed to write backup file.', cause: error })));

      yield* Effect.log(`Backup file ${backupFilePath} created.`);
    });
  }

  function fetchNews() {
    return Effect.gen(function* () {
      yield* Effect.log('Fetching data...');
      yield* Effect.log('Connecting to DB...');
      const connection = yield* database.connect();
      return yield* connection.findAllNews();
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
