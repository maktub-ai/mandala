import { expect, test } from 'vitest';
import { fixtureMemoryProfile } from './e2e/helpers/memory-profile';

const scene = (recordId: string, collectionId: string) => ({ recordId, collectionId, revision: 2, layer: 'L2' as const,
 text: 'Scene ' + recordId, semanticKey: 'scene.' + recordId, evidence: [{ sourceId: 'source-' + recordId, sourceRevision: 1 }] });
const prior = (recordId: string, collectionId: string) => ({ ...scene(recordId, collectionId), layer: 'L3' as const, semanticKey: 'persona.operating-doctrine' });

test('synthetic profile uses only target-collection scenes, evidence and prior persona', () => {
 const records = [scene('foreign-scene', 'other'), prior('foreign-prior', 'other'), scene('local-scene', 'target'), prior('local-prior', 'target')];
 expect(fixtureMemoryProfile({ collectionId: 'target', records })).toEqual([{
  collectionId: 'target', layer: 'L3', contentType: 'procedure', semanticKey: 'persona.operating-doctrine', text: 'Scene local-scene',
  operation: 'update', replaces: [{ recordId: 'local-prior', revision: 2 }], evidence: [{ sourceId: 'source-local-scene', sourceRevision: 1 }],
  support: [], dependencies: [{ recordId: 'local-scene', revision: 2 }], validUntil: null, certainty: 'observed',
 }]);
});
test('foreign prior persona cannot turn a new local profile into a cross-collection update', () => {
 const result = fixtureMemoryProfile({ collectionId: 'target', records: [prior('foreign-prior', 'other'), scene('local-scene', 'target')] });
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({ operation: 'store', replaces: [] });
});
test('foreign scenes alone never synthesize a local profile', () => {
 expect(fixtureMemoryProfile({ collectionId: 'target', records: [scene('foreign-scene', 'other'), prior('local-prior', 'target')] })).toEqual([]);
});
