import type { Target } from '#common/targets/targets';
import { Clock, Duration, Effect, Exit, Fiber, Layer, Logger } from 'effect';
import { TestClock } from 'effect/testing';
import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../shared/error';
import { indexesFor, searchIndexesFor, type NamedSearchIndexDescription } from '../shared/model';
import { Database, type DatabaseConnection, type SearchIndexState } from './database';
import { Setup, type SetupOptions } from './setup';

const TARGET: Target = { url: 'mongodb://localhost', label: 'localhost', content: true };
const EXCLUDED_TARGET: Target = { ...TARGET, content: false };
const [VECTOR_INDEX] = searchIndexesFor({ content: true });
const [TITLE_ONLY_VECTOR_INDEX] = searchIndexesFor({ content: false });
const OLD_DEFINITION: Document = {
  fields: (VECTOR_INDEX.definition.fields as Array<Document>).filter((field) => field.path !== 'contentEmbedding'),
};

const READY: SearchIndexState = { definition: VECTOR_INDEX.definition, status: 'READY', queryable: true };
const BUILDING: SearchIndexState = { definition: VECTOR_INDEX.definition, status: 'BUILDING', queryable: false };
const FAILED: SearchIndexState = { definition: VECTOR_INDEX.definition, status: 'FAILED', queryable: false };
const OLD_READY: SearchIndexState = { definition: OLD_DEFINITION, status: 'READY', queryable: true };
const TITLE_ONLY_READY: SearchIndexState = {
  definition: TITLE_ONLY_VECTOR_INDEX.definition,
  status: 'READY',
  queryable: true,
};
const UNREACHABLE = 'unreachable';

const OPTIONS: SetupOptions = {
  recreateSearchIndexes: false,
  waitUntilQueryable: false,
  waitTimeout: Duration.minutes(30),
};

interface FakeDatabase {
  readonly calls: Array<string>;
  readonly pollTimes: Array<number>;
  readonly logs: Array<string>;
  readonly layer: Layer.Layer<Setup>;
  readonly created: Array<Document>;
}

function fakeDatabase(
  states: ReadonlyArray<SearchIndexState | typeof UNREACHABLE | undefined>,
  existingIndexes: ReadonlyArray<Document> = indexesFor({ content: true }),
): FakeDatabase {
  const calls: Array<string> = [];
  const pollTimes: Array<number> = [];
  const logs: Array<string> = [];
  let poll = 0;

  const created: Array<Document> = [];
  const connection = {
    newsCollectionExists: () => Effect.succeed(true),
    listNewsIndexes: () => Effect.succeed([...existingIndexes]),
    dropNewsIndex: (name: string) => Effect.sync(() => calls.push(`drop index ${name}`)),
    createNewsIndexes: (indexes: Array<Document>) =>
      Effect.sync(() => calls.push(`create indexes ${indexes.map((index) => index.name).join(', ')}`)),
    listNewsSearchIndexes: () =>
      Effect.gen(function* () {
        pollTimes.push(yield* Clock.currentTimeMillis);
        const state = states[Math.min(poll++, states.length - 1)];
        if (state === UNREACHABLE) {
          return yield* new DatabaseError({ message: 'Failed to list search indexes.', cause: undefined });
        }
        return new Map(state ? [[VECTOR_INDEX.name, state]] : []);
      }),
    createNewsSearchIndex: (searchIndex: NamedSearchIndexDescription) =>
      Effect.sync(() => {
        calls.push(`create ${searchIndex.name}`);
        created.push(searchIndex.definition);
      }),
    dropNewsSearchIndex: (name: string) => Effect.sync(() => calls.push(`drop ${name}`)),
  } as unknown as DatabaseConnection;

  const logger = Logger.make(({ message }) => {
    logs.push(Array.isArray(message) ? message.join(' ') : String(message));
  });

  const layer = Setup.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(Database, { connect: () => Effect.succeed(connection) })),
    Layer.provideMerge(Logger.layer([logger])),
  );

  return { calls, pollTimes, logs, created, layer };
}

function runSetup(
  fake: FakeDatabase,
  options: Partial<SetupOptions>,
  advance: Duration.Input = 0,
  target: Target = TARGET,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* Setup;
      const fiber = yield* Effect.forkChild(setup.setup([target], { ...OPTIONS, ...options }).pipe(Effect.exit));
      const steps = Duration.toSeconds(advance);
      for (let step = 0; step < steps; step++) {
        yield* TestClock.adjust('1 second');
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(fake.layer, TestClock.layer()))),
  );
}

