import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { jobFixturePath, projectFixturePath } from '../lib/paths.ts';
import { validateProject } from '../lib/validation/project.ts';
import { validateRenderJobPayload } from '../lib/validation/render-job.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mutable = any;

const projectFixture = JSON.parse(readFileSync(projectFixturePath('project.fixture.json'), 'utf8')) as { project: Mutable };
const jobFixture = JSON.parse(readFileSync(jobFixturePath('render-job.payload.landscape.json'), 'utf8')) as Mutable;

function mutateProject(change: (project: Mutable) => void): string[] {
  const copy = structuredClone(projectFixture);
  change(copy.project);
  return validateProject(copy.project);
}

function mutateJob(change: (payload: Mutable) => void): string[] {
  const copy = structuredClone(jobFixture);
  change(copy);
  return validateRenderJobPayload(copy);
}

function expectProblem(problems: readonly string[], fragment: string): void {
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `problème contenant « ${fragment} » attendu, reçu :\n  - ${problems.join('\n  - ') || '(aucun problème)'}`,
  );
}

describe('contrat : un projet hors contrat est rejeté', () => {
  it('version de schéma inconnue', () => {
    expectProblem(mutateProject((project) => { project.schemaVersion = 2; }), 'schemaVersion');
  });

  it('révision négative', () => {
    expectProblem(mutateProject((project) => { project.revision = -1; }), 'revision');
  });

  it('champ supplémentaire hors contrat (divergence entre composants)', () => {
    expectProblem(mutateProject((project) => { project.champInvente = true; }), 'champ inconnu du contrat');
  });

  it('source incohérente : audio absent mais codec renseigné', () => {
    expectProblem(mutateProject((project) => {
      project.source.audioPresent = false;
      project.source.audioCodec = 'aac';
    }), 'audioCodec');
  });

  it('nom de stockage tentant une traversée de chemin', () => {
    expectProblem(mutateProject((project) => { project.source.storedFileName = '../evil.mp4'; }), 'storedFileName');
  });

  it('type MIME non MP4', () => {
    expectProblem(mutateProject((project) => { project.source.mimeType = 'video/quicktime'; }), 'mimeType');
  });

  it('transcription dont les segments se chevauchent', () => {
    expectProblem(mutateProject((project) => { project.transcript.segments[1].startSeconds = 3; }), 'chevauche');
  });

  it('transcription qui dépasse la durée de la source', () => {
    expectProblem(mutateProject((project) => { project.transcript.segments[3].endSeconds = 31; }), 'dépasse la durée');
  });

  it('analyse failed sans erreur exploitable', () => {
    expectProblem(mutateProject((project) => {
      project.analysis.status = 'failed';
      project.analysis.error = null;
      project.analysis.stage = null;
    }), 'analysis.error');
  });

  it('analyse visuelle annoncée sans aucune image', () => {
    expectProblem(mutateProject((project) => {
      project.analysis.visualAnalysisAvailable = true;
      project.analysis.keyframes = [];
    }), 'visualAnalysisAvailable');
  });

  it('analyse completed avec une étape encore active', () => {
    expectProblem(mutateProject((project) => { project.analysis.stage = 'analyzing_content'; }), 'stage');
  });

  it('analyse completed sans modèle', () => {
    expectProblem(mutateProject((project) => { project.analysis.model = null; }), 'analysis.model');
  });

  it('analyse visuelle avec plus de 12 images', () => {
    expectProblem(mutateProject((project) => {
      project.analysis.visualAnalysisAvailable = true;
      project.analysis.keyframes = Array.from({ length: 13 }, (_, index) => ({ index, timeSeconds: index }));
    }), 'au plus 12');
  });

  it('index d’image clé en double', () => {
    expectProblem(mutateProject((project) => {
      project.analysis.visualAnalysisAvailable = true;
      project.analysis.keyframes = [{ index: 0, timeSeconds: 1 }, { index: 0, timeSeconds: 2 }];
    }), 'en double');
  });

  it('message d’erreur contenant un chemin serveur (fuite)', () => {
    expectProblem(mutateProject((project) => {
      project.analysis.status = 'failed';
      project.analysis.error = {
        code: 'INTERNAL_ERROR',
        stage: 'analysis',
        message: 'ENOENT C:\\secret\\storage\\projets\\abc',
        retryable: false,
      };
    }), 'chemin Windows exposé');
  });

  it('B-roll plus long que le candidat choisi', () => {
    expectProblem(mutateProject((project) => {
      const item = project.brollItems[0];
      item.selectedCandidateId = 'cand_fix_01b'; // 6 s
      item.endSeconds = 11.5; // 6,5 s
    }), 'durée du candidat choisi');
  });

  it('B-roll qui dépasse la durée de la source', () => {
    expectProblem(mutateProject((project) => {
      project.brollItems[3].startSeconds = 29;
      project.brollItems[3].endSeconds = 31;
    }), 'dépasse la durée de la source');
  });

  it('B-roll plus court que le minimum', () => {
    expectProblem(mutateProject((project) => {
      project.brollItems[3].startSeconds = 26;
      project.brollItems[3].endSeconds = 26.5;
    }), 'minimum 1 s');
  });

  it('B-roll plus long que le maximum de 10 s', () => {
    expectProblem(mutateProject((project) => {
      project.brollItems[3].startSeconds = 18;
      project.brollItems[3].endSeconds = 29;
    }), 'maximum 10 s');
  });

  it('plus de 4 candidats pour une suggestion', () => {
    expectProblem(mutateProject((project) => {
      const item = project.brollItems[1];
      for (let index = 0; index < 4; index += 1) {
        item.candidates.push({
          ...structuredClone(item.candidates[0]),
          id: `cand_fix_02_extra_${index}`,
          providerMediaId: `fixture-extra-${index}`,
        });
      }
    }), 'au plus 4 candidats');
  });

  it('identifiant de B-roll en double', () => {
    expectProblem(mutateProject((project) => { project.brollItems[1].id = 'br_fix_01'; }), 'en double');
  });

  it('candidat sélectionné absent de la liste', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].selectedCandidateId = 'cand_absent'; }), 'absent de candidates');
  });

  it('candidat sélectionné null alors que des candidats existent', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].selectedCandidateId = null; }), 'doit désigner un candidat');
  });

  it('cadrage hors contrat', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].fit = 'stretch'; }), 'fit');
  });

  it('fournisseur média non prévu', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].candidates[0].provider = 'pexels'; }), 'provider');
  });

  it('URL de prévisualisation non HTTP(S)', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].candidates[0].previewUrl = 'file:///C:/secret.mp4'; }), 'previewUrl');
  });

  it('candidat plus court que la durée du B-roll', () => {
    expectProblem(mutateProject((project) => { project.brollItems[0].candidates[0].durationSeconds = 3; }), 'durée du candidat choisi');
  });

  it('B-rolls montés qui se chevauchent', () => {
    expectProblem(mutateProject((project) => {
      project.brollItems[1].startSeconds = 8;
      project.brollItems[1].endSeconds = 12;
      project.timeline.segments[1].startSeconds = 8;
      project.timeline.segments[1].endSeconds = 12;
    }), 'chevau');
  });

  it('timeline sans un segment monté', () => {
    expectProblem(mutateProject((project) => { project.timeline.segments.pop(); }), 'segment(s) pour');
  });

  it('timeline avec un cadrage différent du B-roll', () => {
    expectProblem(mutateProject((project) => { project.timeline.segments[0].fit = 'contain'; }), 'fit');
  });

  it('timeline avec un segment orphelin', () => {
    expectProblem(mutateProject((project) => { project.timeline.segments[0].brollItemId = 'br_inconnu'; }), 'orphelin');
  });

  it('rendu completed sans fichier de sortie', () => {
    expectProblem(mutateProject((project) => {
      project.render = {
        status: 'completed',
        jobId: 'job_fixture_001',
        revision: 5,
        progress: 1,
        outputFile: null,
        startedAt: '2026-11-18T09:11:00.000Z',
        completedAt: '2026-11-18T09:12:00.000Z',
        error: null,
      };
    }), 'outputFile');
  });

  it('rendu completed sans progression à 1', () => {
    expectProblem(mutateProject((project) => {
      project.render = {
        status: 'completed',
        jobId: 'job_fixture_001',
        revision: 5,
        progress: 0.5,
        outputFile: { sizeBytes: 1000, durationSeconds: 30 },
        startedAt: '2026-11-18T09:11:00.000Z',
        completedAt: '2026-11-18T09:12:00.000Z',
        error: null,
      };
    }), 'progress');
  });

  it('rendu idle avec un job résiduel', () => {
    expectProblem(mutateProject((project) => { project.render.jobId = 'job_fixture_001'; }), 'status = idle');
  });

  it('rendu d’une révision future', () => {
    expectProblem(mutateProject((project) => {
      project.render = {
        status: 'queued',
        jobId: 'job_fixture_001',
        revision: 99,
        progress: 0,
        outputFile: null,
        startedAt: '2026-11-18T09:11:00.000Z',
        completedAt: null,
        error: null,
      };
    }), 'postérieure');
  });

  it('lien de téléchargement alors que le rendu n’est pas terminé', () => {
    expectProblem(mutateProject((project) => {
      project.urls.download = 'http://localhost:3000/api/projects/fixture_project_001/download';
    }), 'download');
  });

  it('lien source absent alors que la vidéo existe', () => {
    expectProblem(mutateProject((project) => { project.urls.source = null; }), 'doit être renseignée');
  });

  it('B-rolls sans vidéo source', () => {
    expectProblem(mutateProject((project) => { project.source = null; }), 'doit être vide');
  });
});

