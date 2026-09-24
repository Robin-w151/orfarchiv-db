import { Data } from 'effect';

// Application errors
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ message: string; cause: unknown }> {}
export class TargetError extends Data.TaggedError('TargetError')<{ message: string }> {}
export class SetupError extends Data.TaggedError('SetupError')<{ message: string }> {}
export class BackupError extends Data.TaggedError('BackupError')<{ message: string }> {}
export class SyncError extends Data.TaggedError('SyncError')<{ message: string }> {}
export class VerifyError extends Data.TaggedError('VerifyError')<{ message: string }> {}

// System errors
export class IOError extends Data.TaggedError('IOError')<{ message: string; cause: unknown }> {}

const APP_ERROR_TAGS = new Set([
  'DatabaseError',
  'TargetError',
  'SetupError',
  'BackupError',
  'SyncError',
  'VerifyError',
  'IOError',
]);

export function isAppError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && APP_ERROR_TAGS.has((error as { _tag?: string })._tag ?? '');
}

export function formatError(
  error: { message?: string; cause?: unknown; stack?: string },
  { withStack = false }: { withStack?: boolean } = {},
): string {
  const message = error.message ?? 'Unknown error';
  const cause = error.cause === undefined ? '' : `\nCause: ${error.cause}`;
  const stack = withStack && error.stack ? `\nStack: ${error.stack}` : '';
  return `${message}${cause}${stack}`;
}
