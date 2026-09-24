import { Data } from 'effect';

// Application errors
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}
export class TargetError extends Data.TaggedError('TargetError')<{ message: string }> {}
export class SetupError extends Data.TaggedError('SetupError')<{ message: string }> {}
export class BackupError extends Data.TaggedError('BackupError')<{ message: string }> {}

// System errors
export class IOError extends Data.TaggedError('IOError')<{ message: string; cause: unknown }> {}

export function formatError(error: { message: string; cause?: unknown }): string {
  return error.cause === undefined ? error.message : `${error.message}\nCause: ${error.cause}`;
}
