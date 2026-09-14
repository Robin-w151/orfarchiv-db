import { Context, Effect, Layer } from 'effect';
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type Db,
  type Document,
  type IndexDescription,
  type SearchIndexDescription,
} from 'mongodb';
import { DatabaseError } from '../shared/error';
import { TITLE_EMBEDDING_FIELD } from '#common/search';
import { Environment } from './env';

const DB_NAME = 'orfarchiv';
const NEWS_COLLECTION = 'news';
const STORY_FIELDS = ['id', 'title', 'category', 'url', 'timestamp', 'source'] as const;

export type DatabaseConnection = ReturnType<typeof defineConnection>;

export class Database extends Context.Service<Database>()('Database', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    return defineService({ environment });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Environment.layer));
}

function defineService({ environment }: { environment: typeof Environment.Service }) {
  function connect() {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const url = yield* environment.dbConnectionUrl;
        return yield* Effect.tryPromise({
          try: () => MongoClient.connect(url),
          catch: (error) => new DatabaseError({ message: 'Failed to connect to DB.', cause: error }),
        });
      }),
      (client) => Effect.promise(() => client.close()),
    ).pipe(Effect.map((client) => defineConnection(client.db(DB_NAME))));
  }

  return {
    connect,
  };
}

function defineConnection(db: Db) {
  const news = db.collection(NEWS_COLLECTION);

  function findAllNews() {
    return Effect.tryPromise({
      try: () =>
        news
          .find({}, { projection: { [TITLE_EMBEDDING_FIELD]: 0 } })
          .sort({ timestamp: -1 })
          .toArray(),
      catch: (error) => new DatabaseError({ message: 'Failed to fetch data.', cause: error }),
    });
  }

  function upsertNews(stories: Array<Document>) {
    return Effect.gen(function* () {
      const operations = stories.map(toUpsert).filter((operation) => !!operation);
      if (operations.length === 0) {
        return;
      }

      yield* Effect.tryPromise({
        try: () => news.bulkWrite(operations, { ordered: false }),
        catch: (error) => new DatabaseError({ message: 'Failed to write stories.', cause: error }),
      });
    });
  }

  function newsCollectionExists() {
    return Effect.gen(function* () {
      const collections = yield* Effect.tryPromise({
        try: () => db.collections(),
        catch: (error) => new DatabaseError({ message: 'Failed to fetch collections.', cause: error }),
      });

      return collections.some((collection) => collection.collectionName === NEWS_COLLECTION);
    });
  }

  function createNewsCollection() {
    return Effect.tryPromise({
      try: () => db.createCollection(NEWS_COLLECTION),
      catch: (error) => new DatabaseError({ message: 'Failed to create news collection.', cause: error }),
    });
  }

  function createNewsIndexes(indexes: Array<IndexDescription>) {
    return Effect.tryPromise({
      try: () => news.createIndexes(indexes),
      catch: (error) => new DatabaseError({ message: 'Failed to create news collection indexes.', cause: error }),
    });
  }

  function listNewsSearchIndexNames() {
    return Effect.gen(function* () {
      const indexes = yield* Effect.tryPromise({
        try: () => news.listSearchIndexes().toArray(),
        catch: (error) => new DatabaseError({ message: 'Failed to list search indexes.', cause: error }),
      });

      return new Set(indexes.map((index) => index.name as string));
    });
  }

  function createNewsSearchIndex(searchIndex: SearchIndexDescription & { name: string }) {
    return Effect.tryPromise({
      try: () => news.createSearchIndex(searchIndex),
      catch: (error) =>
        new DatabaseError({ message: `Failed to create search index '${searchIndex.name}'.`, cause: error }),
    });
  }

  return {
    findAllNews,
    upsertNews,
    newsCollectionExists,
    createNewsCollection,
    createNewsIndexes,
    listNewsSearchIndexNames,
    createNewsSearchIndex,
  };
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
