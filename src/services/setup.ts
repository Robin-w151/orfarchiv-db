import { Context, Effect, Layer } from 'effect';
import type { IndexDescription, SearchIndexDescription } from 'mongodb';
import { NEWS_TITLE_VECTOR_INDEX, TITLE_EMBEDDING_DIMENSIONS } from '../shared/search';
import { Database, type DatabaseConnection } from './database';

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

export class Setup extends Context.Service<Setup>()('Setup', {
  make: Effect.gen(function* () {
    const database = yield* Database;
    return defineService({ database });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Database.layer));
}

function defineService({ database }: { database: typeof Database.Service }) {
  function setup() {
    return Effect.gen(function* () {
      yield* Effect.log('Connecting to server...');
      const connection = yield* database.connect();
      yield* setupDb(connection);
      yield* Effect.log('Done.');
    }).pipe(Effect.scoped);
  }

  function setupDb(connection: DatabaseConnection) {
    return Effect.gen(function* () {
      yield* Effect.log('Creating orfarchiv DB...');

      if (!(yield* connection.newsCollectionExists())) {
        yield* Effect.log('Creating news collection...');
        yield* connection.createNewsCollection();
      }

      yield* Effect.log('Reconciling indexes...');
      yield* connection.createNewsIndexes(indexes);

      yield* Effect.log('Reconciling search indexes...');
      yield* createSearchIndexes(connection);
    });
  }

  function createSearchIndexes(connection: DatabaseConnection) {
    return Effect.gen(function* () {
      const existingNames = yield* connection.listNewsSearchIndexNames();

      for (const searchIndex of searchIndexes) {
        if (existingNames.has(searchIndex.name)) {
          yield* Effect.log(`Search index '${searchIndex.name}' already exists.`);
          continue;
        }

        yield* Effect.log(`Creating search index '${searchIndex.name}'...`);
        yield* connection.createNewsSearchIndex(searchIndex);
      }
    });
  }

  return {
    setup,
  };
}
