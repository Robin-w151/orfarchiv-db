import { NodeRuntime } from '@effect/platform-node';
import { Effect, pipe } from 'effect';
import { MongoClient, type Collection, type IndexDescription, type SearchIndexDescription } from 'mongodb';
import { dbConnectionUrl } from './shared/env.ts';
import { DatabaseError } from './shared/error.ts';
import { loggerLayer } from './shared/logger.ts';
import { NEWS_TITLE_VECTOR_INDEX, TITLE_EMBEDDING_DIMENSIONS } from './shared/search.ts';

type NamedSearchIndexDescription = SearchIndexDescription & { name: string };

const indexes: IndexDescription[] = [
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
  {
    key: { timestamp: -1, id: -1 },
    name: 'timestamp_id_desc',
  },
  {
    key: { category: 1 },
    name: 'category_asc',
  },
];

const searchIndexes: NamedSearchIndexDescription[] = [
  {
    name: NEWS_TITLE_VECTOR_INDEX,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'titleEmbedding',
          numDimensions: TITLE_EMBEDDING_DIMENSIONS,
          similarity: 'cosine',
        },
        { type: 'filter', path: 'timestamp' },
        { type: 'filter', path: 'source' },
        { type: 'filter', path: 'category' },
      ],
    },
  },
];

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

    if (!collections.some((collection) => collection.collectionName === 'news')) {
      yield* Effect.log('Creating news collection...');

      yield* Effect.tryPromise({
        try: () => db.createCollection('news'),
        catch: (error) => new DatabaseError({ message: 'Failed to create news collection.', cause: error }),
      });
    }

    const news = db.collection('news');

    yield* Effect.log('Reconciling indexes...');
    yield* Effect.tryPromise({
      try: () => news.createIndexes(indexes),
      catch: (error) => new DatabaseError({ message: 'Failed to create news collection indexes.', cause: error }),
    });

    yield* Effect.log('Reconciling search indexes...');
    yield* createSearchIndexes(news);
  });
}

function createSearchIndexes(news: Collection): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const existing = yield* Effect.tryPromise({
      try: () => news.listSearchIndexes().toArray(),
      catch: (error) => new DatabaseError({ message: 'Failed to list search indexes.', cause: error }),
    });
    const existingNames = new Set(existing.map((index) => index.name));

    for (const searchIndex of searchIndexes) {
      if (existingNames.has(searchIndex.name)) {
        yield* Effect.log(`Search index '${searchIndex.name}' already exists.`);
        continue;
      }

      yield* Effect.log(`Creating search index '${searchIndex.name}'...`);
      yield* Effect.tryPromise({
        try: () => news.createSearchIndex(searchIndex),
        catch: (error) =>
          new DatabaseError({ message: `Failed to create search index '${searchIndex.name}'.`, cause: error }),
      });
    }
  });
}
