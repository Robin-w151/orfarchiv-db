const BACKUP_FILE_NAME = /^(\d{4})-(\d{2})-(\d{2})T\d{6}Z\.json$/;

export interface RetentionPolicy {
  readonly keepDaily: number;
  readonly keepMonthly: number;
}

export function selectBackupsToPrune(fileNames: ReadonlyArray<string>, policy: RetentionPolicy): Array<string> {
  const backups = fileNames
    .map((fileName) => ({ fileName, match: BACKUP_FILE_NAME.exec(fileName) }))
    .filter((backup): backup is { fileName: string; match: RegExpExecArray } => backup.match !== null)
    .sort((a, b) => (a.fileName < b.fileName ? 1 : -1));

  const days = new Set<string>();
  const months = new Set<string>();
  const keep = new Set<string>(backups.slice(0, 1).map((backup) => backup.fileName));

  for (const { fileName, match } of backups) {
    const [, year, month, day] = match;
    const dayKey = `${year}-${month}-${day}`;
    const monthKey = `${year}-${month}`;

    if (!days.has(dayKey) && days.size < policy.keepDaily) {
      days.add(dayKey);
      keep.add(fileName);
    }

    if (!months.has(monthKey) && months.size < policy.keepMonthly) {
      months.add(monthKey);
      keep.add(fileName);
    }
  }

  return backups.map((backup) => backup.fileName).filter((fileName) => !keep.has(fileName));
}
