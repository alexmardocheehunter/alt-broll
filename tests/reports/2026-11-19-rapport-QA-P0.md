# Rapport QA : ALT B-ROLL — parcours P0 hors ligne

> 19/11/2026 · OpenCode · campagne après livraison de l'analyse, du rendu et du worker
> Suite : **197 tests, 196 réussis, 1 ignoré justifié, 0 échec, 0 todo**.

## 1. Résumé

- Les routes livrées le 19/11 sont couvertes : `POST …/analyze`, `PATCH …/timeline`, `POST …/render`, `GET …/render/status`, `GET …/download`.
- Le parcours P0 complet est joué **sans réseau** : `PROVIDER_MODE=mock` pour l'analyse, puis le worker Codex `--once` sur la même base SQLite et le même stockage temporaires.
- Le MP4 final est téléchargé puis vérifié par ffprobe : 640×360, durée ~30 s, piste audio d'origine conservée.
- Aucun appel Groq, OpenRouter ou Pixabay : les clés sont forcées à `''`, les URL simulées utilisent `.invalid` et les B-rolls simulés sont synthétisés localement par FFmpeg.
- Un écart de validateur QA a été corrigé (`startedAt` d'un job `preparing`), et un timeout de démarrage backend s'est révélé transitoire (repassé sans modification).
- Aucun nouveau défaut backend, worker ou contrat détecté pendant cette campagne.

## 2. Livraisons vérifiées

| Route / composant | Vérifications |
|---|---|
| `POST /api/projects/:id/analyze` | 202 `queued`, refus sans fournisseur (`PROVIDER_NOT_CONFIGURED`), analyse simulée jusqu'à `completed`, transcription `provider: 'simulation'`, textes `[Simulation]` |
| `GET /api/projects/:id/suggestions` | 4 B-rolls simulés, 2 candidats chacun, premier candidat proposé par défaut, timeline cohérente |
| `PATCH /api/projects/:id/timeline` | modification persistée, 409 `REVISION_CONFLICT`, 422 `TIMELINE_OVERLAP` / `TIMELINE_INVALID`, désactivation retirée du montage |
| `POST /api/projects/:id/render` | 202 `preparing`, préparation et vérification des médias, passage `queued`, refus révision périmée (409) et montage vide (422 `RENDER_NO_SEGMENTS`) |
| `GET /api/projects/:id/render/status` | `idle` conforme, `preparing` avec `startedAt = null`, `queued`, `completed` avec progression 1 et `outputFile` |
| `GET /api/projects/:id/download` | 200 `video/mp4`, `Content-Disposition: attachment`, `Content-Length` exact, refus 409 `DOWNLOAD_NOT_READY` sans export |
| Worker `renderer/src/worker.ts` | `--once`, bail et progression, sortie 0, MP4 final lisible, audio conservé, durée et dimensions conformes |
| `PROVIDER_MODE=mock` | refusé en production par la configuration (test dédié) |

## 3. Constats

### QA-OBS-004 : progression du heartbeat — résolu côté worker

- **État :** ✅ le worker borne la valeur avec `Math.max(0, Math.min(0.99, progress))` avant `heartbeat`.
- **Garde-fou :** le `CHECK` SQLite continue de refuser toute valeur hors `[0, 1]` ; le test de protocole le vérifie.
- **Reste :** aucun.

### Validateur QA : `startedAt` d'un job `preparing`

- **État :** ✅ corrigé dans `tests/lib/validation/project.ts`.
- **Cause :** le validateur exigeait `startedAt` dès qu'un job existait, alors que le contrat et le backend le laissent `null` tant que le worker n'a pas pris le job (`preparing`, `queued`).
- **Correction :** `startedAt` est désormais exigé pour `rendering`, `completed` et `failed`.

### Timeout de démarrage backend (test `MAX_UPLOAD_MB`)

- **État :** ✅ non reproductible. Le test est repassé sans modification (2,1 s) et la suite complète est verte.
- **Cause probable :** charge ponctuelle pendant l'exécution parallèle des suites.

### Constats toujours ouverts

| ID | Gravité | Sujet | Responsable |
|---|---|---|---|
| QA-OBS-005 | majeure pour la bêta | limite de débit derrière un tunnel : `TRUST_PROXY` est configurable et testé, valeur finale à fixer avec D-10 | Alex |
| QA-OBS-006 / D-04 | majeure si bêta publique | vidéo source et routes projets accessibles sans authentification | Alex |
| SQL `heartbeat` | mineure | le SQL partagé ne borne pas lui-même `progress` ; le worker le fait, le `CHECK` refuse le reste | Codex / contrat |

## 4. Blocages (dépendances, pas des bugs)

| ID | Blocage | Responsable | Impact QA |
|---|---|---|---|
| QA-DEP-001 | `DELETE /api/projects/:id` absent (404, D-11) | Claude / Alex | suppression non testable ; baseline volontaire |
| QA-DEP-004 | `frontend/` absent | Alex | pas d'audit UX, de preview ni d'E2E navigateur |
| QA-DEP-005 | D-04, D-06, D-08, D-10 non tranchées | Alex | sécurité, inclusion, codecs, exposition |

## 5. Limites des tests actuels

- Le parcours P0 utilise les fournisseurs simulés : il ne prouve pas le comportement des API Groq/OpenRouter/Pixabay réelles.
- La preview frontend et sa correspondance exacte avec l'export ne sont pas testables sans `frontend/`.
- Les tests de rendu vérifient un paysage 640×360 ; le portrait et la rotation restent couverts par les fixtures et les tests du worker, pas par le parcours HTTP complet.
- La limite de débit est testée sur une seule instance ; le multi-clients est simulé via `X-Forwarded-For` avec `TRUST_PROXY=loopback`.

## 6. Demandes

**À Claude :**

1. Livrer ou retirer de `docs/API.md` la route `DELETE /api/projects/:id` (D-11).
2. Signaler tout changement de `shared/contract.ts` : les validateurs QA suivent dans la même livraison.
3. Documenter `TRUST_PROXY` dans `.env.example` quand D-10 sera tranchée.

**À Alex :**

1. Trancher D-04 (accès), D-06 (inclusion), D-08 (codecs), D-10 (tunnel/`trust proxy`).
2. Livrer `frontend/` pour l'audit UX et la synchronisation preview/export.
3. Organiser les commits : le dépôt existe (`9c4654e`) mais les livraisons restent non commitées.

**À Codex :**

1. Maintenir le bornage de `progress` et les codes `RENDER_*` ; signaler toute évolution du payload ou du contrat.

## 7. Conclusion

Le produit est désormais testable de bout en bout hors ligne : import, analyse, édition, rendu worker et téléchargement sont couverts par un parcours réel sur base et stockage temporaires. Les risques restants sont opérationnels (contrôle d'accès, exposition derrière un tunnel) ou liés à des composants absents (frontend, suppression), pas des défauts de code constatés.
