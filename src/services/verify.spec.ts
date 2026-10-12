import type { Target } from '#common/targets/targets';
import { Effect, Exit, Layer, Logger } from 'effect';
import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { indexes, searchIndexes } from '../shared/model';
import { Database, type DatabaseConnection, type SearchIndexState } from './database';
import { Notifier } from './notifier';
import { Verify } from './verify';

const TARGETS: ReadonlyArray<Target> = [
  { url: 'mongodb://db-1', label: 'db-1' },
  { url: 'mongodb://db-2', label: 'db-2' },
];
const LATEST = new Date('2026-10-12T00:00:00Z');

function connection(missingContent: number) {
  const searchIndexState: SearchIndexState = {
    definition: searchIndexes[0].definition,
    status: 'READY',
    queryable: true,
  };

  return {
    countNews: () => Effect.succeed(100),
    latestNewsTimestamp: () => Effect.succeed(LATEST),
    countNewsWithoutEmbedding: () => Effect.succeed(0),
    countNewsWithoutContentStatus: () => Effect.succeed(missingContent),
    listNewsIndexes: () => Effect.succeed(indexes as Array<Document>),
    listNewsSearchIndexes: () => Effect.succeed(new Map([[searchIndexes[0].name, searchIndexState]])),
  } as unknown as DatabaseConnection;
}

describe('Verify', () => {
  it('reports the missing content per target without treating a difference as divergence', async () => {
    const logs: Array<string> = [];
    const missingContent = new Map([
      ['db-1', 40],
      ['db-2', 75],
    ]);
    const layer = Verify.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.succeed(Database, {
          connect: (target: Target) => Effect.succeed(connection(missingContent.get(target.label) ?? 0)),
        }),
      ),
      Layer.provide(Layer.succeed(Notifier, { enabled: false, notify: () => Effect.void })),
      Layer.provideMerge(
        Logger.layer([
          Logger.make(({ message }) => logs.push(Array.isArray(message) ? message.join(' ') : String(message))),
        ]),
      ),
    );

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const verify = yield* Verify;
        return yield* verify.verify(TARGETS).pipe(Effect.exit);
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.find((log) => log.startsWith('[db-1]'))).toContain('40 without content');
    expect(logs.find((log) => log.startsWith('[db-2]'))).toContain('75 without content');
  });
});
