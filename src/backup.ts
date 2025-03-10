import { CronJob } from 'cron';
import dotenv from 'dotenv-flow';
import { mkdir, readFile, writeFile } from 'fs/promises';
import meow from 'meow';
import { Collection, MongoClient, type WithId } from 'mongodb';
import { join } from 'path';
import logger from './logger.ts';

dotenv.config({ silent: true });

main().catch(logger.error);

async function main(): Promise<void> {
  const cli = meow(
    `
    Usage
      $ db-backup

    Options
      --keep-running  Keep running until interrupted
      --cron          Interval in cron syntax (default: 0 0 3 * * *, e.g. backup every day at 3am)

    Examples
      $ db-backup
      $ db-backup --keep-running --cron "0 0 3 * * *"
    `,
    {
      importMeta: import.meta,
      flags: {
        keepRunning: {
          type: 'boolean',
          default: false,
        },
        cron: {
          type: 'string',
          default: '0 0 3 * * *',
        },
      },
    },
  );

  await setup();

  const { keepRunning, cron } = cli.flags;

  if (keepRunning) {
    CronJob.from({
      cronTime: cron,
      onTick: () => {
        run();
      },
      start: true,
    });
  } else {
    await run();
  }
}

async function setup(): Promise<void> {
  const orfArchivDbUrlFile = process.env['ORFARCHIV_DB_URL_FILE'];
  if (orfArchivDbUrlFile) {
    try {
      const orfArchivDbUrl = await readFile(orfArchivDbUrlFile, 'utf8');
      process.env['ORFARCHIV_DB_URL'] = orfArchivDbUrl.trim();
    } catch (error) {
      logger.error((error as Error).message);
    }
  }

  const orfArchivBackupDirFile = process.env['ORFARCHIV_BACKUP_DIR_FILE'];
  if (orfArchivBackupDirFile) {
    try {
      const orfArchivBackupDir = await readFile(orfArchivBackupDirFile, 'utf8');
      process.env['ORFARCHIV_BACKUP_DIR'] = orfArchivBackupDir.trim();
    } catch (error) {
      logger.error((error as Error).message);
    }
  }
}

async function run(): Promise<void> {
  try {
    await exportNews();
  } catch (error) {
    logger.error((error as Error).message);
  }
}

async function exportNews(): Promise<void> {
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

async function withOrfArchivDb(
  handler: (newsCollection: Collection<Document>) => Promise<WithId<Document>[]>,
): Promise<WithId<Document>[]> {
  logger.info('Connecting to DB...');
  const url = process.env.ORFARCHIV_DB_URL?.trim() || 'mongodb://localhost';
  let client;
  try {
    client = await MongoClient.connect(url);
    const db = client.db('orfarchiv');
    const newsCollection = db.collection<Document>('news');
    return await handler(newsCollection);
  } catch (error) {
    throw new Error(`DB error. Cause ${(error as Error).message}`);
  } finally {
    await client?.close();
  }
}

function getTimestamp(): string {
  const now = new Date();
  const nowString = now.toISOString();
  return nowString.replaceAll(':', '').split('.')[0] + 'Z';
}
