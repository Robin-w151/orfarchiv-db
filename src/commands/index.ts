import { Command } from 'effect/unstable/cli';
import { backupCommand } from './backup';
import { dbCommand } from './db';
import { restoreCommand } from './restore';
import { setupCommand } from './setup';
import { syncCommand } from './sync';
import { targetsCommand } from './targets';
import { verifyCommand } from './verify';

export const mainCommand = dbCommand.pipe(
  Command.withSubcommands([setupCommand, backupCommand, restoreCommand, syncCommand, verifyCommand, targetsCommand]),
);
