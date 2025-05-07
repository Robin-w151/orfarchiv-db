import { NodeRuntime } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Cron, Duration, Effect, pipe, Schedule } from 'effect';
import type { TimeoutException } from 'effect/Cause';
import { mkdir, writeFile } from 'fs/promises';
import meow from 'meow';
import { Collection, MongoClient, type WithId } from 'mongodb';
import { join } from 'path';
import { backupDir, dbConnectionUrl } from './shared/env.ts';
import { DatabaseError, IOError } from './shared/error.ts';
import { loggerLayer } from './shared/logger.ts';

dotenv.config({ silent: true });

pipe(
  Effect.matchEffect(main(), {
    onSuccess: () => Effect.void,
    onFailure: (error) =>
      Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`),
  }),
  Effect.provide(loggerLayer),
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);

function main(): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const cli = yield* parseArgs();
    const { keepRunning, cron } = cli.flags;

    if (keepRunning) {
      const schedule = Schedule.cron(Cron.unsafeParse(cron));
      yield* Effect.schedule(
        run().pipe(Effect.catchTag('TimeoutException', () => Effect.logWarning('Scheduled task ran into a timeout'))),
        schedule,
      );
    } else {
      yield* run();
    }
  });
}

function parseArgs() {
  return Effect.try(() =>
    meow(
      `
    Usage
      $ db-backup

    Options
      --keep-running  Keep running until interrupted
      --cron          Interval in cron syntax (default: 0 0 3 * * *, e.g. backup every day at 3am)

    Examples
      $ db-backup
      $ db-backup --keep-running --cron "0 0 3 * * *"
    `,
      {
        importMeta: import.meta,
        flags: {
          keepRunning: {
            type: 'boolean',
            default: false,
          },
          cron: {
            type: 'string',
            default: '0 0 3 * * *',
          },
        },
      },
    ),
  );
}

function run(): Effect.Effect<void, DatabaseError | IOError | TimeoutException> {
  return exportNews().pipe(Effect.timeout(Duration.minutes(5)));
}

function exportNews(): Effect.Effect<void, DatabaseError | IOError> {
  return Effect.gen(function* () {
    yield* Effect.log('Fetching data...');
    const news = yield* withOrfArchivDb((newsCollection) =>
      Effect.tryPromise({
        try: () => newsCollection.find().sort({ timestamp: -1 }).toArray(),
        catch: (error) => new DatabaseError({ message: 'Failed to fetch data.', cause: error }),
      }),
    );

    yield* Effect.log('Persisting data to backup file...');
    const timestamp = getTimestamp();
    const backupPath = yield* backupDir();
    const backupFilePath = join(backupPath, `${timestamp}.json`);

    yield* Effect.tryPromise({
      try: () => mkdir(backupPath, { recursive: true }),
      catch: (error) => new IOError({ message: 'Failed to create backup directory.', cause: error }),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(backupFilePath, JSON.stringify(news), { flag: 'w' }),
      catch: (error) => new IOError({ message: 'Failed to write backup file.', cause: error }),
    });

    yield* Effect.log(`Backup file ${backupFilePath} created.`);
  });
}

function withOrfArchivDb(
  handler: (newsCollection: Collection<Document>) => Effect.Effect<WithId<Document>[], DatabaseError>,
): Effect.Effect<WithId<Document>[], DatabaseError> {
  return Effect.gen(function* () {
    yield* Effect.log('Connecting to DB...');
    const url = yield* dbConnectionUrl();

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const client = await MongoClient.connect(url);
          const db = client.db('orfarchiv');
          const newsCollection: Collection<Document> = db.collection('news');
          return { client, newsCollection };
        },
        catch: (error) => {
          return new DatabaseError({ message: 'Failed to connect to DB.', cause: error });
        },
      }),
      ({ newsCollection }) => handler(newsCollection),
      ({ client }) => Effect.promise(() => client.close()),
    );
  });
}

function getTimestamp(): string {
  const now = new Date();
  const nowString = now.toISOString();
  return nowString.replaceAll(':', '').split('.')[0] + 'Z';
}
