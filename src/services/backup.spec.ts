import type { Target } from '#common/targets/targets';
import { NodeFileSystem } from '@effect/platform-node';
import { Cron, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDiskLimit } from '../shared/disk';
import { Backup, type BackupOptions } from './backup';
import { Database, type DatabaseConnection } from './database';
import { Environment } from './env';
import { Notifier } from './notifier';

const TARGET: Target = { url: 'mongodb://localhost', label: 'localhost', content: true };

let backupDir: string;

beforeEach(async () => {
  backupDir = await mkdtemp(join(tmpdir(), 'orfarchiv-backup-'));
});

afterEach(async () => {
  await rm(backupDir, { recursive: true, force: true });
});

interface Fake {
  readonly logs: Array<string>;
  readonly notifications: Array<string>;
  readonly layer: Layer.Layer<Backup>;
}

function fake({ envTimeout, hang }: { envTimeout?: string; hang: boolean }): Fake {
  const logs: Array<string> = [];
  const notifications: Array<string> = [];

  const connection = {
    streamAllNews: () => (hang ? Stream.never : Stream.make({ id: '1', title: 'Story' })),
  } as unknown as DatabaseConnection;

  const environment = {
    backupDir: Effect.sync(() => backupDir),
    backupTimeout: Effect.succeed(envTimeout ?? '15 minutes'),
  } as unknown as typeof Environment.Service;

  const notifier = {
    enabled: false,
    notify: (text: string) => Effect.sync(() => notifications.push(text)),
  } as unknown as typeof Notifier.Service;

  const logger = Logger.make(({ message }) => {
    logs.push(Array.isArray(message) ? message.join(' ') : String(message));
  });

  const layer = Backup.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(Database, { connect: () => Effect.succeed(connection) })),
    Layer.provide(Layer.succeed(Environment, environment)),
    Layer.provide(Layer.succeed(Notifier, notifier)),
    Layer.provide(NodeFileSystem.layer),
    Layer.provideMerge(Logger.layer([logger])),
  );

  return { logs, notifications, layer };
}

function options(timeout?: Duration.Duration): BackupOptions {
  return { diskPaths: [], diskMaxUsage: parseDiskLimit('100%'), timeout: Option.fromUndefinedOr(timeout) };
}

function runBackup(fake: Fake, backupOptions: BackupOptions, advance: Duration.Input = 0) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const backup = yield* Backup;
      const fiber = yield* Effect.forkChild(backup.createBackup([TARGET], backupOptions).pipe(Effect.exit));
      const steps = Duration.toMinutes(advance);
      for (let step = 0; step < steps; step++) {
        yield* TestClock.adjust('1 minute');
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(fake.layer, TestClock.layer()))),
  );
}

describe('Backup', () => {
  describe('timeout', () => {
    it('writes the backup file within the timeout', async () => {
      const backup = fake({ hang: false });

      const exit = await runBackup(backup, options());

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(await readdir(join(backupDir, TARGET.label))).toEqual([expect.stringMatching(/Z\.json$/)]);
    });

    it('defaults to 15 minutes', async () => {
      const backup = fake({ hang: true });

      const exit = await runBackup(backup, options(), '15 minutes');

      expect(Exit.isFailure(exit)).toBe(true);
      expect(backup.notifications.join('\n')).toContain(`Backup of 'localhost' failed: Timed out after 15m.`);
      expect(await readdir(join(backupDir, TARGET.label))).toEqual([]);
    });

    it('uses ORFARCHIV_BACKUP_TIMEOUT when no flag is given', async () => {
      const backup = fake({ envTimeout: '5 minutes', hang: true });

      const exit = await runBackup(backup, options(), '5 minutes');

      expect(Exit.isFailure(exit)).toBe(true);
      expect(backup.notifications.join('\n')).toContain('Timed out after 5m.');
    });

    it('prefers the flag over ORFARCHIV_BACKUP_TIMEOUT', async () => {
      const backup = fake({ envTimeout: '5 minutes', hang: true });

      const exit = await runBackup(backup, options(Duration.minutes(1)), '1 minute');

      expect(Exit.isFailure(exit)).toBe(true);
      expect(backup.notifications.join('\n')).toContain('Timed out after 1m.');
    });

    it.each(['soon', '0 seconds', '-5 minutes'])('fails on an invalid ORFARCHIV_BACKUP_TIMEOUT %j', async (value) => {
      const backup = fake({ envTimeout: value, hang: false });

      const exit = await runBackup(backup, options());

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain(`Invalid ORFARCHIV_BACKUP_TIMEOUT '${value}'`);
    });

    it('fails before scheduling on an invalid ORFARCHIV_BACKUP_TIMEOUT', async () => {
      const backup = fake({ envTimeout: 'soon', hang: false });

      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* Backup;
          return yield* service.scheduleBackups(Cron.parseUnsafe('0 0 3 * * *'), [TARGET], options()).pipe(Effect.exit);
        }).pipe(Effect.provide(Layer.merge(backup.layer, TestClock.layer()))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain(`Invalid ORFARCHIV_BACKUP_TIMEOUT 'soon'`);
    });
  });
});
