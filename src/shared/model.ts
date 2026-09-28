import { NEWS_TITLE_VECTOR_INDEX, TITLE_EMBEDDING_DIMENSIONS, TITLE_EMBEDDING_FIELD } from '#common/search';
import { Equal } from 'effect';
import type { Document, IndexDescription, SearchIndexDescription } from 'mongodb';

export type NamedIndexDescription = IndexDescription & { name: string };
export type NamedSearchIndexDescription = SearchIndexDescription & { name: string };

export const indexes: NamedIndexDescription[] = [
  {
    key: { id: 1 },
    name: 'id_asc',
  },
  {
    key: { id: -1 },
    name: 'id_desc',
  },
  {
    key: { timestamp: 1 },
    name: 'timestamp_asc',
  },
  {
    key: { timestamp: -1 },
    name: 'timestamp_desc',
  },
  {
    key: { timestamp: -1, id: -1 },
    name: 'timestamp_id_desc',
  },
  {
    key: { category: 1 },
    name: 'category_asc',
  },
  {
    key: { url: 1 },
    name: 'url_asc',
  },
  {
    key: { source: 1 },
    name: 'source_asc',
  },
];

export const searchIndexes: NamedSearchIndexDescription[] = [
  {
    name: NEWS_TITLE_VECTOR_INDEX,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: TITLE_EMBEDDING_FIELD,
          numDimensions: TITLE_EMBEDDING_DIMENSIONS,
          similarity: 'cosine',
        },
        { type: 'filter', path: 'timestamp' },
        { type: 'filter', path: 'source' },
        { type: 'filter', path: 'category' },
      ],
    },
  },
];

export function indexMatches(expected: NamedIndexDescription, actual: Document | undefined): boolean {
  return (
    !!actual &&
    actual.name === expected.name &&
    Equal.equals(Object.entries(actual.key ?? {}), Object.entries(expected.key))
  );
}

export function searchIndexDefinitionMatches(desired: Document, latest: Document | undefined): boolean {
  const desiredFields = (desired.fields ?? []) as Array<Document>;
  const latestFields = (latest?.fields ?? []) as Array<Document>;
  if (desiredFields.length !== latestFields.length) {
    return false;
  }

  return desiredFields.every((desiredField) => {
    const latestField = latestFields.find(
      (field) => field.type === desiredField.type && field.path === desiredField.path,
    );
    return !!latestField && Object.entries(desiredField).every(([key, value]) => Equal.equals(value, latestField[key]));
  });
}
