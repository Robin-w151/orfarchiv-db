import { TITLE_EMBEDDING_FIELD } from '#common/search';
import type { Target } from '#common/targets';
import { Context, Effect, Layer, Stream } from 'effect';
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type Db,
  type Document,
  type Filter,
  type IndexDescription,
  type SearchIndexDescription,
} from 'mongodb';
import { DatabaseError } from '../shared/error';

const DB_NAME = 'orfarchiv';
const NEWS_COLLECTION = 'news';
const CURSOR_BATCH_SIZE = 1000;
const STORY_FIELDS: ReadonlyArray<string> = ['id', 'title', 'category', 'url', 'timestamp', 'source'];
export const SYNC_FIELDS: ReadonlyArray<string> = [...STORY_FIELDS, TITLE_EMBEDDING_FIELD];

export interface UpsertResult {
  readonly upserted: number;
  readonly modified: number;
  readonly matched: number;
  readonly skipped: number;
}

export interface SearchIndexState {
  readonly definition: Document | undefined;
  readonly status: string | undefined;
  readonly queryable: boolean;
}

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

  function streamNews({ since }: { since?: Date }) {
    return Stream.fromAsyncIterable(
      news.find(sinceFilter(since), { batchSize: CURSOR_BATCH_SIZE }),
      (error) => new DatabaseError({ message: 'Failed to fetch data.', cause: error }),
    );
  }

  function countNews({ since }: { since?: Date }) {
    return Effect.tryPromise({
      try: () => news.countDocuments(sinceFilter(since)),
      catch: (error) => new DatabaseError({ message: 'Failed to count stories.', cause: error }),
    });
  }

  function estimatedNewsCount() {
    return Effect.tryPromise({
      try: () => news.estimatedDocumentCount(),
      catch: (error) => new DatabaseError({ message: 'Failed to count stories.', cause: error }),
    });
  }

  function countNewsWithoutEmbedding() {
    return Effect.tryPromise({
      try: () => news.countDocuments({ [TITLE_EMBEDDING_FIELD]: { $exists: false } }),
      catch: (error) => new DatabaseError({ message: 'Failed to count stories without embedding.', cause: error }),
    });
  }

  function latestNewsTimestamp() {
    return Effect.gen(function* () {
      const latest = yield* Effect.tryPromise({
        try: () => news.findOne({}, { projection: { _id: 0, timestamp: 1 }, sort: { timestamp: -1 } }),
        catch: (error) => new DatabaseError({ message: 'Failed to fetch latest story.', cause: error }),
      });

      return latest?.timestamp instanceof Date ? latest.timestamp : undefined;
    });
  }

  function upsertNews(stories: ReadonlyArray<Document>, fields: ReadonlyArray<string> = STORY_FIELDS) {
    return Effect.gen(function* () {
      const operations = stories.map((story) => toUpsert(story, fields)).filter((operation) => !!operation);
      const skipped = stories.length - operations.length;
      if (operations.length === 0) {
        return { upserted: 0, modified: 0, matched: 0, skipped } satisfies UpsertResult;
      }

      const result = yield* Effect.tryPromise({
        try: () => news.bulkWrite(operations, { ordered: false }),
        catch: (error) => new DatabaseError({ message: 'Failed to write stories.', cause: error }),
      });

      return {
        upserted: result.upsertedCount,
        modified: result.modifiedCount,
        matched: result.matchedCount,
        skipped,
      } satisfies UpsertResult;
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

  function listNewsIndexes() {
    return Effect.tryPromise({
      try: () => news.listIndexes().toArray(),
      catch: (error) => new DatabaseError({ message: 'Failed to list indexes.', cause: error }),
    });
  }

  function listNewsSearchIndexes() {
    return Effect.gen(function* () {
      const indexes = yield* Effect.tryPromise({
        try: () => news.listSearchIndexes().toArray() as Promise<Array<Document>>,
        catch: (error) => new DatabaseError({ message: 'Failed to list search indexes.', cause: error }),
      });

      return new Map<string, SearchIndexState>(
        indexes.map((index) => [
          index.name as string,
          {
            definition: index.latestDefinition as Document | undefined,
            status: index.status as string | undefined,
            queryable: index.queryable === true,
          },
        ]),
      );
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
    streamNews,
    countNews,
    estimatedNewsCount,
    countNewsWithoutEmbedding,
    latestNewsTimestamp,
    upsertNews,
    newsCollectionExists,
    createNewsCollection,
    createNewsIndexes,
    listNewsIndexes,
    listNewsSearchIndexes,
    createNewsSearchIndex,
    dropNewsSearchIndex,
  };
}

function sinceFilter(since: Date | undefined): Filter<Document> {
  return since ? { timestamp: { $gte: since } } : {};
}

function toUpsert(story: Document, fields: ReadonlyArray<string>): AnyBulkWriteOperation | undefined {
  if (typeof story.id !== 'string') {
    return undefined;
  }

  const update: Document = {};
  for (const field of fields) {
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
