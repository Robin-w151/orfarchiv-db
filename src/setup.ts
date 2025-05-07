import { NodeRuntime } from '@effect/platform-node';
import { Effect, pipe } from 'effect';
import { MongoClient, type IndexDescription } from 'mongodb';
import { dbConnectionUrl } from './shared/env.ts';
import { DatabaseError } from './shared/error.ts';
import { loggerLayer } from './shared/logger.ts';

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
    yield* Effect.log('Connecting to server...');
    const url = yield* dbConnectionUrl();

    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => {
          return MongoClient.connect(url);
        },
        catch: (error) => {
          return new DatabaseError({ message: 'Connection to DB failed.', cause: error });
        },
      }),
      (client) => setupDb(client),
      (client) => Effect.promise(() => client.close()),
    );

    yield* Effect.log('Done.');
  });
}

function setupDb(client: MongoClient): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* Effect.log('Creating orfarchiv DB...');

    const db = client.db('orfarchiv');
    const collections = yield* Effect.tryPromise({
      try: () => db.collections(),
      catch: (error) => new DatabaseError({ message: 'Failed to fetch collections.', cause: error }),
    });

    if (!collections.find((collection) => collection.collectionName === 'news')) {
      yield* Effect.log('Creating news collection...');

      yield* Effect.tryPromise({
        try: () => db.createCollection('news'),
        catch: (error) => new DatabaseError({ message: 'Failed to create news collection.', cause: error }),
      });

      const news = db.collection('news');
      yield* Effect.tryPromise({
        try: () =>
          news.createIndexes([
            {
              key: { id: 1 },
              name: 'id_asc',
            },
            {
              key: { id: -1 },
              name: 'id_desc',
            },
            {
              key: { timestamp: 1 },
              name: 'timestamp_asc',
            },
            {
              key: { timestamp: -1 },
              name: 'timestamp_desc',
            },
          ] as IndexDescription[]),
        catch: (error) => new DatabaseError({ message: 'Failed to create news collection indexes.', cause: error }),
      });
    }
  });
}
