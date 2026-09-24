import { Command, Flag } from 'effect/unstable/cli';

export const dbCommand = Command.make('db').pipe(
  Command.withDescription('ORF Archiv database utilities'),
  Command.withSharedFlags({
    target: Flag.string('target').pipe(
      Flag.optional,
      Flag.withDescription('Only use the database target with this label (host[:port])'),
    ),
  }),
);
