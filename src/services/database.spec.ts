import { describe, expect, it } from 'vitest';
import { toBackupStory } from './database';

const STORY = { id: 'news:1', title: 'Teuerung befeuert die Schwarzarbeit' };

describe('toBackupStory', () => {
  it('drops an embedded content status, since the embedding is not backed up', () => {
    expect(toBackupStory({ ...STORY, contentStatus: 'embedded' })).toEqual(STORY);
  });

  it('keeps a failed content status, so dead pages are not fetched again after a restore', () => {
    expect(toBackupStory({ ...STORY, contentStatus: 'failed' })).toEqual({ ...STORY, contentStatus: 'failed' });
  });

  it('leaves stories without a content status unchanged', () => {
    expect(toBackupStory(STORY)).toEqual(STORY);
  });
});
