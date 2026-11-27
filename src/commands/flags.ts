import { Cron, Duration } from 'effect';
import { Flag } from 'effect/cli';

export const keepRunningFlag = Flag.Boolean('keep-running').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Keep running until interrupted'),
);

export function cronFlag(defaultCron: string, description: string) {
  return Flag.String('cron').pipe(
    Flag.withDefault(defaultCron),
    Flag.mapTryCatch(
      (cron) => Cron.parseUnsafe(cron),
      (error) => `a valid cron expression (${error instanceof Error ? error.message : error})`,
    ),
    Flag.withDescription(`Interval in cron syntax (default: ${defaultCron}, ${description})`),
  );
}

export function parseDuration(input: string): Duration.Duration {
  return Duration.fromInputUnsafe(input as Duration.Input);
}

export function formatDurationError(error: unknown): string {
  return `a valid duration, e.g. '30 minutes' (${error instanceof Error ? error.message : error})`;
}