describe('Setup', () => {
  describe('search indexes', () => {
    it('creates a missing search index', async () => {
      const fake = fakeDatabase([undefined]);

      const exit = await runSetup(fake, {});

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual(['create news_title_vector']);
    });

    it('leaves an up-to-date search index alone', async () => {
      const fake = fakeDatabase([READY]);

      const exit = await runSetup(fake, {});

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual([]);
    });

    it('fails on a changed definition without touching the index', async () => {
      const fake = fakeDatabase([OLD_READY]);

      const exit = await runSetup(fake, {});

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.calls).toEqual([]);
      expect(fake.logs.join('\n')).toContain('Search index definitions changed: news_title_vector');
    });

    it('drops and recreates a changed search index when asked to', async () => {
      const fake = fakeDatabase([OLD_READY]);

      const exit = await runSetup(fake, { recreateSearchIndexes: true });

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual(['drop news_title_vector', 'create news_title_vector']);
    });
  });

  describe('content-excluded targets', () => {
    it('creates a title-only search index', async () => {
      const fake = fakeDatabase([undefined], indexesFor({ content: false }));

      const exit = await runSetup(fake, {}, 0, EXCLUDED_TARGET);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual(['create news_title_vector']);
      expect(fake.created).toEqual([TITLE_ONLY_VECTOR_INDEX.definition]);
    });

    it('leaves an up-to-date title-only search index alone', async () => {
      const fake = fakeDatabase([TITLE_ONLY_READY], indexesFor({ content: false }));

      const exit = await runSetup(fake, {}, 0, EXCLUDED_TARGET);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual([]);
    });

    it('treats a search index with the content path as changed', async () => {
      const fake = fakeDatabase([READY], indexesFor({ content: false }));

      const exit = await runSetup(fake, {}, 0, EXCLUDED_TARGET);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.logs.join('\n')).toContain('Search index definitions changed: news_title_vector');
    });

    it('drops the content status index and creates no content index', async () => {
      const fake = fakeDatabase([TITLE_ONLY_READY]);

      const exit = await runSetup(fake, {}, 0, EXCLUDED_TARGET);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual(['drop index content_status_timestamp']);
    });

    it('creates the content status index on content targets', async () => {
      const fake = fakeDatabase([READY], indexesFor({ content: false }));

      const exit = await runSetup(fake, {});

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual(['create indexes content_status_timestamp']);
    });
  });

  describe('waiting until queryable', () => {
    it('returns right after the create without the flag', async () => {
      const fake = fakeDatabase([OLD_READY]);

      await runSetup(fake, { recreateSearchIndexes: true });

      expect(fake.pollTimes).toHaveLength(1);
    });

    it('succeeds once the recreated index is ready and queryable', async () => {
      const fake = fakeDatabase([OLD_READY, OLD_READY, BUILDING, READY]);

      const exit = await runSetup(fake, { recreateSearchIndexes: true, waitUntilQueryable: true }, '10 seconds');

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.pollTimes).toEqual([0, 0, 1000, 3000]);
      expect(fake.logs).toContain("Search index 'news_title_vector' is queryable after 3s.");
    });

    it('waits for an up-to-date index that is still building', async () => {
      const fake = fakeDatabase([BUILDING, BUILDING, READY]);

      const exit = await runSetup(fake, { waitUntilQueryable: true }, '10 seconds');

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toEqual([]);
      expect(fake.pollTimes).toEqual([0, 0, 1000]);
    });

    it('does not wait for an up-to-date index that is already queryable', async () => {
      const fake = fakeDatabase([READY]);

      await runSetup(fake, { waitUntilQueryable: true });

      expect(fake.pollTimes).toEqual([0]);
    });

    it('keeps waiting when the search index status is briefly unavailable', async () => {
      const fake = fakeDatabase([undefined, BUILDING, UNREACHABLE, READY]);

      const exit = await runSetup(fake, { waitUntilQueryable: true }, '10 seconds');

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.logs.join('\n')).toContain("Search index 'news_title_vector': status unknown, retrying");
    });

    it('fails when the index build fails', async () => {
      const fake = fakeDatabase([undefined, BUILDING, FAILED]);

      const exit = await runSetup(fake, { waitUntilQueryable: true }, '10 seconds');

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.logs.join('\n')).toContain("Search index 'news_title_vector' failed to build.");
    });

    it('fails after the wait timeout and names the index', async () => {
      const fake = fakeDatabase([undefined, BUILDING]);

      const exit = await runSetup(fake, { waitUntilQueryable: true, waitTimeout: Duration.minutes(5) }, '6 minutes');

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.logs.join('\n')).toContain(
        "Search index 'news_title_vector' did not become queryable within 5m. It keeps building in the background.",
      );
      expect(fake.calls).toEqual(['create news_title_vector']);
    });

    it('backs off exponentially from 1 second, capped at 30 seconds', async () => {
      const fake = fakeDatabase([undefined, BUILDING]);

      await runSetup(fake, { waitUntilQueryable: true, waitTimeout: Duration.seconds(100) }, '2 minutes');

      const delays = fake.pollTimes.slice(1).map((time, index) => (time - fake.pollTimes[index]) / 1000);
      expect(delays).toEqual([0, 1, 2, 4, 8, 16, 30, 30]);
    });
  });
});
