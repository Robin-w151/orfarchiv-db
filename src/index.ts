import { NodeRuntime, NodeServices } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Effect } from 'effect';
import { CliError, Command } from 'effect/unstable/cli';
import { version } from '../package.json';
import { mainCommand } from './commands';
import { AppLive } from './layers';
import { loggerLayer } from './shared/logger';

dotenv.config({ silent: true });

Command.run(mainCommand, { version }).pipe(
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) =>
      Effect.logError(`${error?.message ?? 'Unknown error'}\nCause: ${error.cause}\nStack: ${error?.stack ?? ''}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
  ),
  Effect.provide(AppLive),
  Effect.provide(NodeServices.layer),
  Effect.provide(loggerLayer),
  NodeRuntime.runMain,
);
