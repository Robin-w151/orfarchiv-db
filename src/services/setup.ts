import { NEWS_TITLE_VECTOR_INDEX, TITLE_EMBEDDING_DIMENSIONS } from '#common/search';
import type { Target } from '#common/targets';
import { Context, Effect, Equal, Layer, Result } from 'effect';
import type { Document, IndexDescription, SearchIndexDescription } from 'mongodb';
import { formatError, SetupError } from '../shared/error';
import { Database, type DatabaseConnection } from './database';

type NamedSearchIndexDescription = SearchIndexDescription & { name: string };

export interface SetupOptions {
  readonly recreateSearchIndexes: boolean;
}

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
  function setup(targets: ReadonlyArray<Target>, { recreateSearchIndexes }: SetupOptions) {
    return Effect.gen(function* () {
      const failedLabels: Array<string> = [];

      for (const target of targets) {
        const result = yield* setupTarget(target, recreateSearchIndexes).pipe(Effect.result);
        if (Result.isFailure(result)) {
          yield* Effect.logError(`Setup of '${target.label}' failed: ${formatError(result.failure)}`);
          failedLabels.push(target.label);
        }
      }

      if (failedLabels.length > 0) {
        return yield* new SetupError({
          message: `Setup failed for ${failedLabels.length} of ${targets.length} targets: ${failedLabels.join(', ')}`,
        });
      }

      yield* Effect.log('Done.');
    });
  }

  function setupTarget(target: Target, recreateSearchIndexes: boolean) {
    return Effect.gen(function* () {
      yield* Effect.log(`[${target.label}] Connecting to server...`);
      const connection = yield* database.connect(target);
      yield* setupDb(connection, recreateSearchIndexes);
    }).pipe(Effect.scoped);
  }

  function setupDb(connection: DatabaseConnection, recreateSearchIndexes: boolean) {
    return Effect.gen(function* () {
      yield* Effect.log('Creating orfarchiv DB...');

      if (!(yield* connection.newsCollectionExists())) {
        yield* Effect.log('Creating news collection...');
        yield* connection.createNewsCollection();
      }

      yield* Effect.log('Reconciling indexes...');
      yield* connection.createNewsIndexes(indexes);

      yield* Effect.log('Reconciling search indexes...');
      yield* reconcileSearchIndexes(connection, recreateSearchIndexes);
    });
  }

  function reconcileSearchIndexes(connection: DatabaseConnection, recreateSearchIndexes: boolean) {
    return Effect.gen(function* () {
      const existing = yield* connection.listNewsSearchIndexes();
      const changedNames: Array<string> = [];

      for (const searchIndex of searchIndexes) {
        if (!existing.has(searchIndex.name)) {
          yield* Effect.log(`Creating search index '${searchIndex.name}'...`);
          yield* connection.createNewsSearchIndex(searchIndex);
          continue;
        }

        if (searchIndexDefinitionMatches(searchIndex.definition, existing.get(searchIndex.name))) {
          yield* Effect.log(`Search index '${searchIndex.name}' is up to date.`);
          continue;
        }

        if (!recreateSearchIndexes) {
          yield* Effect.logWarning(`Search index '${searchIndex.name}' definition changed.`);
          changedNames.push(searchIndex.name);
          continue;
        }

        yield* Effect.log(`Search index '${searchIndex.name}' definition changed, recreating...`);
        yield* connection.dropNewsSearchIndex(searchIndex.name);
        yield* connection.createNewsSearchIndex(searchIndex);
      }

      if (changedNames.length > 0) {
        return yield* new SetupError({
          message: `Search index definitions changed: ${changedNames.join(', ')}. Run setup with --recreate-search-indexes to drop and recreate them (search is unavailable until the rebuild finishes).`,
        });
      }
    });
  }

  return {
    setup,
  };
}

function searchIndexDefinitionMatches(desired: Document, latest: Document | undefined): boolean {
  const desiredFields = (desired.fields ?? []) as Array<Document>;
  const latestFields = (latest?.fields ?? []) as Array<Document>;
  if (desiredFields.length !== latestFields.length) {
    return false;
  }

  return desiredFields.every((desiredField) => {
    const latestField = latestFields.find(
      (field) => field.type === desiredField.type && field.path === desiredField.path,
    );
    return !!latestField && Object.entries(desiredField).every(([key, value]) => Equal.equals(value, latestField[key]));
  });
}
