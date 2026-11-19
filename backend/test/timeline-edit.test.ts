import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  AnalysisStatus,
  ApiErrorResponse,
  BrollCandidate,
  BrollItem,
  ErrorCode,
  Project,
  SourceVideo,
  UpdateTimelineResponse,
} from '../src/contract.ts';
import { createProjectRepository } from '../src/repositories/project.repository.ts';
import { initialAnalysis } from '../src/services/project.service.ts';
import { startTestApp, type TestApp } from './helpers.ts';

const SOURCE: SourceVideo = {
  originalName: 'video.mp4',
  storedFileName: 'source-test.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioPresent: true,
  audioCodec: 'aac',
};

function candidate(id: string, durationSeconds: number): BrollCandidate {
  return {
    id,
    provider: 'pixabay',
    providerMediaId: id,
    title: id,
    previewUrl: `https://cdn.pixabay.com/video/${id}-tiny.mp4`,
    downloadUrl: `https://cdn.pixabay.com/video/${id}.mp4`,
    sourcePageUrl: `https://pixabay.com/videos/${id}/`,
    thumbnailUrl: null,
    durationSeconds,
    width: 1920,
    height: 1080,
    attribution: 'Vidéo de test sur Pixabay',
  };
}

function item(id: string, startSeconds: number, endSeconds: number, candidates: BrollCandidate[], extra: Partial<BrollItem> = {}): BrollItem {
  return {
    id,
    startSeconds,
    endSeconds,
    reason: 'raison',
    searchQuery: 'query',
    candidates,
    selectedCandidateId: candidates[0]?.id ?? null,
    status: 'suggested',
    fit: 'cover',
    enabled: true,
    ...extra,
  };
}

