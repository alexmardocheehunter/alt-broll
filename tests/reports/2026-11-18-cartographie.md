# Cartographie QA : ALT B-ROLL

> 18/11/2026 · OpenCode · tâche A de PROJECT_MASTER §9
> Objectif : situer les composants, les points de synchronisation et les incohérences détectées avant les tests.

## 1. Composants et flux

```
frontend/ (Alex, absent)          backend/ (Claude)                 renderer/ (Codex, absent)
  HTML/CSS/JS                        Express 5 + node:sqlite            worker SQLite + FFmpeg
       │                                  │                                  │
       │  HTTP JSON / multipart           │  écrit projects + render_jobs    │  lit/écrit render_jobs
       └───────────────► 127.0.0.1:3000 ──┴──────────► storage/ ◄─────────────┘
                                             ▲
                        Groq (transcription), OpenRouter (analyse),
                        Pixabay (B-rolls) : jamais appelés par les tests
```

| Composant | État | Responsable | Ce que QA peut vérifier |
|---|---|---|---|
| `shared/contract.ts` | proposition v1, à valider par Alex | Alex | types, constantes, DDL, requêtes SQL de référence |
| `backend/` | socle + projets + import + streaming livrés | Claude | HTTP réel, services importés, sécurité |
| `renderer/` | absent | Codex | seulement le protocole SQLite figé par le contrat |
| `frontend/` | absent | Alex | rien pour l'instant |
| `tests/` | 189 tests, 0 échec | OpenCode | — |

## 2. Points de synchronisation

| Point | Source de vérité | Risque de divergence | Test qui le fige |
|---|---|---|---|
| Forme du projet | `Project` dans `shared/contract.ts` | un champ renommé casse le frontend | `contract/schema.test.ts`, validateurs |
| Statuts | `ANALYSIS_STATUSES`, `RENDER_STATUSES` | valeur non prévue dans SQLite ou l'UI | `contract/rules.test.ts` |
| Erreurs | `ERROR_CODES`, `ErrorInfo` | code inconnu, message avec chemin | `contract/api.test.ts`, `security/api.test.ts` |
| Table `render_jobs` | `RENDER_JOBS_TABLE_SQL` | colonne ou contrainte différente | `integration/backend.test.ts` (schéma réel) |
| Requêtes worker | `RENDER_JOB_SQL` | sémantique de bail divergente | `renderer/protocol.test.ts` |
| Chemins de stockage | `STORAGE_LAYOUT`, `PROJECT_RELATIVE_FILE_PATTERN` | évasion du dossier projet | `integration/backend-units.test.ts` |
| Révisions | `Project.revision`, `REVISION_CONFLICT` | écrasement silencieux | tests services + 409 |
| Règle d'inclusion | D-06 (non tranchée) | preview ≠ export | `integration/backend-units.test.ts` |
| Temps | précision ms, alignement frame | décalage preview/export | `contract/negative.test.ts`, `render-job.ts` |
| Configuration | `.env` / `/api/config` | le frontend code des limites différentes | `integration/backend.test.ts` |

## 3. Contrat vs implémentation

### 3.1 Divergences réelles

