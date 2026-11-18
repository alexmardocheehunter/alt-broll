# État QA : ALT B-ROLL (OpenCode)

> Dernière mise à jour : **18/11/2026, 16 h 20** · suite complète : **189 tests, 186 pass, 0 échec, 3 skips justifiés, 0 todo**
> Fichier de coordination : Claude et Alex peuvent s'y référer avant de livrer. QA ne modifie ni `backend/` ni `renderer/`.

## 1. Où en est le test

| Suite | Tests | État |
|---|---|---|
| Contrat (`tests/contract/`) | 73 | ✅ tout passe |
| Renderer + fixtures (`tests/renderer/`) | 31 | ✅ tout passe |
| Sécurité (`tests/security/`) | 35 | ✅ 34 pass, 1 skip (frontend absent) |
| Intégration (`tests/integration/`) | 50 | ✅ 48 pass, 2 skips justifiés |

Commandes : `cd tests` puis `npm test` (ou `test:contract`, `test:renderer`, `test:integration`, `test:security`).

## 2. Ce qui est réellement vérifié

- 100 % des objets de référence et des réponses HTTP livrées (création, lecture, statut, suggestions).
- Import réel : MP4 valide, rotation, audio, streaming Range, refus durée/audio/codec/signature/type/taille/nom malveillant.
- Schéma SQLite réel (WAL, colonnes, `CHECK`) et protocole worker (`claimNext`, `heartbeat`, `complete`, `fail`, `recoverStale`).
- Sécurité statique et HTTP : secrets, CORS, erreurs sans stack, traversée, `.env` non servi, 429, démarrage production sans clés.
- Aucun appel Groq/OpenRouter/Pixabay : les quatre variables sont forcées à `''` au lancement.

## 3. Bugs et constats ouverts

| ID | Gravité | Sujet | Emplacement | État |
|---|---|---|---|---|
| BUG-QA-001 | mineure | `completed` doit renvoyer `progress = 1` | `backend/src/services/render-state.ts` | ✅ **corrigé et vérifié le 18/11 à 16 h 20** |
| QA-OBS-002 | mineure | `recoverStale` laisse l'ancienne progression en `queued` | `shared/contract.ts` | ✅ **corrigé côté API : `preparing`/`queued` affichent 0** |
| QA-OBS-003 | mineure | `fail` accepte un code hors `RENDER_*` | `shared/contract.ts` | ✅ **corrigé côté API : code normalisé en `INTERNAL_ERROR`** |
| QA-OBS-004 | mineure | `heartbeat` ne borne pas `progress` | `shared/contract.ts:725` | ⏳ Codex : borner avant l'UPDATE |
| QA-OBS-005 | majeure | derrière un tunnel, un seul compteur 60/h pour tous | `backend/src/utils/rate-limit.ts` | 🟡 **mitigé** : `TRUST_PROXY` existe (`false`, `loopback`, 1‑9), testé ; valeur à fixer avec D-10 |
| QA-OBS-006 | **majeure** | vidéo source accessible sans authentification | `backend/src/routes/media.routes.ts` | 🔴 ouvert : dépend de D-04 |

Tests ajoutés pour verrouiller les corrections : progression `completed` = 1, `queued` = 0, code d'erreur normalisé, `X-Forwarded-For` ignoré sans `TRUST_PROXY`, quota par client derrière un proxy de confiance, refus de `TRUST_PROXY=true`.

Détail reproductible : [`tests/reports/2026-11-18-rapport-QA.md`](../tests/reports/2026-11-18-rapport-QA.md).

## 4. Demandes à Claude (backend)

1. **Livrer les routes restantes** conformément à `docs/API.md` : `POST …/analyze`, `PATCH …/timeline`, `POST …/render`, `GET …/render/status`, `GET …/download`, `DELETE /api/projects/:id`.
   - À chaque route livrée, la baseline `tests/integration/backend.test.ts` échouera avec « semble implémentée » : c'est normal, QA la remplacera par les assertions de contrat.
2. **Fournir un mode fournisseur hors ligne injectable** (QA-002), par exemple une variable `PROVIDER_MODE=mock` refusée en production, ou une interface d'injection utilisée par les tests. Sans cela, le parcours analyse → suggestions → timeline → rendu → download restera `skip` : QA n'appellera jamais les API réelles.
3. **Signaler tout changement de contrat** (`shared/contract.ts`) : les validateurs de `tests/lib/validation/` doivent suivre dans la même livraison.
4. Indiquer dans votre README la commande pour lancer vos propres tests backend ; QA ne les duplique pas.
5. Documenter `TRUST_PROXY` dans `.env.example` quand D-10 sera tranchée (valeur attendue : `loopback` pour un tunnel sur la même machine).

## 5. Demandes à Codex (worker)

1. Lire `shared/contract.ts` §6 et consommer `RENDER_JOB_SQL` **sans les réécrire**.
2. Borner `progress` dans `[0, 1]` avant `heartbeat` (le `CHECK` SQLite rejette l'écriture, il ne corrige pas).
3. N'écrire que des `error_code` de type `RENDER_*` dans `fail`.
4. Prévoir un mode d'exécution unique (un job puis sortie) pour que QA puisse tester le worker sur les fixtures, sans réseau.
5. Exposer un README avec la commande de test et le mode de lecture de `DATABASE_PATH`.

## 6. Demandes à Alex

1. Trancher **D-04** (contrôle d'accès) : sans elle, toutes les routes projets et la vidéo source sont ouvertes.
2. Trancher **D-06** (inclusion) : la règle actuelle est testée mais non validée.
3. Trancher **D-08** (H.264 seul) et **D-10** (tunnel HTTPS + `trust proxy`).
4. Trancher **D-13** (dépôt Git) : aucun historique des modifications pour l'instant.
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
- Rapport QA : [`tests/reports/2026-11-18-rapport-QA.md`](../tests/reports/2026-11-18-rapport-QA.md)
