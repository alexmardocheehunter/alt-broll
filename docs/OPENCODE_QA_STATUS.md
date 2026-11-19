# État QA : ALT B-ROLL (OpenCode)

> Dernière mise à jour : **19/11/2026** · suite complète : **197 tests, 196 pass, 0 échec, 1 skip justifié, 0 todo**
> Fichier de coordination : Claude et Alex peuvent s'y référer avant de livrer. QA ne modifie ni `backend/` ni `renderer/`.

## 1. Où en est le test

| Suite | Tests | État |
|---|---|---|
| Contrat (`tests/contract/`) | 73 | ✅ tout passe |
| Renderer + fixtures (`tests/renderer/`) | 31 | ✅ tout passe |
| Sécurité (`tests/security/`) | 37 | ✅ 36 pass, 1 skip (frontend absent) |
| Intégration (`tests/integration/`) | 56 | ✅ tout passe |

Commandes : `cd tests` puis `npm test` (ou `test:contract`, `test:renderer`, `test:integration`, `test:security`).

## 2. Ce qui est réellement vérifié

- 100 % des objets de référence et des réponses HTTP livrées (création, lecture, statut, suggestions, analyse, timeline, rendu, statut de rendu, téléchargement).
- Import réel : MP4 valide, rotation, audio, streaming Range, refus durée/audio/codec/signature/type/taille/nom malveillant.
- Parcours P0 hors ligne complet avec `PROVIDER_MODE=mock` : import → `POST /analyze` 202 → `completed` → transcription et suggestions marquées « simulation » → édition de timeline → `POST /render` → worker Codex `--once` sur la même base et le même stockage → `completed` → `GET /download`, MP4 vérifié par ffprobe (640×360, ~30 s, audio conservé).
- Schéma SQLite réel (WAL, colonnes, `CHECK`) et protocole worker (`claimNext`, `heartbeat`, `complete`, `fail`, `recoverStale`) ; le worker réel est aussi exécuté de bout en bout.
- Sécurité statique et HTTP : secrets, CORS, erreurs sans stack, traversée, `.env` non servi, 429, démarrage production sans clés, refus de `PROVIDER_MODE=mock` et de `TRUST_PROXY=true` en production.
- Aucun appel Groq/OpenRouter/Pixabay : les quatre variables sont forcées à `''` au lancement ; le mode mock n'utilise que des URL `.invalid` et synthétise les médias avec FFmpeg en local.

## 3. Bugs et constats ouverts

| ID | Gravité | Sujet | Emplacement | État |
|---|---|---|---|---|
| BUG-QA-001 | mineure | `completed` doit renvoyer `progress = 1` | `backend/src/services/render-state.ts` | ✅ **corrigé par Claude, vérifié par QA** |
| QA-OBS-002 | mineure | `recoverStale` laisse l'ancienne progression en `queued` | `shared/contract.ts` | ✅ **corrigé côté API : `preparing`/`queued` affichent 0** |
| QA-OBS-003 | mineure | `fail` accepte un code hors `RENDER_*` | `shared/contract.ts` | ✅ **corrigé côté API : code normalisé en `INTERNAL_ERROR`** |
| QA-OBS-004 | mineure | `heartbeat` ne borne pas `progress` | `shared/contract.ts:734` | ✅ **corrigé côté worker** : clamp `[0, 0.99]` avant l'UPDATE ; le `CHECK` SQLite reste le garde-fou |
| QA-OBS-005 | majeure | derrière un tunnel, un seul compteur 60/h pour tous | `backend/src/utils/rate-limit.ts` | 🟡 **mitigé** : `TRUST_PROXY` existe (`false`, `loopback`, 1‑9), testé ; valeur à fixer avec D-10 |
| QA-OBS-006 | **majeure** | vidéo source accessible sans authentification | `backend/src/routes/media.routes.ts` | 🔴 ouvert : dépend de D-04 |

