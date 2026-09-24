import { Command } from 'effect/unstable/cli';
import { backupCommand } from './backup';
import { dbCommand } from './db';
import { restoreCommand } from './restore';
import { setupCommand } from './setup';

export const mainCommand = dbCommand.pipe(Command.withSubcommands([setupCommand, backupCommand, restoreCommand]));
