import { NodeFileSystem } from '@effect/platform-node';
import { Config, Context, Effect, FileSystem, Layer, pipe } from 'effect';
import { IOError } from '../shared/error';

export class Environment extends Context.Service<Environment>()('Environment', {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return defineService({ fs });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(NodeFileSystem.layer));
}

function defineService({ fs }: { fs: FileSystem.FileSystem }) {
  function loadEnvVariable(name: string, fallback: string): Effect.Effect<string> {
    return pipe(
      Config.string(`${name}_FILE`),
      Effect.andThen((file) =>
        pipe(
          fs.readFileString(file),
          Effect.mapError(
            (error) => new IOError({ message: `Failed to read env variable from file '${file}'`, cause: error }),
          ),
          Effect.map((value) => value.trim()),
          Effect.tapError((error) => Effect.logWarning(`${error}`)),
        ),
      ),
      Effect.catch(() => Config.string(name)),
      Effect.catch(() => Effect.succeed(fallback)),
    );
  }

  return {
    dbConnectionUrl: loadEnvVariable('ORFARCHIV_DB_URL', 'mongodb://localhost'),
    backupDir: loadEnvVariable('ORFARCHIV_BACKUP_DIR', './backup'),
  };
}
