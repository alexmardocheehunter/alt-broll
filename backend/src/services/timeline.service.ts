import type { BrollItem, Timeline, TimelineSegment } from '../contract.ts';

type MountedItem = BrollItem & { selectedCandidateId: string };

/**
 * Règle d'inclusion du contrat (proposition D-06), identique pour la preview et
 * l'export : actif, non refusé, avec un candidat choisi.
 */
export function isMounted(item: BrollItem): item is MountedItem {
  return item.enabled && item.status !== 'rejected' && item.selectedCandidateId !== null;
}

/** Montage calculé à partir des B-rolls : segments triés par instant de début. */
export function buildTimeline(items: readonly BrollItem[]): Timeline {
  const segments: TimelineSegment[] = items
    .filter(isMounted)
    .map((item) => ({
      brollItemId: item.id,
      candidateId: item.selectedCandidateId,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      fit: item.fit,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.brollItemId.localeCompare(b.brollItemId));
  return { segments };
}
