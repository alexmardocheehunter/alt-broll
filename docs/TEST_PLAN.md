# Plan de test : ALT B-ROLL

> Version 1.0 · 18/11/2026 · OpenCode (QA)
> Référence : `PROJECT_MASTER.txt` §9 (responsabilités OpenCode). Ce plan décrit ce qui est vérifié, comment, et ce qui bloque encore.

## 1. Objectif et périmètre

**Objectif.** Rendre vérifiable le contrat commun (`shared/contract.ts`) et détecter tôt les défauts d'intégration entre le backend (Claude), le worker (Codex) et le frontend (Alex), sans jamais appeler Groq, OpenRouter ou Pixabay.

**Dans le périmètre :**

- validation exécutable du contrat et de ses invariants ;
- fixtures média et JSON reproductibles, sans donnée tierce ;
- tests du backend réel en HTTP (boîte noire) et de ses services (boîte blanche) ;
- protocole SQLite backend → worker exécuté sur une base en mémoire ;
- audit statique et dynamique de sécurité ;
- rapports datés et priorisés.

**Hors périmètre :**

- réécriture du backend ou du worker (OpenCode ne les modifie pas) ;
- UX visuelle du frontend (audit possible dès qu'Alex livre `frontend/`) ;
- appels aux fournisseurs IA réels ;
- tests de charge et de montée en échelle (bêta mono-instance) ;
- FFmpeg réel dans le worker : le worker n'existe pas encore.

## 2. Risques priorisés

| # | Risque | Impact | Couverture actuelle |
|---|---|---|---|
| R1 | Divergence entre le contrat et le backend | écran cassé, export refusé | validateurs de contrat + tests de services + réponses HTTP |
| R2 | Parcours P0 incomplet à l'ouverture de la bêta | produit inutilisable | baseline des routes + parcours P0 (partiel) |
| R3 | Défaut de sécurité (traversée, clé exposée, CORS ouvert) | fuite de données ou crédits consommés | audits statiques et HTTP, tests d'import |
| R4 | Worker incompatible avec le protocole SQLite | rendu bloqué ou perdu | `renderer/protocol.test.ts` exécute les requêtes de référence |
| R5 | Fixtures non reproductibles ou tierces | tests instables, problème de droits | génération FFmpeg + manifeste SHA-256 |
| R6 | Analyse/rendu impossibles à tester hors ligne | régression non détectée | parcours complet `skip` documenté, demande QA-002 |
| R7 | Perte de synchronisation preview/export | rendu différent de l'aperçu | dépend du frontend et du worker (non livrés) |

## 3. Stratégie par couche

### 3.1 Contrat (`tests/contract/`)

- Valider le projet d'exemple, les fixtures projet et les payloads de rendu.
- Vérifier les statuts, transitions, champs obligatoires, révisions, précision des temps, chevauchements.
- Tester les cas négatifs : chaque mutation hors contrat doit produire un message précis.
- Vérifier les constantes et le DDL `render_jobs` (statuts, contraintes `CHECK`, index).

**Critère de sortie :** 100 % des objets de référence passent ; chaque règle du contrat a au moins un cas positif et un cas négatif.

### 3.2 Fixtures (`tests/fixtures/`)

- Médias 100 % synthétiques générés par FFmpeg `lavfi`.
- Manifeste taille + SHA-256 ; détection des fichiers orphelins ou modifiés.
- JSON de projet et de jobs alignés sur les médias réels (durées, dimensions, audio, rotation).
- Aucune URL réelle, aucun chemin absolu, aucune clé.

**Critère de sortie :** `npm run fixtures:force` puis `npm test` passe ; total < 10 Mio.

### 3.3 Backend en HTTP (`tests/integration/`)

| Domaine | Vérifications | État |
|---|---|---|
| Socle | health, config publique, schéma SQLite, WAL, stockage, logs sans secret | ✅ |
| Projets | création, relecture, statut, suggestions, projet inconnu | ✅ |
| Import | MP4 valide, métadonnées ffprobe, streaming Range, refus durée/audio/codec/signature/type/taille, formulaire vide, champ erroné | ✅ |
| Analyse | refus sans fournisseur (`PROVIDER_NOT_CONFIGURED`) | ⏳ route absente |
| Timeline | PATCH, conflit de révision, chevauchement | ⏳ route absente |
| Rendu | démarrage, statut, échec, téléchargement | ⏳ routes absentes |
| Suppression | DELETE projet et fichiers | ⏳ route absente |

Les tests d'import utilisent le **vrai** serveur, une base et un stockage temporaires, et des clés fournisseur forcées à vide.

### 3.4 Services backend (`tests/integration/backend-units.test.ts`)

Import direct des modules de Claude pour un retour avant branchement HTTP :

- création/écriture/révision de projet, conflit 409, identifiants invalides ;
- règle d'inclusion D-06 et tri de la timeline ;
- `RenderState` (idle, rendering, failed, completed) ;
- noms de fichiers, chemins confinés, nettoyage des envois abandonnés ;
- interprétation ffprobe (rotation, première piste vidéo, cadence).

### 3.5 Protocole worker (`tests/renderer/`)

Exécution des requêtes `RENDER_JOB_SQL` sur SQLite en mémoire :

- `claimNext` : FIFO, exclusivité, limite de concurrence, remise à zéro ;
- `heartbeat` : propriétaire uniquement, progression bornée ;
- `complete` / `fail` : transitions valides, bail libéré, message sans chemin ;
- `recoverStale` : reprise tant qu'il reste une tentative, puis `RENDER_WORKER_LOST`.

**Limite :** le worker réel (Codex) n'existe pas ; ces tests figent la sémantique, pas son implémentation.

### 3.6 Sécurité (`tests/security/`)

**Statique :** secrets (Groq, OpenRouter, AWS, clé privée), `.env` ignoré, `.env.example` vide, absence de dépendances npm, absence d'URL externe, CORS non ouvert, chemins absolus, `shell: true` interdit dans le worker.

**Dynamique :** en-têtes (`X-Powered-By`, `nosniff`, `X-Request-Id`), CORS et préflight, erreurs structurées sans stack, traversée de chemin, fichier `.env` non servi, nom de fichier malveillant, MIME incohérent, limite de débit 429, refus de démarrer en production sans clés.

**Critère de sortie :** aucun constat bloquant ou majeur ouvert ; les constats mineurs sont documentés.

## 4. Matrice PROJECT_MASTER §9

| Exigence §9 | Test(s) | État |
|---|---|---|
| Fixture MP4 ~30 s avec audio | `fixtures/media/source-30s.mp4` + `renderer/fixtures.test.ts` | ✅ |
| Projet JSON conforme | `fixtures/projects/project.fixture.json` + `contract/schema.test.ts` | ✅ |
| Plusieurs B-rolls de test | 3 B-rolls synthétiques (paysage, portrait, court) | ✅ |
| Tests sans Groq/OpenRouter/Pixabay | clés forcées vides + audit statique des URLs | ✅ |
| Provenance des médias documentée | `tests/fixtures/README.md` + manifeste | ✅ |
| Objets projet conformes au contrat | `contract/*`, `integration/backend-units.test.ts` | ✅ |
| Statuts et transitions | `contract/negative.test.ts`, `renderer/protocol.test.ts` | ✅ |
| Champs obligatoires | validateurs `lib/validation/` | ✅ |
| Sélection d'un candidat | `contract/*`, timeline D-06 | ✅ (règle D-06 non tranchée) |
| Révisions cohérentes | tests services + 409 | ✅ |
| Champs divergents backend/renderer | `render-job.ts` + protocole SQLite | ✅ |
| Upload valide / invalide | `integration/journey.test.ts` | ✅ |
| Fichier trop volumineux / trop long | `journey.test.ts` | ✅ |
| Vidéo sans audio | `journey.test.ts` | ✅ |
| Projet introuvable | `journey.test.ts`, `backend.test.ts` | ✅ |
| Analyse échouée | `journey.test.ts` | ⏳ route absente |
| Recherche média sans résultat | — | ⏳ fournisseur non injectable |
| Timeline modifiée / candidat remplacé | — | ⏳ route absente |
| Rendu réussi / échoué | `renderer/protocol.test.ts` (protocole) | ⏳ routes et worker absents |
| Téléchargement du résultat | — | ⏳ route absente |
| Audio original conservé | — | ⏳ worker absent |
| Traversée de chemin | `security/api.test.ts`, `backend-units.test.ts` | ✅ |
| Nom de fichier malveillant | `security/api.test.ts` | ✅ |
| Projet inexistant / non autorisé | `security/api.test.ts` | ✅ (D-04 non tranchée) |
| Extension trompeuse / MIME incohérent | `journey.test.ts`, `security/api.test.ts` | ✅ |
| Fichier corrompu | `journey.test.ts` | ✅ |
| URL média invalide | `security/static.test.ts` (fixtures) | ⚠️ partiel : URLs signées à venir (D-04) |
| Clés API non exposées | `security/static.test.ts` + `/api/health` | ✅ |
| Chemins serveur non exposés | `security/api.test.ts` | ✅ |
| Fichier hors projet non téléchargeable | `backend-units.test.ts` (chemins confinés) | ⚠️ route download absente |
| Chemin arbitraire choisi par le frontend | `security/api.test.ts` | ✅ |
| États de chargement / erreurs UX | — | ⏳ `frontend/` absent |
| Transitions analyse → rendu | parcours P0 | ⏳ bloqué |
| Synchronisation preview/export | — | ⏳ bloqué |

## 5. Environnements et outils

| Élément | Valeur |
|---|---|
| Runtime | Node.js 24 (TypeScript natif, sans compilation) |
| Runner | `node:test` (aucune dépendance npm) |
| Base | SQLite en mémoire ou fichier temporaire (`node:sqlite`) |
| Médias | FFmpeg / ffprobe 9.x (PATH ou variables dédiées) |
| Réseau | `127.0.0.1` uniquement |
| Variables fournisseur | forcées à `''` par le lanceur de tests |
| OS de référence | Windows 11 (PowerShell), compatible Linux/macOS |

## 6. Critères d'entrée et de sortie

**Entrée d'une campagne :**

- contrat et fixtures disponibles ;
- backend démarrable localement ;
- aucune clé réelle nécessaire.

**Sortie (gate QA) :**

- `npm test` : 0 échec ;
- aucun `skip` non justifié par une dépendance nommée ;
- aucun constat bloquant ou majeur ouvert ;
- rapport daté avec identifiants, gravité, reproduction, attendu/obtenu, recommandation ;
- tout bug backend connu est soit corrigé, soit inscrit en `todo` avec référence.

## 7. Cadence et rapport

- Exécution complète à chaque livraison significative du backend ou du worker.
- Audit de sécurité à chaque nouvelle route ou nouveau fichier servi.
- Rapport court après chaque campagne ; mise à jour de `docs/OPENCODE_QA_STATUS.md` pour la coordination.
- Les constats sont classés **bug réel**, **limite** ou **amélioration facultative** ; jamais mélangés.

## 8. État au 18/11/2026

- 189 tests : 186 passent, 3 skips justifiés, 0 échec.
- Backend : socle, projets, import et streaming livrés ; analyse, timeline, rendu, download et suppression attendus.
- Worker : absent ; protocole SQLite figé par les tests.
- Frontend : absent ; audit UX et E2E impossibles.
- Blocages principaux : D-04 (contrôle d'accès), D-06 (inclusion), D-08 (codecs), D-10 (exposition HTTPS), D-13 (dépôt Git), et absence d'injection de fournisseurs hors ligne pour le parcours complet.
