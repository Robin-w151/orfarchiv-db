import { NEWS_TITLE_VECTOR_INDEX } from '#common/search';
import type { Target } from '#common/targets';
import { Context, Effect, Layer, Stream } from 'effect';
import { SyncError } from '../shared/error';
import { Database, SYNC_FIELDS, type UpsertResult } from './database';

export interface SyncOptions {
  readonly from: Target;
  readonly to: Target;
  readonly since?: Date;
  readonly dryRun: boolean;
  readonly batchSize: number;
}

export class Sync extends Context.Service<Sync>()('Sync', {
  make: Effect.gen(function* () {
    const database = yield* Database;
    return defineService({ database });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Database.layer));
}

function defineService({ database }: { database: typeof Database.Service }) {
  function sync({ from, to, since, dryRun, batchSize }: SyncOptions) {
    return Effect.gen(function* () {
      if (from.label === to.label) {
        return yield* new SyncError({ message: `--from and --to are the same target '${from.label}'.` });
      }

      const scope = since ? ` since ${since.toISOString()}` : '';
      yield* Effect.log(`[${from.label}] Connecting to --from DB...`);
      const fromConnection = yield* database.connect(from);
      const total = yield* fromConnection.countNews({ since });

      if (dryRun) {
        yield* Effect.log(
          `[${from.label}] Would sync ${total} stories${scope} to '${to.label}'. Dry run, nothing written.`,
        );
        return;
      }

      yield* Effect.log(`[${to.label}] Connecting to --to DB...`);
      const toConnection = yield* database.connect(to);
      const searchIndexes = yield* toConnection.listNewsSearchIndexes();
      if (!searchIndexes.has(NEWS_TITLE_VECTOR_INDEX)) {
        yield* Effect.logWarning(`[${to.label}] Search index '${NEWS_TITLE_VECTOR_INDEX}' is missing, run setup.`);
      }

      yield* Effect.log(`[${to.label}] Syncing ${total} stories${scope} from '${from.label}'...`);
      const totals = yield* fromConnection.streamNews({ since }).pipe(
        Stream.grouped(Math.max(1, batchSize)),
        Stream.runFoldEffect(
          () => ({ read: 0, upserted: 0, modified: 0, matched: 0, skipped: 0 }),
          (totals, stories) =>
            Effect.gen(function* () {
              const result = yield* toConnection.upsertNews(stories, SYNC_FIELDS);
              const next = addResult(totals, stories.length, result);
              yield* Effect.log(`[${to.label}] Synced ${next.read}/${total} stories.`);
              return next;
            }),
        ),
      );

      yield* Effect.log(
        `[${to.label}] Done: ${totals.read} read, ${totals.upserted} inserted, ${totals.modified} updated, ${totals.matched - totals.modified} unchanged, ${totals.skipped} skipped (no id).`,
      );
    }).pipe(Effect.scoped);
  }

  return {
    sync,
  };
}

function addResult(
  totals: UpsertResult & { read: number },
  read: number,
  result: UpsertResult,
): UpsertResult & { read: number } {
  return {
    read: totals.read + read,
    upserted: totals.upserted + result.upserted,
    modified: totals.modified + result.modified,
    matched: totals.matched + result.matched,
    skipped: totals.skipped + result.skipped,
  };
}
