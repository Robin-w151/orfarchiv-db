import type { Target } from '#common/targets/targets';
import { Context, Duration, Effect, Layer, Result, Schedule } from 'effect';
import { formatError, SetupError } from '../shared/error';
import {
  indexes,
  indexMatches,
  searchIndexDefinitionMatches,
  searchIndexes,
  type NamedSearchIndexDescription,
} from '../shared/model';
import { Database, type DatabaseConnection, type SearchIndexState } from './database';

const WAIT_SCHEDULE = Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')]);

export interface SetupOptions {
  readonly recreateSearchIndexes: boolean;
  readonly waitUntilQueryable: boolean;
  readonly waitTimeout: Duration.Duration;
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
  function setup(targets: ReadonlyArray<Target>, options: SetupOptions) {
    return Effect.gen(function* () {
      const failedLabels: Array<string> = [];

      for (const target of targets) {
        const result = yield* setupTarget(target, options).pipe(Effect.result);
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

  function setupTarget(target: Target, options: SetupOptions) {
    return Effect.gen(function* () {
      yield* Effect.log(`[${target.label}] Connecting to server...`);
      const connection = yield* database.connect(target);
      yield* setupDb(connection, options);
    }).pipe(Effect.scoped);
  }

  function setupDb(connection: DatabaseConnection, options: SetupOptions) {
    return Effect.gen(function* () {
      yield* Effect.log('Creating orfarchiv DB...');

      if (!(yield* connection.newsCollectionExists())) {
        yield* Effect.log('Creating news collection...');
        yield* connection.createNewsCollection();
      }

      yield* Effect.log('Reconciling indexes...');
      yield* reconcileIndexes(connection);

      yield* Effect.log('Reconciling search indexes...');
      yield* reconcileSearchIndexes(connection, options);
    });
  }

  function reconcileIndexes(connection: DatabaseConnection) {
    return Effect.gen(function* () {
      const existing = yield* connection.listNewsIndexes();
      const pending = indexes.flatMap((index) => {
        const current = existing.find((existing) => existing.name === index.name);
        return indexMatches(index, current) ? [] : [{ index, current }];
      });

      for (const { index } of pending.filter(({ index }) => index.unique)) {
        const duplicates = yield* connection.countDuplicates(index.key);
        if (duplicates > 0) {
          return yield* new SetupError({
            message: `Index '${index.name}' must be unique, but ${duplicates} of its values are duplicated. Remove the duplicates and run setup again.`,
          });
        }
      }

      for (const { index, current } of pending) {
        if (current) {
          yield* Effect.log(`Index '${index.name}' changed, recreating...`);
          yield* connection.dropNewsIndex(index.name);
        } else {
          yield* Effect.log(`Creating index '${index.name}'...`);
        }
      }

      if (pending.length > 0) {
        yield* connection.createNewsIndexes(pending.map(({ index }) => index));
      }
    });
  }

  function reconcileSearchIndexes(connection: DatabaseConnection, options: SetupOptions) {
    return Effect.gen(function* () {
      const existing = yield* connection.listNewsSearchIndexes();
      const changedNames: Array<string> = [];

      for (const searchIndex of searchIndexes) {
        if (!existing.has(searchIndex.name)) {
          yield* Effect.log(`Creating search index '${searchIndex.name}'...`);
          yield* connection.createNewsSearchIndex(searchIndex);
          if (options.waitUntilQueryable) {
            yield* waitUntilQueryable(connection, searchIndex, options.waitTimeout);
          }
          continue;
        }

        if (searchIndexDefinitionMatches(searchIndex.definition, existing.get(searchIndex.name)?.definition)) {
          yield* Effect.log(`Search index '${searchIndex.name}' is up to date.`);
          if (options.waitUntilQueryable && !isQueryable(searchIndex, existing.get(searchIndex.name))) {
            yield* waitUntilQueryable(connection, searchIndex, options.waitTimeout);
          }
          continue;
        }

        if (!options.recreateSearchIndexes) {
          yield* Effect.logWarning(`Search index '${searchIndex.name}' definition changed.`);
          changedNames.push(searchIndex.name);
          continue;
        }

        yield* Effect.log(`Search index '${searchIndex.name}' definition changed, recreating...`);
        yield* connection.dropNewsSearchIndex(searchIndex.name);
        yield* connection.createNewsSearchIndex(searchIndex);
        if (options.waitUntilQueryable) {
          yield* waitUntilQueryable(connection, searchIndex, options.waitTimeout);
        }
      }

      if (changedNames.length > 0) {
        return yield* new SetupError({
          message: `Search index definitions changed: ${changedNames.join(', ')}. Run setup with --recreate-search-indexes to drop and recreate them (search is unavailable until the rebuild finishes).`,
        });
      }
    });
  }

  function waitUntilQueryable(
    connection: DatabaseConnection,
    searchIndex: NamedSearchIndexDescription,
    timeout: Duration.Duration,
  ) {
    const check = Effect.gen(function* () {
      const listResult = yield* connection.listNewsSearchIndexes().pipe(Effect.result);
      if (Result.isFailure(listResult)) {
        yield* Effect.logWarning(
          `Search index '${searchIndex.name}': status unknown, retrying (${formatError(listResult.failure)})`,
        );
        return false;
      }

      const state = listResult.success.get(searchIndex.name);
      yield* Effect.log(
        `Search index '${searchIndex.name}': status ${state?.status ?? 'missing'}, queryable ${state?.queryable ?? false}`,
      );
      if (state?.status === 'FAILED') {
        return yield* new SetupError({ message: `Search index '${searchIndex.name}' failed to build.` });
      }
      return isQueryable(searchIndex, state);
    });

    return Effect.gen(function* () {
      yield* Effect.log(`Waiting until search index '${searchIndex.name}' is queryable...`);
      const [elapsed] = yield* check.pipe(
        Effect.repeat({ schedule: WAIT_SCHEDULE, until: (queryable) => queryable }),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new SetupError({
                message: `Search index '${searchIndex.name}' did not become queryable within ${Duration.format(timeout)}. It keeps building in the background.`,
              }),
            ),
        }),
        Effect.timed,
      );
      yield* Effect.log(
        `Search index '${searchIndex.name}' is queryable after ${Duration.format(Duration.seconds(Math.round(Duration.toSeconds(elapsed))))}.`,
      );
    });
  }

  return {
    setup,
  };
}

function isQueryable(searchIndex: NamedSearchIndexDescription, state: SearchIndexState | undefined) {
  return (
    state?.status === 'READY' &&
    state.queryable &&
    searchIndexDefinitionMatches(searchIndex.definition, state.definition)
  );
}
