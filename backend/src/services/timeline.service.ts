import { z } from 'zod';
import {
  BROLL_FITS,
  BROLL_ITEM_STATUSES,
  ID_PATTERN,
  TIMELINE_RULES,
  type BrollItem,
  type BrollItemPatch,
  type Project,
  type Timeline,
  type TimelineSegment,
} from '../contract.ts';
import { AppError } from '../utils/errors.ts';
import { parseBody } from '../utils/validation.ts';
import type { ProjectService } from './project.service.ts';

type MountedItem = BrollItem & { selectedCandidateId: string };

/** Tolérance de comparaison des temps, déjà arrondis à la milliseconde. */
const TIME_EPSILON = 1e-6;

/**
 * Règle d'inclusion du contrat (décision D-06), identique pour la preview et
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

/** Corps de PATCH /timeline : seuls les champs de EDITABLE_BROLL_FIELDS sont acceptés. */
const timelinePatchSchema = z.strictObject({
  baseRevision: z.number().int().min(0),
  items: z
    .array(
      z.strictObject({
        id: z.string().regex(ID_PATTERN),
        startSeconds: z.number().optional(),
        endSeconds: z.number().optional(),
        selectedCandidateId: z.string().regex(ID_PATTERN).optional(),
        status: z.enum(BROLL_ITEM_STATUSES).optional(),
        fit: z.enum(BROLL_FITS).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .max(TIMELINE_RULES.maxBrollItems),
});

/** PATCH /api/projects/:id/timeline : modifications appliquées en entier ou pas du tout, révision + 1. */
export function updateTimeline(projects: ProjectService, projectId: string, body: unknown): Project {
  const request = parseBody(timelinePatchSchema, body, 'timeline');
  const record = projects.requireRecord(projectId);
  const { analysis, source, brollItems } = record.document;

  if (analysis.status === 'queued' || analysis.status === 'processing') {
    throw new AppError({
      code: 'CONFLICT',
      stage: 'timeline',
      httpStatus: 409,
      retryable: true,
      message: "Une analyse est en cours : les B-rolls seront modifiables quand elle sera terminée.",
    });
  }
  if (request.baseRevision !== record.revision) {
    throw new AppError({
      code: 'REVISION_CONFLICT',
      stage: 'timeline',
      httpStatus: 409,
      retryable: true,
      message: 'Le montage a été modifié entre-temps. Rechargez le projet puis refaites la modification.',
    });
  }
  if (request.items.length === 0) return projects.toProject(record);
  if (source === null) throw timelineInvalid("Ce projet n'a pas encore de vidéo.");

  const updated = applyTimelinePatch(brollItems, request.items, source.durationSeconds);
  return projects.toProject(projects.save(record, { ...record.document, brollItems: updated }));
}

/**
 * Applique les modifications puis vérifie les règles du contrat : temps dans la vidéo,
 * durée de 1 à 10 s, candidat de l'élément, durée ≤ vidéo choisie (D-07), aucun
 * chevauchement entre B-rolls montés. Lève une erreur au premier problème.
 */
export function applyTimelinePatch(
  items: readonly BrollItem[],
  patches: readonly BrollItemPatch[],
  durationSeconds: number,
): BrollItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const changed = new Map<string, BrollItem>();

  for (const patch of patches) {
    if (changed.has(patch.id)) throw timelineInvalid('Un même B-roll est modifié deux fois dans la requête.');
    const current = byId.get(patch.id);
    if (current === undefined) throw timelineInvalid("Ce B-roll n'existe pas dans le projet : rechargez le projet.");

    const next: BrollItem = {
      ...current,
      startSeconds: patch.startSeconds === undefined ? current.startSeconds : round3(patch.startSeconds),
      endSeconds: patch.endSeconds === undefined ? current.endSeconds : round3(patch.endSeconds),
      selectedCandidateId: patch.selectedCandidateId ?? current.selectedCandidateId,
      status: patch.status ?? current.status,
      fit: patch.fit ?? current.fit,
      enabled: patch.enabled ?? current.enabled,
    };
    assertValidItem(next, durationSeconds);
    changed.set(next.id, next);
  }

  const result = items.map((item) => changed.get(item.id) ?? item);
  assertNoOverlap(result);
  return result;
}

function assertValidItem(item: BrollItem, durationSeconds: number): void {
  const { minSegmentSeconds, maxSegmentSeconds } = TIMELINE_RULES;
  if (item.startSeconds < 0 || item.endSeconds > durationSeconds + TIME_EPSILON || item.endSeconds <= item.startSeconds) {
    throw timelineInvalid(
      `Un B-roll doit commencer après 0 s, finir avant ${formatSeconds(durationSeconds)} (fin de la vidéo) et finir après son début.`,
    );
  }
  const length = item.endSeconds - item.startSeconds;
  if (length < minSegmentSeconds - TIME_EPSILON || length > maxSegmentSeconds + TIME_EPSILON) {
    throw timelineInvalid(`Un B-roll dure entre ${minSegmentSeconds} et ${maxSegmentSeconds} s.`);
  }
  if (item.selectedCandidateId === null) return;
  const selected = item.candidates.find((candidate) => candidate.id === item.selectedCandidateId);
  if (selected === undefined) throw timelineInvalid("La vidéo choisie ne fait pas partie des propositions de ce B-roll.");
  if (isMounted(item) && length > selected.durationSeconds + TIME_EPSILON) {
    throw timelineInvalid(
      `Ce B-roll dure ${formatSeconds(length)}, plus que la vidéo choisie (${formatSeconds(selected.durationSeconds)}) : raccourcissez-le.`,
    );
  }
}

function assertNoOverlap(items: readonly BrollItem[]): void {
  const mounted = items.filter(isMounted).sort((a, b) => a.startSeconds - b.startSeconds);
  for (let index = 1; index < mounted.length; index += 1) {
    const previous = mounted[index - 1];
    const current = mounted[index];
    if (previous !== undefined && current !== undefined && current.startSeconds < previous.endSeconds - TIME_EPSILON) {
      throw new AppError({
        code: 'TIMELINE_OVERLAP',
        stage: 'timeline',
        httpStatus: 422,
        message: `Deux B-rolls se chevauchent autour de ${formatSeconds(current.startSeconds)} : décalez ou raccourcissez l'un des deux.`,
      });
    }
  }
}

function timelineInvalid(message: string): AppError {
  return new AppError({ code: 'TIMELINE_INVALID', stage: 'timeline', httpStatus: 422, message });
}

function formatSeconds(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toString().replace('.', ',')} s`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
