import { TITLE_EMBEDDING_FIELD } from '#common/search';
import type { Target } from '#common/targets';
import { Context, Effect, Layer, Stream } from 'effect';
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type Db,
  type Document,
  type IndexDescription,
  type SearchIndexDescription,
} from 'mongodb';
import { DatabaseError } from '../shared/error';

const DB_NAME = 'orfarchiv';
const NEWS_COLLECTION = 'news';
const CURSOR_BATCH_SIZE = 1000;
const STORY_FIELDS = ['id', 'title', 'category', 'url', 'timestamp', 'source'] as const;

export type DatabaseConnection = ReturnType<typeof defineConnection>;

export class Database extends Context.Service<Database>()('Database', {
  make: Effect.succeed(defineService()),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

function defineService() {
  function connect(target: Target) {
    return Effect.acquireRelease(
      Effect.tryPromise({
        try: () => MongoClient.connect(target.url),
        catch: (error) => new DatabaseError({ message: `Failed to connect to DB '${target.label}'.`, cause: error }),
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

  function streamAllNews() {
    return Stream.fromAsyncIterable(
      news
        .find({}, { projection: { [TITLE_EMBEDDING_FIELD]: 0 }, batchSize: CURSOR_BATCH_SIZE })
        .sort({ timestamp: -1 }),
      (error) => new DatabaseError({ message: 'Failed to fetch data.', cause: error }),
    );
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

  function listNewsSearchIndexes() {
    return Effect.gen(function* () {
      const indexes = yield* Effect.tryPromise({
        try: () => news.listSearchIndexes().toArray() as Promise<Array<Document>>,
        catch: (error) => new DatabaseError({ message: 'Failed to list search indexes.', cause: error }),
      });

      return new Map(indexes.map((index) => [index.name as string, index.latestDefinition as Document | undefined]));
    });
  }

  function createNewsSearchIndex(searchIndex: SearchIndexDescription & { name: string }) {
    return Effect.tryPromise({
      try: () => news.createSearchIndex(searchIndex),
      catch: (error) =>
        new DatabaseError({ message: `Failed to create search index '${searchIndex.name}'.`, cause: error }),
    });
  }

  function dropNewsSearchIndex(name: string) {
    return Effect.tryPromise({
      try: () => news.dropSearchIndex(name),
      catch: (error) => new DatabaseError({ message: `Failed to drop search index '${name}'.`, cause: error }),
    });
  }

  return {
    streamAllNews,
    upsertNews,
    newsCollectionExists,
    createNewsCollection,
    createNewsIndexes,
    listNewsSearchIndexes,
    createNewsSearchIndex,
    dropNewsSearchIndex,
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
