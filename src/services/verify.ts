import type { Target } from '#common/targets';
import { Context, Effect, Layer, Result } from 'effect';
import { formatError, VerifyError } from '../shared/error';
import { indexes, indexMatches, searchIndexDefinitionMatches, searchIndexes } from '../shared/model';
import { Database } from './database';

interface TargetReport {
  readonly target: Target;
  readonly count: number;
  readonly latestTimestamp: Date | undefined;
  readonly missingEmbeddings: number;
  readonly problems: ReadonlyArray<string>;
}

export class Verify extends Context.Service<Verify>()('Verify', {
  make: Effect.gen(function* () {
    const database = yield* Database;
    return defineService({ database });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Database.layer));
}

function defineService({ database }: { database: typeof Database.Service }) {
  function verify(targets: ReadonlyArray<Target>) {
    return Effect.gen(function* () {
      const results = yield* Effect.forEach(targets, (target) => inspect(target).pipe(Effect.result), {
        concurrency: 'unbounded',
      });

      const failures = new Map<string, Array<string>>();
      const addFailure = (target: Target, reason: string) =>
        failures.set(target.label, [...(failures.get(target.label) ?? []), reason]);

      const reports: Array<TargetReport> = [];
      for (const [index, result] of results.entries()) {
        const target = targets[index];
        if (Result.isFailure(result)) {
          yield* Effect.logError(`[${target.label}] Unreachable: ${formatError(result.failure)}`);
          addFailure(target, 'unreachable');
          continue;
        }

        const report = result.success;
        reports.push(report);
        yield* Effect.log(
          `[${target.label}] ${report.count} stories, latest ${report.latestTimestamp?.toISOString() ?? 'none'}, ${report.missingEmbeddings} without embedding, ${report.problems.length === 0 ? 'indexes ok' : report.problems.join(', ')}`,
        );
        report.problems.forEach((problem) => addFailure(target, problem));
      }

      const reference = reports.find((report) => report.target === targets[0]);
      if (reference) {
        for (const report of reports.filter((report) => report !== reference)) {
          divergences(reference, report).forEach((divergence) => addFailure(report.target, divergence));
        }
      }

      if (failures.size > 0) {
        return yield* new VerifyError({
          message: `Verification failed for ${failures.size} of ${targets.length} targets: ${[...failures]
            .map(([label, reasons]) => `'${label}' (${reasons.join('; ')})`)
            .join(', ')}`,
        });
      }

      yield* Effect.log(targets.length === 1 ? 'Target is healthy.' : `All ${targets.length} targets agree.`);
    });
  }

  function inspect(target: Target) {
    return Effect.gen(function* () {
      const connection = yield* database.connect(target);
      const [count, latestTimestamp, missingEmbeddings, existingIndexes, existingSearchIndexes] = yield* Effect.all(
        [
          connection.estimatedNewsCount(),
          connection.latestNewsTimestamp(),
          connection.countNewsWithoutEmbedding(),
          connection.listNewsIndexes(),
          connection.listNewsSearchIndexes(),
        ],
        { concurrency: 'unbounded' },
      );

      const problems: Array<string> = [];
      for (const index of indexes) {
        const existing = existingIndexes.find((existing) => existing.name === index.name);
        if (!existing) {
          problems.push(`index '${index.name}' missing`);
        } else if (!indexMatches(index, existing)) {
          problems.push(`index '${index.name}' has a different key`);
        }
      }

      for (const searchIndex of searchIndexes) {
        const existing = existingSearchIndexes.get(searchIndex.name);
        if (!existing) {
          problems.push(`search index '${searchIndex.name}' missing`);
          continue;
        }

        if (!searchIndexDefinitionMatches(searchIndex.definition, existing.definition)) {
          problems.push(`search index '${searchIndex.name}' definition changed`);
        }

        if (existing.status !== 'READY' || !existing.queryable) {
          problems.push(`search index '${searchIndex.name}' not queryable (status ${existing.status ?? 'unknown'})`);
        }
      }

      return { target, count, latestTimestamp, missingEmbeddings, problems } satisfies TargetReport;
    }).pipe(Effect.scoped);
  }

  return {
    verify,
  };
}

function divergences(reference: TargetReport, report: TargetReport): Array<string> {
  const label = reference.target.label;
  const result: Array<string> = [];

  if (report.count !== reference.count) {
    result.push(`${report.count} stories vs ${reference.count} on '${label}'`);
  }

  if (report.latestTimestamp?.getTime() !== reference.latestTimestamp?.getTime()) {
    result.push(
      `latest ${report.latestTimestamp?.toISOString() ?? 'none'} vs ${reference.latestTimestamp?.toISOString() ?? 'none'} on '${label}'`,
    );
  }

  if (report.missingEmbeddings !== reference.missingEmbeddings) {
    result.push(`${report.missingEmbeddings} without embedding vs ${reference.missingEmbeddings} on '${label}'`);
  }

  return result;
}