describe('PATCH /api/projects/:id/timeline', () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp();
  });

  after(async () => {
    await app.close();
  });

  /** Projet analysé : A (5–8 s), B (20–24 s), C refusé (40–43 s). */
  function seedProject(analysisStatus: AnalysisStatus = 'completed'): string {
    const id = randomUUID();
    createProjectRepository(app.db).insert(
      id,
      {
        source: SOURCE,
        transcript: null,
        analysis: { ...initialAnalysis(), status: analysisStatus },
        brollItems: [
          item('broll_a', 5, 8, [candidate('cand_a1', 12), candidate('cand_a2', 3)]),
          item('broll_b', 20, 24, [candidate('cand_b1', 12)]),
          item('broll_c', 40, 43, [candidate('cand_c1', 12)], { status: 'rejected' }),
        ],
      },
      Date.now(),
    );
    return id;
  }

  async function patch(id: string, body: unknown): Promise<Response> {
    return fetch(`${app.baseUrl}/api/projects/${id}/timeline`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function expectRejected(res: Response, status: number, code: ErrorCode): Promise<ApiErrorResponse> {
    const body = (await res.json()) as ApiErrorResponse;
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(body.error.code, code);
    return body;
  }

  async function getProject(id: string): Promise<Project> {
    return ((await (await fetch(`${app.baseUrl}/api/projects/${id}`)).json()) as { project: Project }).project;
  }

  it('applique toutes les modifications, arrondit les temps et incrémente la révision', async () => {
    const id = seedProject();

    const res = await patch(id, {
      baseRevision: 0,
      items: [
        { id: 'broll_a', status: 'accepted', fit: 'contain' },
        { id: 'broll_b', startSeconds: 21.12345, endSeconds: 25.5 },
      ],
    });
    const { project } = (await res.json()) as UpdateTimelineResponse;

    assert.equal(res.status, 200);
    assert.equal(project.revision, 1);
    const [a, b] = project.brollItems;
    assert.deepEqual([a?.status, a?.fit], ['accepted', 'contain']);
    assert.deepEqual([b?.startSeconds, b?.endSeconds], [21.123, 25.5]);
    assert.deepEqual(
      project.timeline.segments.map((segment) => [segment.brollItemId, segment.startSeconds, segment.fit]),
      [
        ['broll_a', 5, 'contain'],
        ['broll_b', 21.123, 'cover'],
      ],
    );
  });

  it('retire de la timeline un B-roll mis de côté ou refusé, et y remet un B-roll réactivé', async () => {
    const id = seedProject();

    const paused = ((await (await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', enabled: false }] })).json()) as UpdateTimelineResponse).project;
    const restored = ((await (
      await patch(id, { baseRevision: 1, items: [{ id: 'broll_c', status: 'accepted' }] })
    ).json()) as UpdateTimelineResponse).project;

    assert.deepEqual(paused.timeline.segments.map((segment) => segment.brollItemId), ['broll_b']);
    assert.deepEqual(restored.timeline.segments.map((segment) => segment.brollItemId), ['broll_b', 'broll_c']);
  });

  it('remplace la vidéo choisie par une autre proposition', async () => {
    const id = seedProject();

    const res = await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', selectedCandidateId: 'cand_a2' }] });
    const { project } = (await res.json()) as UpdateTimelineResponse;

    assert.equal(res.status, 200);
    assert.equal(project.timeline.segments[0]?.candidateId, 'cand_a2');
  });

  it('refuse une révision périmée sans rien modifier (409 REVISION_CONFLICT)', async () => {
    const id = seedProject();
    await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', fit: 'contain' }] });

    await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_b', enabled: false }] }), 409, 'REVISION_CONFLICT');

    const project = await getProject(id);
    assert.equal(project.revision, 1);
    assert.equal(project.brollItems[1]?.enabled, true);
  });

  it("refuse un B-roll ou une vidéo inconnus, et n'applique alors aucune modification", async () => {
    const id = seedProject();

    await expectRejected(
      await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', fit: 'contain' }, { id: 'broll_inconnu', enabled: false }] }),
      422,
      'TIMELINE_INVALID',
    );
    await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', selectedCandidateId: 'cand_b1' }] }), 422, 'TIMELINE_INVALID');

    const project = await getProject(id);
    assert.equal(project.revision, 0);
    assert.equal(project.brollItems[0]?.fit, 'cover');
  });

  it('refuse un B-roll hors de la vidéo ou de durée hors des limites (1 à 10 s)', async () => {
    const id = seedProject();
    const refused = [
      { startSeconds: -1 },
      { endSeconds: 61 },
      { startSeconds: 7.9 },
      { endSeconds: 4 },
      { startSeconds: 5, endSeconds: 5.5 },
      { startSeconds: 5, endSeconds: 16 },
    ];

    for (const change of refused) {
      await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', ...change }] }), 422, 'TIMELINE_INVALID');
    }
  });

  it('refuse un B-roll plus long que la vidéo choisie, sauf s’il est raccourci dans la même requête (D-07)', async () => {
    const id = seedProject();

    const tooLong = await expectRejected(
      await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', selectedCandidateId: 'cand_a2', endSeconds: 9 }] }),
      422,
      'TIMELINE_INVALID',
    );
    const shortened = await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', selectedCandidateId: 'cand_a2', endSeconds: 8 }] });

    assert.match(tooLong.error.message, /plus que la vidéo choisie \(3 s\)/);
    assert.equal(shortened.status, 200);
  });

  it('refuse un chevauchement entre B-rolls montés, mais pas avec un B-roll refusé (422 TIMELINE_OVERLAP)', async () => {
    const id = seedProject();

    await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_b', startSeconds: 7, endSeconds: 10 }] }), 422, 'TIMELINE_OVERLAP');
    const overRejected = await patch(id, { baseRevision: 0, items: [{ id: 'broll_b', startSeconds: 41, endSeconds: 44 }] });

    assert.equal(overRejected.status, 200);
  });

  it('refuse un champ non modifiable ou un corps mal formé (400 VALIDATION_FAILED)', async () => {
    const id = seedProject();

    const readOnly = await expectRejected(
      await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', reason: 'piratage' }] }),
      400,
      'VALIDATION_FAILED',
    );
    await expectRejected(await patch(id, { items: [] }), 400, 'VALIDATION_FAILED');
    await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', status: 'valide' }] }), 400, 'VALIDATION_FAILED');

    assert.doesNotMatch(readOnly.error.message, /piratage/);
  });

  it("refuse toute modification pendant une analyse (409 CONFLICT)", async () => {
    const id = seedProject('processing');

    await expectRejected(await patch(id, { baseRevision: 0, items: [{ id: 'broll_a', fit: 'contain' }] }), 409, 'CONFLICT');
  });

  it('accepte une liste vide sans rien écrire', async () => {
    const id = seedProject();

    const res = await patch(id, { baseRevision: 0, items: [] });
    const { project } = (await res.json()) as UpdateTimelineResponse;

    assert.equal(res.status, 200);
    assert.equal(project.revision, 0);
  });

  it('répond 404 pour un projet inexistant', async () => {
    const res = await patch(randomUUID(), { baseRevision: 0, items: [] });

    assert.equal(res.status, 404);
  });
});
