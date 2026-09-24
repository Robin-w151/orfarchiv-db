import { Layer } from 'effect';
import { Backup } from './services/backup';
import { Restore } from './services/restore';
import { Setup } from './services/setup';
import { Sync } from './services/sync';
import { Targets } from './services/targets';
import { Verify } from './services/verify';

export const AppLive = Layer.mergeAll(
  Backup.layer,
  Restore.layer,
  Setup.layer,
  Sync.layer,
  Targets.layer,
  Verify.layer,
);
