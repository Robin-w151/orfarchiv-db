import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { indexesFor, searchIndexDefinitionMatches, searchIndexesFor } from './model';

const [VECTOR_INDEX] = searchIndexesFor({ content: true });
const FIELDS = VECTOR_INDEX.definition.fields as Array<Document>;

describe('searchIndexesFor', () => {
  it('defines news_title_vector with a title and a content vector path and three filters', () => {
    expect(VECTOR_INDEX.name).toBe('news_title_vector');
    expect(FIELDS).toEqual([
      { type: 'vector', path: 'titleEmbedding', numDimensions: 256, similarity: 'cosine' },
      { type: 'vector', path: 'contentEmbedding', numDimensions: 512, similarity: 'cosine' },
      { type: 'filter', path: 'timestamp' },
      { type: 'filter', path: 'source' },
      { type: 'filter', path: 'category' },
    ]);
  });

  it('defines news_title_vector without the content path for excluded targets', () => {
    const [titleOnly] = searchIndexesFor({ content: false });
    expect(titleOnly.name).toBe('news_title_vector');
    expect(titleOnly.definition.fields).toEqual(FIELDS.filter((field) => field.path !== 'contentEmbedding'));
  });
});

describe('indexesFor', () => {
  it('has a content status index for the newest-first content backlog', () => {
    expect(indexesFor({ content: true }).find((index) => index.name === 'content_status_timestamp')?.key).toEqual({
      contentStatus: 1,
      timestamp: -1,
    });
  });

  it('has no content status index for excluded targets', () => {
    const titleOnly = indexesFor({ content: false });
    expect(titleOnly.map((index) => index.name)).not.toContain('content_status_timestamp');
    expect(titleOnly).toHaveLength(indexesFor({ content: true }).length - 1);
  });
});

describe('searchIndexDefinitionMatches', () => {
  it('matches an identical definition', () => {
    expect(searchIndexDefinitionMatches(VECTOR_INDEX.definition, { fields: FIELDS })).toBe(true);
  });

  it('ignores the order of the fields', () => {
    expect(searchIndexDefinitionMatches(VECTOR_INDEX.definition, { fields: [...FIELDS].reverse() })).toBe(true);
  });

  it('rejects the title-only definition', () => {
    const titleOnly = FIELDS.filter((field) => field.path !== 'contentEmbedding');
    expect(searchIndexDefinitionMatches(VECTOR_INDEX.definition, { fields: titleOnly })).toBe(false);
  });

  it('rejects a content path with different dimensions', () => {
    const fields = FIELDS.map((field) =>
      field.path === 'contentEmbedding' ? { ...field, numDimensions: 768 } : field,
    );
    expect(searchIndexDefinitionMatches(VECTOR_INDEX.definition, { fields })).toBe(false);
  });

  it('rejects a missing definition', () => {
    expect(searchIndexDefinitionMatches(VECTOR_INDEX.definition, undefined)).toBe(false);
  });
});
