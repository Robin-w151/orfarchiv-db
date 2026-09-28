import type { Target } from '#common/targets';
import { Context, Effect, Layer, Result } from 'effect';
import { formatError, SetupError } from '../shared/error';
import { indexes, searchIndexDefinitionMatches, searchIndexes } from '../shared/model';
import { Database, type DatabaseConnection } from './database';

export interface SetupOptions {
  readonly recreateSearchIndexes: boolean;
}

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

        if (searchIndexDefinitionMatches(searchIndex.definition, existing.get(searchIndex.name)?.definition)) {
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