describe('contrat : un job de rendu hors contrat est rejeté', () => {
  it('version de schéma inconnue', () => {
    expectProblem(mutateJob((payload) => { payload.schemaVersion = 2; }), 'schemaVersion');
  });

  it('chemin de source avec traversée', () => {
    expectProblem(mutateJob((payload) => { payload.source.file = '../source/x.mp4'; }), 'file');
  });

  it('dimensions de sortie impaires', () => {
    expectProblem(mutateJob((payload) => { payload.output.width = 641; }), 'dimensions paires');
  });

  it('suréchantillonnage de la source', () => {
    expectProblem(mutateJob((payload) => {
      payload.output.width = 1280;
      payload.output.height = 720;
    }), 'supérieures à la source');
  });

  it('ratio de sortie supérieur à 16/9', () => {
    expectProblem(mutateJob((payload) => {
      payload.output.width = 640;
      payload.output.height = 160;
    }), 'ratio');
  });

  it('frame rate de sortie différent de la source', () => {
    expectProblem(mutateJob((payload) => { payload.output.frameRate = 25; }), 'attendu 30');
  });

  it('fichier de sortie hors du dossier output/', () => {
    expectProblem(mutateJob((payload) => { payload.output.file = 'source/mauvais.mp4'; }), 'dossier output');
  });

  it('média B-roll hors du dossier broll/', () => {
    expectProblem(mutateJob((payload) => { payload.segments[0].media.file = 'source/x.mp4'; }), 'dossier broll');
  });

  it('job sans aucun segment', () => {
    expectProblem(mutateJob((payload) => { payload.segments = []; }), 'au moins un segment');
  });

  it('segments chevauchants', () => {
    expectProblem(mutateJob((payload) => { payload.segments[1].startSeconds = 8; }), 'non triés ou chevauchants');
  });

  it('segment au-delà de la durée de la source', () => {
    expectProblem(mutateJob((payload) => { payload.segments[1].endSeconds = 31; }), 'dépasse la durée');
  });

  it('segment plus long que le média', () => {
    expectProblem(mutateJob((payload) => { payload.segments[0].media.durationSeconds = 3; }), 'durée du média');
  });

  it('segment plus long que 10 s', () => {
    expectProblem(mutateJob((payload) => {
      payload.segments[0].endSeconds = 16;
      payload.segments[1].startSeconds = 16;
    }), 'maximum 10');
  });

  it('identifiant de candidat invalide', () => {
    expectProblem(mutateJob((payload) => { payload.segments[0].candidateId = '../x'; }), 'candidateId');
  });

  it('champ inconnu dans le payload', () => {
    expectProblem(mutateJob((payload) => { payload.optionInconnue = true; }), 'champ inconnu du contrat');
  });
});
