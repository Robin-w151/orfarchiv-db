import { Layer } from 'effect';
import { Backup } from './services/backup';
import { Restore } from './services/restore';
import { Setup } from './services/setup';

export const AppLive = Layer.mergeAll(Backup.layer, Restore.layer, Setup.layer);
