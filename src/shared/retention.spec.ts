import { describe, expect, it } from 'vitest';
import { selectBackupsToPrune } from './retention';

describe('selectBackupsToPrune', () => {
  it('keeps the newest file per day for the newest n days', () => {
    const fileNames = [
      '2026-09-28T030000Z.json',
      '2026-09-29T030000Z.json',
      '2026-09-30T030000Z.json',
      '2026-09-30T150000Z.json',
      '2026-10-01T030000Z.json',
    ];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 2, keepMonthly: 0 })).toEqual([
      '2026-09-30T030000Z.json',
      '2026-09-29T030000Z.json',
      '2026-09-28T030000Z.json',
    ]);
  });

  it('keeps the newest file per month for the newest m months', () => {
    const fileNames = [
      '2026-07-01T030000Z.json',
      '2026-07-31T030000Z.json',
      '2026-08-01T030000Z.json',
      '2026-08-31T030000Z.json',
      '2026-09-15T030000Z.json',
    ];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 0, keepMonthly: 2 })).toEqual([
      '2026-08-01T030000Z.json',
      '2026-07-31T030000Z.json',
      '2026-07-01T030000Z.json',
    ]);
  });

  it('combines daily and monthly retention', () => {
    const fileNames = [
      '2026-07-15T030000Z.json',
      '2026-08-01T030000Z.json',
      '2026-08-20T030000Z.json',
      '2026-09-29T030000Z.json',
      '2026-09-30T030000Z.json',
      '2026-09-30T150000Z.json',
      '2026-10-01T090952Z.json',
    ];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 2, keepMonthly: 2 })).toEqual([
      '2026-09-30T030000Z.json',
      '2026-09-29T030000Z.json',
      '2026-08-20T030000Z.json',
      '2026-08-01T030000Z.json',
      '2026-07-15T030000Z.json',
    ]);
  });

  it('never selects foreign or partial files', () => {
    const fileNames = [
      '2026-09-29T030000Z.json',
      '2026-09-30T030000Z.json',
      '2026-09-30T030000Z.json.partial',
      '2026-09-30.json',
      'notes.txt',
      'backup.json',
    ];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 1, keepMonthly: 0 })).toEqual(['2026-09-29T030000Z.json']);
  });

  it('always keeps the newest file, even with an empty policy', () => {
    const fileNames = ['2026-09-29T030000Z.json', '2026-09-30T030000Z.json'];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 0, keepMonthly: 0 })).toEqual(['2026-09-29T030000Z.json']);
  });

  it('counts days with backups, not calendar days', () => {
    const fileNames = ['2026-09-01T030000Z.json', '2026-09-10T030000Z.json', '2026-09-30T030000Z.json'];

    expect(selectBackupsToPrune(fileNames, { keepDaily: 3, keepMonthly: 0 })).toEqual([]);
  });

  it('does not depend on the input order', () => {
    const sorted = ['2026-09-28T030000Z.json', '2026-09-29T030000Z.json', '2026-09-30T030000Z.json'];
    const shuffled = [sorted[1], sorted[2], sorted[0]];

    expect(selectBackupsToPrune(shuffled, { keepDaily: 1, keepMonthly: 0 })).toEqual(
      selectBackupsToPrune(sorted, { keepDaily: 1, keepMonthly: 0 }),
    );
  });

  it('returns nothing for an empty directory', () => {
    expect(selectBackupsToPrune([], { keepDaily: 7, keepMonthly: 12 })).toEqual([]);
  });
});
