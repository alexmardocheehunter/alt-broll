import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrollItem } from '../src/contract.ts';
import { buildTimeline, isMounted } from '../src/services/timeline.service.ts';

function item(id: string, overrides: Partial<BrollItem> = {}): BrollItem {
  return {
    id,
    startSeconds: 0,
    endSeconds: 2,
    reason: 'raison',
    searchQuery: 'query',
    candidates: [],
    selectedCandidateId: `cand_${id}`,
    status: 'suggested',
    fit: 'cover',
    enabled: true,
    ...overrides,
  };
}

describe('buildTimeline', () => {
  it('monte les B-rolls actifs, non refusés et pourvus d’un candidat, triés par début', () => {
    const timeline = buildTimeline([
      item('b3', { startSeconds: 40, endSeconds: 43, fit: 'contain' }),
      item('refuse', { startSeconds: 10, endSeconds: 12, status: 'rejected' }),
      item('b1', { startSeconds: 5, endSeconds: 8, status: 'accepted' }),
      item('en_pause', { startSeconds: 20, endSeconds: 22, enabled: false }),
      item('sans_candidat', { startSeconds: 30, endSeconds: 32, selectedCandidateId: null }),
    ]);

    assert.deepEqual(timeline.segments, [
      { brollItemId: 'b1', candidateId: 'cand_b1', startSeconds: 5, endSeconds: 8, fit: 'cover' },
      { brollItemId: 'b3', candidateId: 'cand_b3', startSeconds: 40, endSeconds: 43, fit: 'contain' },
    ]);
  });

  it('renvoie une timeline vide sans B-roll', () => {
    assert.deepEqual(buildTimeline([]), { segments: [] });
  });

  it("applique la règle d'inclusion du contrat", () => {
    assert.equal(isMounted(item('a')), true);
    assert.equal(isMounted(item('b', { status: 'accepted' })), true);
    assert.equal(isMounted(item('c', { status: 'rejected' })), false);
    assert.equal(isMounted(item('d', { enabled: false })), false);
    assert.equal(isMounted(item('e', { selectedCandidateId: null })), false);
  });
});
