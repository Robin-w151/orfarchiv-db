import { NodeFileSystem } from '@effect/platform-node';
import { Context, Effect, FileSystem, Layer } from 'effect';
import type { Document } from 'mongodb';
import { extname, join } from 'node:path';
import { IOError } from '../shared/error';
import { Database, type DatabaseConnection } from './database';
import { Environment } from './env';

export interface RestoreOptions {
  readonly file?: string;
  readonly batchSize: number;
  readonly dryRun: boolean;
}

export class Restore extends Context.Service<Restore>()('Restore', {
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
  function restore({ file, batchSize, dryRun }: RestoreOptions) {
    return Effect.gen(function* () {
      const backupFile = file ?? (yield* latestBackupFile());
      yield* Effect.log(`Reading backup file ${backupFile}...`);

      const stories = yield* readStories(backupFile);
      yield* Effect.log(`Found ${stories.length} stories.`);

      if (dryRun) {
        yield* Effect.log('Dry run, nothing written.');
        return;
      }

      const connection = yield* database.connect();
      yield* writeStories(connection, stories, batchSize);
      yield* Effect.log('Done.');
    }).pipe(Effect.scoped);
  }

  function latestBackupFile() {
    return Effect.gen(function* () {
      const dir = yield* environment.backupDir;
      const files = yield* fs
        .readDirectory(dir)
        .pipe(
          Effect.mapError(
            (error) => new IOError({ message: `Failed to read backup directory '${dir}'.`, cause: error }),
          ),
        );

      const backups = files.filter((file) => extname(file) === '.json').toSorted((f1, f2) => f1.localeCompare(f2));
      const latest = backups.at(-1);
      if (!latest) {
        return yield* new IOError({ message: `No backup files found in '${dir}'.`, cause: undefined });
      }

      return join(dir, latest);
    });
  }

  function readStories(file: string) {
    return Effect.gen(function* () {
      const content = yield* fs
        .readFileString(file)
        .pipe(
          Effect.mapError((error) => new IOError({ message: `Failed to read backup file '${file}'.`, cause: error })),
        );

      const parsed = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: (error) => new IOError({ message: `Backup file '${file}' is not valid JSON.`, cause: error }),
      });

      if (!Array.isArray(parsed)) {
        return yield* new IOError({ message: `Backup file '${file}' does not contain an array.`, cause: undefined });
      }

      return parsed as Array<Document>;
    });
  }

  function writeStories(connection: DatabaseConnection, stories: Array<Document>, batchSize: number) {
    return Effect.gen(function* () {
      const size = Math.max(1, batchSize);

      for (let index = 0; index < stories.length; index += size) {
        yield* connection.upsertNews(stories.slice(index, index + size));
        yield* Effect.log(`Imported ${Math.min(index + size, stories.length)}/${stories.length} stories.`);
      }
    });
  }

  return {
    restore,
  };
}