| ID | Constat | Gravité | État |
|---|---|---|---|
| BUG-QA-001 | `toRenderState()` renvoyait `progress = row.progress` pour un job `completed` ; le contrat impose `progress = 1`. Un export terminé pouvait afficher 80 %. | mineure (affichage) | ✅ corrigé par Claude, vérifié par QA |
| QA-OBS-002 | `recoverStale` remet un job en `queued` sans remettre `progress` à 0. Entre la remise en file et le prochain `claimNext`, l'API pouvait afficher « en file » avec une ancienne progression. | mineure | ✅ corrigé : `preparing`/`queued` affichent 0 |
| QA-OBS-003 | `RENDER_JOB_SQL.fail` accepte n'importe quel `error_code` : rien n'impose un code `RENDER_*`. Un worker peut écrire `NOT_FOUND` dans un échec de rendu. | mineure (robustesse) | ✅ corrigé côté API (normalisation en `INTERNAL_ERROR`), à borne aussi côté worker |
| QA-OBS-004 | `heartbeat` ne borne pas `progress` ; seul le `CHECK` SQLite refuse une valeur hors `[0,1]`. Le worker doit borner avant l'UPDATE, sinon l'écriture échoue. | mineure (contrat worker) | ⏳ Codex |
| QA-OBS-005 | Sans `trust proxy`, derrière un tunnel (D-10) tous les clients partagent l'IP du tunnel : la limite de 60 écritures/h s'applique globalement. | majeure pour la bêta | 🟡 `TRUST_PROXY` configurable et testé ; valeur à fixer avec D-10 |
| QA-OBS-006 | `GET /media/source` n'est protégé que par l'identifiant du projet, non devinable mais non authentifié. Dépend de D-04. | majeure si bêta publique | 🔴 ouvert |

### 3.2 Routes : spécifié vs livré

| Route | docs/API.md | Réel |
|---|---|---|
| `GET /api/health`, `/api/config` | ✅ | ✅ |
| `POST /api/projects` | ✅ | ✅ |
| `POST /api/projects/:id/upload` | ✅ | ✅ |
| `GET /api/projects/:id` | ✅ | ✅ |
| `GET …/status`, `…/suggestions` | ✅ | ✅ |
| `GET …/media/source` | ✅ | ✅ (Range, CORS) |
| `POST …/analyze` | spécifié | **404** |
| `PATCH …/timeline` | spécifié | **404** |
| `POST …/render` | spécifié | **404** |
| `GET …/render/status` | spécifié | **404** |
| `GET …/download` | spécifié | **404** |
| `DELETE /api/projects/:id` | proposé D-11 | **404** |

La baseline 404 de `integration/backend.test.ts` échouera volontairement à la livraison de chaque route : c'est le signal de remplacement par les assertions de contrat.

### 3.3 Écarts de spécification à trancher

- **D-04** : aucun contrôle d'accès n'est branché. Toutes les routes projets sont ouvertes à qui connaît l'URL.
- **D-06** : la règle `enabled && status !== 'rejected' && selectedCandidateId !== null` est implémentée dans `timeline.service.ts` et testée, mais Alex ne l'a pas validée.
- **D-08** : H.264 seul accepté ; HEVC refusé. À confirmer.
- **D-10** : tunnel HTTPS + `trust proxy` à décider avant la bêta.
- **D-13** : pas de dépôt Git ; aucun historique des modifications.

## 4. Couverture par section du contrat

| Section | Contenu | Tests |
|---|---|---|
| §1 | versions, identifiants, règles | `contract/rules.test.ts`, validateurs |
| §2 | statuts analyse/rendu | `contract/rules.test.ts`, `negative.test.ts` |
| §3 | erreurs structurées | `contract/api.test.ts`, `security/*` |
| §4 | projet, source, transcription, analyse, B-rolls, timeline | `contract/schema.test.ts`, `negative.test.ts`, services |
| §5 | réponses HTTP | `contract/api.test.ts`, `integration/*` |
| §6 | jobs de rendu SQLite | `renderer/protocol.test.ts`, schéma réel |

**Non couvert, faute de composant :** rendu FFmpeg réel, conservation de l'audio, validation du MP4 final, preview frontend, synchronisation preview/export, perte réseau, E2E navigateur.

## 5. Dépendances des tests

| Dépendance | Utilisation | Absence |
|---|---|---|
| Node 24 | runner et TypeScript natif | bloquant |
| FFmpeg / ffprobe | fixtures et import | fixtures et import `skip` |
| Backend démarrable | intégration, sécurité | bloquant pour ces suites |
| `shared/contract.ts` | tout | bloquant |
| Worker | aucun test d'implémentation | protocole testé quand même |
| Frontend | aucun | audits UX et E2E `skip` |

Aucun test ne dépend d'une clé API, d'un compte cloud, d'un média tiers ou de `npm install`.
