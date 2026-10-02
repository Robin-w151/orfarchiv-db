import { redact } from '#common/targets';
import { Cause, Context, Duration, Effect, Layer, Schedule } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from 'effect/http';
import { Environment } from './env';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SEND_TIMEOUT = Duration.seconds(10);
const RETRY_DELAY = Duration.seconds(5);
const DISABLED_MESSAGE =
  'Notifications disabled: ORFARCHIV_TELEGRAM_BOT_TOKEN or ORFARCHIV_TELEGRAM_CHAT_ID is not set.';

export class Notifier extends Context.Service<Notifier>()('Notifier', {
  make: defineService(),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Environment.layer),
    Layer.provide(FetchHttpClient.layer),
  );
}

function defineService() {
  return Effect.gen(function* () {
    const environment = yield* Environment;
    const httpClient = yield* HttpClient.HttpClient;
    const serverLabel = yield* environment.serverLabel;
    const botToken = yield* environment.telegramBotToken;
    const chatId = yield* environment.telegramChatId;
    const enabled = botToken.length > 0 && chatId.length > 0;
    const client = httpClient.pipe(HttpClient.filterStatusOk);
    const warnDisabled = yield* Effect.cached(Effect.logWarning(DISABLED_MESSAGE));

    function notify(text: string): Effect.Effect<void> {
      return Effect.gen(function* () {
        const message = truncate(redact(`[${serverLabel}] ${text}`));
        if (!enabled) {
          yield* warnDisabled;
          yield* Effect.logWarning(`Notification not sent: ${message}`);
          return;
        }

        const request = HttpClientRequest.post(`https://api.telegram.org/bot${botToken}/sendMessage`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ chat_id: chatId, text: message }),
        );

        yield* client.execute(request).pipe(
          Effect.timeout(SEND_TIMEOUT),
          Effect.retry({ times: 1, schedule: Schedule.spaced(RETRY_DELAY), while: isRetryable }),
          Effect.flatMap((response) => response.text.pipe(Effect.ignore)),
          Effect.andThen(Effect.log('Notification sent.')),
          Effect.catchTags({
            HttpClientError: (error) =>
              Effect.gen(function* () {
                const description = yield* telegramDescription(error);
                yield* Effect.logError(
                  `Failed to send notification: ${describe(error)}${description ? `: ${description}` : ''}`,
                );
              }),
            TimeoutError: () =>
              Effect.logError(`Failed to send notification: timed out after ${Duration.format(SEND_TIMEOUT)}`),
          }),
        );
      });
    }

    return {
      enabled,
      notify,
    };
  });
}

export function logNotificationState(notifier: typeof Notifier.Service): Effect.Effect<void> {
  return notifier.enabled ? Effect.log('Notifications via Telegram enabled.') : Effect.logWarning(DISABLED_MESSAGE);
}

function isRetryable(error: HttpClientError.HttpClientError | Cause.TimeoutError): boolean {
  if (Cause.isTimeoutError(error)) {
    return true;
  }

  if (error.reason._tag !== 'StatusCodeError') {
    return true;
  }

  const status = error.reason.response.status;
  return status === 429 || status >= 500;
}

function describe(error: HttpClientError.HttpClientError): string {
  return error.reason._tag === 'StatusCodeError'
    ? `${error.reason._tag} (status ${error.reason.response.status})`
    : error.reason._tag;
}

function telegramDescription(error: HttpClientError.HttpClientError): Effect.Effect<string | undefined> {
  if (error.reason._tag !== 'StatusCodeError') {
    return Effect.succeed(undefined);
  }

  return error.reason.response.json.pipe(
    Effect.map((body) =>
      typeof body === 'object' && body !== null && 'description' in body && typeof body.description === 'string'
        ? body.description
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
}

function truncate(text: string): string {
  return text.length <= TELEGRAM_MESSAGE_LIMIT ? text : `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`;
}
