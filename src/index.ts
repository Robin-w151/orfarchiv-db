import { NodeRuntime, NodeServices } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Effect } from 'effect';
import { CliError, Command } from 'effect/unstable/cli';
import { version } from '../package.json';
import { backupCommand } from './commands/backup';
import { restoreCommand } from './commands/restore';
import { setupCommand } from './commands/setup';
import { AppLive } from './layers';
import { loggerLayer } from './shared/logger';

dotenv.config({ silent: true });

const db = Command.make('db').pipe(
  Command.withDescription('ORF Archiv database utilities'),
  Command.withSubcommands([setupCommand, backupCommand, restoreCommand]),
);

Command.run(db, { version }).pipe(
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) =>
      Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`),
  ),
  Effect.provide(AppLive),
  Effect.provide(NodeServices.layer),
  Effect.provide(loggerLayer),
  NodeRuntime.runMain,
);
