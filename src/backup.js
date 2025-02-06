import dotenv from 'dotenv-flow';
import { mkdir, readFile, writeFile } from 'fs/promises';
import meow from 'meow';
import { MongoClient } from 'mongodb';
import { join } from 'path';
import { timer } from 'rxjs';
import { exhaustMap } from 'rxjs/operators';
import logger from './logger.js';

dotenv.config({ silent: true });

main().catch(logger.error);

async function main() {
  const cli = meow(
    `
    Usage
      $ db-backup

    Options
      --keep-running  Keep running until interrupted
      --interval      Interval in hours (default: 24)

    Examples
      $ db-backup
      $ db-backup --keep-running --interval 1
    `,
    {
      importMeta: import.meta,
      flags: {
        keepRunning: {
          type: 'boolean',
          default: false,
        },
        interval: {
          type: 'number',
          default: 24,
        },
      },
    },
  );

  await setup();

  const { keepRunning = false, interval = 24 } = cli.flags;

  if (keepRunning) {
    timer(0, interval * 3_600_000)
      .pipe(
        exhaustMap(async () => {
          await run();
        }),
      )
      .subscribe();
  } else {
    await run();
  }
}

async function setup() {
  const orfArchivDbUrlFile = process.env['ORFARCHIV_DB_URL_FILE'];
  if (orfArchivDbUrlFile) {
    try {
      const orfArchivDbUrl = await readFile(orfArchivDbUrlFile, 'utf8');
      process.env['ORFARCHIV_DB_URL'] = orfArchivDbUrl.trim();
    } catch (error) {
      logger.error(error.message);
    }
  }

  const orfArchivBackupDirFile = process.env['ORFARCHIV_BACKUP_DIR_FILE'];
  if (orfArchivBackupDirFile) {
    try {
      const orfArchivBackupDir = await readFile(orfArchivBackupDirFile, 'utf8');
      process.env['ORFARCHIV_BACKUP_DIR'] = orfArchivBackupDir.trim();
    } catch (error) {
      logger.error(error.message);
    }
  }
}

async function run() {
  try {
    await exportNews();
  } catch (error) {
    logger.error(error.message);
  }
}

async function exportNews() {
  const news = await withOrfArchivDb(async (newsCollection) => {
    logger.info('Fetching data...');
    return newsCollection.find().sort({ timestamp: -1 }).toArray();
  });

  logger.info('Persisting data to backup file...');
  const timestamp = getTimestamp();
  const backupPath = join(process.env.ORFARCHIV_BACKUP_DIR || '.backup');
  await mkdir(backupPath, { recursive: true });
  const backupFilePath = join(backupPath, `${timestamp}.json`);
  await writeFile(backupFilePath, JSON.stringify(news), { flag: 'w' });
  logger.info(`Backup file ${backupFilePath} created.`);
}

async function withOrfArchivDb(handler) {
  logger.info('Connecting to DB...');
  const url = process.env.ORFARCHIV_DB_URL?.trim() || 'mongodb://localhost';
  let client;
  try {
    client = await MongoClient.connect(url);
    const db = client.db('orfarchiv');
    const newsCollection = db.collection('news');
    return await handler(newsCollection);
  } catch (error) {
    throw new Error(`DB error. Cause ${error.message}`);
  } finally {
    await client?.close();
  }
}

function getTimestamp() {
  const now = new Date();
  const nowString = now.toISOString();
  return nowString.replaceAll(':', '').split('.')[0] + 'Z';
}
