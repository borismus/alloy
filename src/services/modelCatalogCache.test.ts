import { beforeEach, describe, expect, it } from 'vitest';
import { loadCachedModelCatalog, saveCachedModelCatalog } from './modelCatalogCache';

const models = [
  { key: 'provider/default', name: 'Default', provider: 'provider' },
  { key: 'local/model', name: 'Local model', provider: 'local', local: true },
];

beforeEach(() => localStorage.clear());

describe('model catalog cache', () => {
  it('roundtrips a catalog for the same vault', () => {
    saveCachedModelCatalog('/vault/a', models);
    expect(loadCachedModelCatalog('/vault/a')).toEqual(models);
  });

  it('keeps catalogs isolated by vault path', () => {
    saveCachedModelCatalog('/vault/a', models);
    expect(loadCachedModelCatalog('/vault/b')).toEqual([]);
  });

  it('ignores empty writes and corrupt or invalid entries', () => {
    saveCachedModelCatalog('/vault/a', models);
    saveCachedModelCatalog('/vault/a', []);
    expect(loadCachedModelCatalog('/vault/a')).toEqual(models);

    localStorage.setItem('alloy.modelCatalog.v1:/vault/a', '{broken');
    expect(loadCachedModelCatalog('/vault/a')).toEqual([]);

    localStorage.setItem('alloy.modelCatalog.v1:/vault/a', JSON.stringify([{ key: 'missing-name' }]));
    expect(loadCachedModelCatalog('/vault/a')).toEqual([]);
  });
});
