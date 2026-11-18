# Décisions : ALT B-ROLL

Journal des décisions techniques (PROJECT_MASTER §0). Dernière mise à jour : 18/11/2026, Claude Code, étape 2.

Statuts : 🔴 à trancher par Alex · 🟡 proposé, à valider · ✅ décidé.

## À trancher par Alex

### D-04 🔴 Contrôle d'accès de la bêta
**Contexte.** Le backend sera joignable depuis Internet et consomme des API payantes (Groq, OpenRouter). Le document exige de contrôler l'accès aux projets et aux téléchargements, sans système d'authentification complexe.
**Proposition.** Un code d'accès par testeur, listé dans `.env`, saisi une fois dans l'interface et envoyé dans `Authorization: Bearer <code>`. Chaque projet appartient à un code. Les liens `project.urls` (vidéo source, téléchargement) sont signés et expirent (1 h) pour fonctionner dans `<video src>` et un lien de téléchargement.
**Variante** (`ALT_BROLL_PROJET.txt` §18) : un jeton propre à chaque projet, renvoyé à la création et envoyé à chaque appel ; il peut compléter le code testeur, mais ne protège pas seul les crédits API (n'importe qui peut créer un projet).
**Impact.** Frontend : écran de saisie du code, en-tête sur chaque appel. Backend : un middleware et une signature HMAC. Sans contrôle, n'importe qui peut consommer les crédits API.

### D-06 🔴 Règle d'inclusion des B-rolls (preview et export)
**Proposition.** Inclus par défaut jusqu'au refus : `enabled && status !== 'rejected' && selectedCandidateId !== null`. « Accepter » marque la suggestion comme validée, « Refuser » l'exclut, `enabled = false` la met de côté sans perdre ses réglages.
**Alternative.** Seuls les B-rolls acceptés sont montés : plus explicite, mais l'utilisateur doit tout valider avant d'exporter.
**Impact.** Seulement le calcul de `timeline` dans le backend : le frontend et le worker suivent automatiquement.

### D-08 🔴 Vidéos acceptées à l'import
**Proposition.** Refuser une vidéo sans piste audio (`VIDEO_NO_AUDIO`) : sans parole, pas de suggestion possible. Accepter le H.264.
**Question.** Accepter le HEVC (vidéos d'iPhone) ? FFmpeg sait l'exporter, mais tous les navigateurs ne le lisent pas en preview. Option prudente : le refuser en bêta avec un message clair (`VIDEO_UNSUPPORTED_CODEC`).
**Appliqué en attendant (étape 2).** H.264 seul et vidéos sans audio refusées. Changer d'avis tient en une ligne : `ACCEPTED_VIDEO_CODECS` dans `backend/src/services/upload.service.ts`.

### D-10 🔴 Exposition du backend pour la bêta (urgent pour samedi)
Le frontend sera servi en HTTPS (Firebase Hosting) ; un navigateur bloque les appels d'une page HTTPS vers une API HTTP. Il faut une URL HTTPS vers le backend de la machine d'Alex : tunnel (Cloudflare Tunnel, gratuit, ou ngrok) vers `127.0.0.1:3000`, ou petit serveur VPS avec proxy HTTPS.
**Impact.** `APP_BASE_URL`, `FRONTEND_ORIGIN`, et le test du parcours complet de vendredi. Le limiteur de débit (`RATE_LIMIT_WRITES_PER_HOUR`) compte par adresse IP : derrière un tunnel, régler `TRUST_PROXY=loopback` (déjà disponible, `false` par défaut), sinon tous les testeurs partagent la même limite (QA-OBS-005).

### D-13 🔴 Dépôt Git
Le dossier n'est pas encore un dépôt Git. Recommandation : `git init` avant que les trois agents écrivent, pour voir ce que chacun modifie. Non fait sans accord.

## Proposé, à valider

### D-09 🟡 Écarts du contrat par rapport à la structure conceptuelle (§6)
1. `Project.errors` remplacé par `analysis.error` et `render.error` : une erreur vit à un seul endroit.
2. `Analysis.suggestions[]` fusionné dans `Project.brollItems` : les suggestions sont les éléments éditables, sans seconde copie.
3. `Project.timeline` : segments calculés par le backend (lecture seule), pour que preview et export utilisent la même liste.
4. Ajouts : `analysis.stage` (progression), `ErrorInfo.retryable`, `source.videoCodec` et `audioCodec`, `Project.urls`, `render.revision`, statut de rendu `preparing`.
5. `render.outputFile` ne contient aucun chemin : `{ sizeBytes, durationSeconds }`.

### D-03 🟡 SQLite, source de vérité unique
Le projet est un document JSON dans `projects.document` (identité et révision en colonnes). L'état du rendu vient de `render_jobs`, seule table que le worker modifie. Aucun `project.json` sur disque, donc pas de seconde source de vérité.

### D-05 🟡 Téléchargement des B-rolls par le backend
À `POST /render`, le backend crée le job en `preparing`, télécharge les B-rolls retenus (HTTPS, hôtes Pixabay uniquement, taille et durée limitées), les vérifie avec ffprobe, puis passe le job en `queued`. Le worker n'accède jamais au réseau. À confirmer avec Codex.

### D-07 🟡 Règles de rendu
Aucun chevauchement (refus `TIMELINE_OVERLAP` au PATCH) ; B-roll lu depuis son début ; segment limité à la durée du B-roll choisi (règle reprise de `ALT_BROLL_PROJET.txt` §9), la dernière image n'étant figée que pour l'écart d'arrondi de la durée Pixabay ; cadrage `cover` ou `contain` ; audio de la source uniquement ; temps alignés sur la frame ; sortie H.264/AAC, petit côté ≤ 1080 (ou 720). Détail dans `shared/contract.ts`. À confirmer par Codex (faisabilité FFmpeg) et Alex (comportement de la preview).

### D-11 🟡 Un projet actif par testeur
Limite configurable, et nouvelle route `DELETE /api/projects/:id` qui supprime le projet et ses fichiers. Dépend de D-04.

### D-12 🟡 Durée minimale de 5 s
Le document vise des vidéos de 1 à 3 min, mais la fixture de test fait environ 30 s : minimum 5 s, maximum 180 s, tous deux configurables (`MIN_VIDEO_DURATION_SECONDS`, `MAX_VIDEO_DURATION_SECONDS`).

## Décidé (périmètre Claude Code)

### D-01 ✅ Racine du projet
Le dossier `alt-hol/` du document correspond à `C:\OASIS\GitHub\Alt.roll`, le dossier partagé par Alex. `PROJECT_MASTER.txt` y a été extrait à l'identique de `LES INSTRUCTIONS.txt` (conservé tel quel). À corriger si un sous-dossier `alt-hol/` était voulu.

### D-02 ✅ Socle technique du backend
- Node.js 24 exécute directement le TypeScript : pas d'étape de compilation ni de dossier `dist/`. `npm run build` vérifie les types.
- Express 5, choisi plutôt que Fastify : plus répandu, suffisant pour la bêta.
- zod 4 pour valider l'environnement et, ensuite, les requêtes et les réponses des fournisseurs.
- `node:sqlite`, intégré à Node : aucune compilation native sous Windows ; utilisable tel quel par le worker.
- Tests avec `node:test`, sans dépendance ni appel externe.
- Un seul `.env` à la racine pour le backend et le worker ; chemins relatifs résolus depuis la racine.
