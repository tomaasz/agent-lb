// Upstream IDs for the existing metadata/formatting contract tests. Availability
// discovery is exercised separately against mutable HTTP provider fixtures.
import { MODEL_METADATA } from '../../src/model-metadata.js';
export const modelCatalogFixture = {
  list: async () => MODEL_METADATA.filter(m => !m.unlisted).map(m => ({ id: m.id })),
};
