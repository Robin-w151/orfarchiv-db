import { NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Effect, pipe } from 'effect';
import meow from 'meow';
import { Collection, MongoClient, type AnyBulkWriteOperation, type Document } from 'mongodb';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { backupDir, dbConnectionUrl } from './shared/env.ts';
import { DatabaseError, IOError } from './shared/error.ts';
import { loggerLayer } from './shared/logger.ts';

dotenv.config({ silent: true });

const STORY_FIELDS = ['id', 'title', 'category', 'url', 'timestamp', 'source'] as const;

pipe(
  Effect.matchEffect(main(), {
    onSuccess: () => Effect.void,
    onFailure: (error) =>
      Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`),
  }),
  Effect.provide(loggerLayer),
  NodeRuntime.runMain,
);

function main(): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const cli = yield* parseArgs();
    const { batchSize, dryRun } = cli.flags;

    const file = cli.input[0] ? cli.input[0] : yield* latestBackupFile();
    yield* Effect.log(`Reading backup file ${file}...`);

    const stories = yield* readStories(file);
    yield* Effect.log(`Found ${stories.length} stories.`);

    if (dryRun) {
      yield* Effect.log('Dry run, nothing written.');
      return;
    }

    yield* importStories(stories, batchSize);
    yield* Effect.log('Done.');
  });
}

function parseArgs() {
  return Effect.try(() =>
    meow(
      `
    Usage
      $ db-restore [file]

    Arguments
      file            Backup JSON file (default: newest *.json in ORFARCHIV_BACKUP_DIR)

    Options
      --batch-size    Documents per bulk write (default: 1000)
      --dry-run       Parse and report without writing

    Examples
      $ db-restore
      $ db-restore ./backup/2026-08-29T120000Z.json --batch-size 500
    `,
      {
        importMeta: import.meta,
        flags: {
          batchSize: {
            type: 'number',
            default: 1000,
          },
          dryRun: {
            type: 'boolean',
            default: false,
          },
        },
      },
    ),
  );
}

function latestBackupFile(): Effect.Effect<string, IOError> {
  return Effect.gen(function* () {
    const dir = yield* backupDir();
    const files = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: (error) => new IOError({ message: `Failed to read backup directory '${dir}'.`, cause: error }),
    });

    const backups = files.filter((file) => extname(file) === '.json').toSorted((f1, f2) => f1.localeCompare(f2));
    const latest = backups.at(-1);
    if (!latest) {
      return yield* new IOError({ message: `No backup files found in '${dir}'.`, cause: undefined });
    }

    return join(dir, latest);
  });
}

function readStories(file: string): Effect.Effect<Array<Document>, IOError> {
  return Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(file, 'utf8'),
      catch: (error) => new IOError({ message: `Failed to read backup file '${file}'.`, cause: error }),
    });

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

function importStories(stories: Array<Document>, batchSize: number): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const url = yield* dbConnectionUrl();

    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => MongoClient.connect(url),
        catch: (error) => new DatabaseError({ message: 'Connection to DB failed.', cause: error }),
      }),
      (client) => writeStories(client.db('orfarchiv').collection('news'), stories, batchSize),
      (client) => Effect.promise(() => client.close()),
    );
  });
}

function writeStories(
  news: Collection,
  stories: Array<Document>,
  batchSize: number,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const size = Math.max(1, batchSize);

    for (let index = 0; index < stories.length; index += size) {
      const batch = stories
        .slice(index, index + size)
        .map(toUpsert)
        .filter((operation) => !!operation);

      if (batch.length > 0) {
        yield* Effect.tryPromise({
          try: () => news.bulkWrite(batch, { ordered: false }),
          catch: (error) => new DatabaseError({ message: 'Failed to write stories.', cause: error }),
        });
      }

      yield* Effect.log(`Imported ${Math.min(index + size, stories.length)}/${stories.length} stories.`);
    }
  });
}

function toUpsert(story: Document): AnyBulkWriteOperation | undefined {
  if (typeof story.id !== 'string') {
    return undefined;
  }

  const update: Document = {};
  for (const field of STORY_FIELDS) {
    if (story[field] !== undefined) {
      update[field] = field === 'timestamp' ? new Date(story[field] as string) : story[field];
    }
  }

  return {
    updateOne: {
      filter: { id: story.id },
      update: { $set: update },
      upsert: true,
    },
  };
}
