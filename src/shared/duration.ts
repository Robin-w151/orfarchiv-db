import { Duration } from 'effect';

export function parseDuration(input: string): Duration.Duration {
  const duration = Duration.fromInputUnsafe(input as Duration.Input);
  if (!Duration.isPositive(duration)) {
    throw new Error('must be greater than 0');
  }
  return duration;
}

export function durationExpectation(error: unknown): string {
  return `a valid duration, e.g. '30 minutes' (${error instanceof Error ? error.message : error})`;
}
