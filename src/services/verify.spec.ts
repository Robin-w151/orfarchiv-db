import type { Target } from '#common/targets/targets';
import { Effect, Exit, Layer, Logger } from 'effect';
import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { indexesFor, searchIndexesFor } from '../shared/model';
import { Database, type DatabaseConnection, type SearchIndexState } from './database';
import { Notifier } from './notifier';
import { Verify } from './verify';

const TARGETS: ReadonlyArray<Target> = [
  { url: 'mongodb://db-1', label: 'db-1', content: true },
  { url: 'mongodb://db-2', label: 'db-2', content: true },
];
const EXCLUDED_TARGETS: ReadonlyArray<Target> = [TARGETS[0], { ...TARGETS[1], content: false }];
const LATEST = new Date('2026-10-12T00:00:00Z');

interface FakeTarget {
  readonly content: boolean;
  readonly missingContent?: number;
  readonly withContent?: number;
}

function connection({ content, missingContent = 0, withContent = 0 }: FakeTarget) {
  const [searchIndex] = searchIndexesFor({ content });
  const searchIndexState: SearchIndexState = {
    definition: searchIndex.definition,
    status: 'READY',
    queryable: true,
  };

  return {
    countNews: () => Effect.succeed(100),
    latestNewsTimestamp: () => Effect.succeed(LATEST),
    countNewsWithoutEmbedding: () => Effect.succeed(0),
    countNewsWithoutContentStatus: () => Effect.succeed(missingContent),
    countNewsWithContent: () => Effect.succeed(withContent),
    listNewsIndexes: () => Effect.succeed(indexesFor({ content }) as Array<Document>),
    listNewsSearchIndexes: () => Effect.succeed(new Map([[searchIndex.name, searchIndexState]])),
  } as unknown as DatabaseConnection;
}

async function runVerify(targets: ReadonlyArray<Target>, fakes: Record<string, FakeTarget>) {
  const logs: Array<string> = [];
  const layer = Verify.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.succeed(Database, {
        connect: (target: Target) => Effect.succeed(connection(fakes[target.label])),
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
      return yield* verify.verify(targets).pipe(Effect.exit);
    }).pipe(Effect.provide(layer)),
  );

  return { exit, logs };
}

describe('Verify', () => {
  it('reports the missing content per target without treating a difference as divergence', async () => {
    const { exit, logs } = await runVerify(TARGETS, {
      'db-1': { content: true, missingContent: 40 },
      'db-2': { content: true, missingContent: 75 },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.find((log) => log.startsWith('[db-1]'))).toContain('40 without content');
    expect(logs.find((log) => log.startsWith('[db-2]'))).toContain('75 without content');
  });

  it('expects title-only indexes on a content-excluded target', async () => {
    const { exit, logs } = await runVerify(EXCLUDED_TARGETS, {
      'db-1': { content: true, missingContent: 40 },
      'db-2': { content: false },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(logs.find((log) => log.startsWith('[db-2]'))).toContain('content excluded, indexes ok');
  });

  it('fails when a content-excluded target has content fields', async () => {
    const { exit } = await runVerify(EXCLUDED_TARGETS, {
      'db-1': { content: true },
      'db-2': { content: false, withContent: 3 },
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("'db-2' (3 stories with content fields on content-excluded target)");
  });

  it('fails when a content-excluded target has the content index definitions', async () => {
    const { exit } = await runVerify(EXCLUDED_TARGETS, {
      'db-1': { content: true },
      'db-2': { content: true },
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("search index 'news_title_vector' definition changed");
  });
});