Tests ajoutés pour verrouiller les corrections : progression `completed` = 1, `queued` = 0, code d'erreur normalisé, `X-Forwarded-For` ignoré sans `TRUST_PROXY`, quota par client derrière un proxy de confiance, refus de `TRUST_PROXY=true`.

Détail reproductible : [`tests/reports/2026-11-19-rapport-QA-P0.md`](../tests/reports/2026-11-19-rapport-QA-P0.md).

## 4. Demandes à Claude (backend)

1. **Une seule route reste absente** : `DELETE /api/projects/:id` (`docs/API.md`, proposée D-11). La livrer ou la retirer de la spec tant que D-11 n'est pas tranchée ; la baseline 404 de `tests/integration/backend.test.ts` échouera volontairement à sa livraison.
2. **Signaler tout changement de contrat** (`shared/contract.ts`) : les validateurs de `tests/lib/validation/` doivent suivre dans la même livraison.
3. Documenter `TRUST_PROXY` dans `.env.example` quand D-10 sera tranchée (valeur attendue : `loopback` pour un tunnel sur la même machine).

Les routes d'analyse, timeline, rendu, statut et téléchargement livrées le 19/11 sont couvertes par le contrat et par le parcours P0 hors ligne (worker Codex inclus) : aucun écart bloquant détecté.

## 5. Demandes à Codex (worker)

1. Lire `shared/contract.ts` §6 et consommer `RENDER_JOB_SQL` **sans les réécrire** — c'est le cas dans `renderer/src/worker.ts`.
2. Borner `progress` dans `[0, 1]` avant `heartbeat` — ✅ fait (`[0, 0.99]`), testé côté protocole.
3. N'écrire que des `error_code` de type `RENDER_*` dans `fail` — à maintenir.
4. Mode `--once` — ✅ livré et exécuté par QA dans le parcours P0 (même base et même stockage que le backend).
5. Signaler toute modification de `shared/contract.ts` ou du payload : QA rejoue le parcours complet à chaque livraison.

## 6. Demandes à Alex

1. Trancher **D-04** (contrôle d'accès) : sans elle, toutes les routes projets et la vidéo source sont ouvertes.
2. Trancher **D-06** (inclusion) : la règle actuelle est testée mais non validée.
3. Trancher **D-08** (H.264 seul) et **D-10** (tunnel HTTPS + `trust proxy`).
4. **D-13** (dépôt Git) : dépôt initialisé et premier commit `9c4654e` ; les livraisons Claude/Codex restent non commitées, à organiser.
5. Livrer `frontend/` pour activer l'audit UX et les tests de synchronisation preview/export.

## 7. Protocole de collaboration

- QA relit `backend/` et `renderer/` à chaque livraison, sans les modifier.
- Toute route livrée fait échouer une baseline volontairement : QA la remplace par des tests de contrat et de parcours.
- Tout skip doit citer une dépendance et un responsable ; aucun skip silencieux.
- QA publie un rapport daté après chaque campagne dans `tests/reports/`.
- En cas de désaccord contrat/implémentation, **le contrat fait foi** jusqu'à arbitrage d'Alex ; le désaccord est inscrit ci-dessus, jamais contourné par un test complaisant.

## 8. Fichiers utiles

- Plan de test : [`docs/TEST_PLAN.md`](TEST_PLAN.md)
- Mode d'emploi des tests : [`tests/README.md`](../tests/README.md)
- Fixtures et provenance : [`tests/fixtures/README.md`](../tests/fixtures/README.md)
- Cartographie : [`tests/reports/2026-11-18-cartographie.md`](../tests/reports/2026-11-18-cartographie.md)
- Rapport en cours : [`tests/reports/2026-11-19-rapport-QA-P0.md`](../tests/reports/2026-11-19-rapport-QA-P0.md)
- Rapport de mise en place : [`tests/reports/2026-11-18-rapport-QA.md`](../tests/reports/2026-11-18-rapport-QA.md)
