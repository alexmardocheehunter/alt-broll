# Rapport QA : ALT B-ROLL

> 18/11/2026 · OpenCode · campagne de mise en place et premier audit
> Suite : 189 tests, 186 réussis, 3 ignorés justifiés, **0 échec**.

## 1. Résumé

- Fixtures média 100 % synthétiques générées par FFmpeg, avec manifeste SHA-256 et JSON de projet/job conformes.
- 73 tests de contrat, 31 tests renderer/fixtures, 35 tests de sécurité, 50 tests d'intégration.
- Le backend réel est testé en HTTP (base et stockage temporaires, clés fournisseur vides) : health, config, projets, import, refus d'import, streaming Range.
- Un bug backend réel détecté, corrigé par Claude pendant la campagne et verrouillé par un test de non-régression.
- Le parcours P0 complet reste bloqué par l'absence des routes analyse/timeline/rendu/download et d'un mode fournisseur hors ligne.

## 2. Constats priorisés

### BUG-QA-001 : la progression d'un export terminé n'est pas forcée à 1

- **Gravité :** mineure (affichage, pas de perte de données).
- **État :** ✅ corrigé par Claude le 18/11 à 16 h 07, vérifié par QA ; test de non-régression actif.
- **Composant :** `backend/src/services/render-state.ts` (`displayedProgress`).
- **Reproduction :**
  1. Créer un job `render_jobs` avec `status = 'completed'` et `progress = 0.8`.
  2. Appeler `toRenderState(row)` ou `GET /api/projects/:id/render/status` après un export.
- **Attendu :** `progress = 1`, conformément à `validateRender` / `shared/contract.ts` (contrat : un rendu terminé est à 100 %).
- **Obtenu avant correction :** `progress = 0.8` (la valeur stockée par le dernier heartbeat).
- **Test :** `tests/integration/backend-units.test.ts`, test « un job completed expose le fichier validé et une progression à 1 ».
- **Correction appliquée :** `completed ? 1 : …`, et `preparing`/`queued` affichent 0.

### QA-OBS-002 : progression conservée lors d'une remise en file

- **Gravité :** mineure (affichage transitoire).
- **État :** ✅ corrigé côté API (`preparing` et `queued` renvoient 0), vérifié par un test dédié.
- **Composant :** `backend/src/services/render-state.ts`, en complément de `shared/contract.ts:766` (`recoverStale`).
- **Reproduction :** job `rendering` avec `progress = 0.4`, bail expiré, `attempts < max_attempts` ; exécuter `recoverStale` puis lire l'état avant un nouveau `claimNext`.
- **Attendu :** un job `queued` affiche une progression à 0.
- **Obtenu avant correction :** `queued` avec `progress = 0.4`.

### QA-OBS-003 : code d'erreur non contraint à `RENDER_*` dans `fail`

- **Gravité :** mineure (robustesse).
- **État :** ✅ corrigé côté API : un code hors `RENDER_*` est normalisé en `INTERNAL_ERROR` ; à borner aussi côté worker.
- **Composant :** `shared/contract.ts:751`, `backend/src/services/render-state.ts`.
- **Reproduction :** exécuter `RENDER_JOB_SQL.fail` avec `errorCode = 'NOT_FOUND'` sur un job `rendering`.
- **Attendu :** l'API ne relaie jamais un code incohérent.
- **Obtenu avant correction :** la valeur était écrite telle quelle ; l'API la normalise désormais.

### QA-OBS-004 : `heartbeat` ne borne pas la progression

- **Gravité :** mineure (le worker doit respecter le contrat).
- **Composant :** `shared/contract.ts:725`.
- **Reproduction :** appeler `heartbeat` avec `progress = 1.2`.
- **Attendu :** valeur refusée ou ramenée à 1.
- **Obtenu :** erreur SQLite `CHECK constraint failed` (protection en dernier recours, mais écriture perdue).
- **Recommandation :** documenter dans le README du worker que la valeur doit être bornée avant l'UPDATE, et ajouter un test côté Codex.

### QA-OBS-005 : limitation de débit inopérante derrière un tunnel

- **Gravité :** majeure pour la bêta (risque d'épuisement des crédits ou de blocage global).
- **État :** 🟡 mitigé. `TRUST_PROXY` est désormais configurable (`false`, `loopback`, 1‑9), refusé à `true`, et testé : sans lui, `X-Forwarded-For` est ignoré ; avec `loopback`, la limite s'applique par adresse cliente. La valeur finale dépend de D-10.
- **Composant :** `backend/src/utils/rate-limit.ts`, `backend/src/app.ts:44`, `backend/src/config/env.ts`.
- **Reproduction :** déployer derrière Cloudflare Tunnel/ngrok (D-10) sans `TRUST_PROXY`.
- **Attendu :** 60 écritures/h **par testeur**.
- **Obtenu avant correction :** toutes les requêtes portent l'IP du tunnel : un seul compteur pour tous les utilisateurs.
- **Recommandation :** trancher D-10 puis définir `TRUST_PROXY=loopback` (tunnel local) et documenter la variable dans `.env.example`.

### QA-OBS-006 : vidéo source accessible sans contrôle d'accès

- **Gravité :** majeure si la bêta est publique (D-04 non tranchée).
- **Composant :** `backend/src/routes/media.routes.ts:19`, toutes les routes `/api/projects…`.
- **Reproduction :** `GET /api/projects/<id>/media/source` sans en-tête d'autorisation.
- **Attendu :** selon D-04, un code testeur ou un lien signé temporaire.
- **Obtenu :** accessible à quiconque connaît l'identifiant (non devinable mais non authentifié).
- **Recommandation :** Alex doit trancher D-04 avant l'ouverture. En attendant, ne pas publier l'URL du backend.

## 3. Blocages (dépendances, pas des bugs)

| ID | Blocage | Responsable | Impact QA |
|---|---|---|---|
| QA-DEP-001 | Routes `analyze`, `timeline`, `render`, `render/status`, `download`, `DELETE` non livrées (404) | Claude | analyse, édition, export et téléchargement non testables |
| QA-DEP-002 | Aucun mode fournisseur hors ligne injectable | Claude | le parcours P0 complet resterait `skip` même avec les routes |
| QA-DEP-003 | `renderer/` absent | Codex | pas de test du rendu FFmpeg, de l'audio ni du MP4 final |
| QA-DEP-004 | `frontend/` absent | Alex | pas d'audit UX, de preview ni d'E2E navigateur |
| QA-DEP-005 | D-04, D-06, D-08, D-10, D-13 non tranchées | Alex | sécurité, inclusion, codecs, exposition, historique |

## 4. Limites des tests actuels

- Le protocole worker est testé sur SQLite en mémoire, pas avec le worker réel.
- Le rendu FFmpeg n'est pas exécuté : aucune assertion sur l'audio conservé ni sur le MP4 final.
- Les tests d'import utilisent de vrais fichiers mais pas de vrai navigateur : le comportement `<video>` (autoplay, seek, codecs) reste à vérifier côté frontend.
- La limite de débit est testée sur une seule instance et une seule IP.
- Les fixtures doivent être régénérées si la version de FFmpeg change (manifeste SHA-256).

## 5. Améliorations facultatives

- Ajouter un test de reprise après coupure réseau pendant l'upload (nécessite un proxy de test).
- Mesurer le temps de réponse de `/api/health` et `/api/config` (aujourd'hui non prioritaire).
- Vérifier les en-têtes de sécurité supplémentaires (`Referrer-Policy`, `Content-Security-Policy`) quand le frontend sera servi par le backend ou Firebase.
- Ajouter un test de charge léger (10 imports simultanés) avant la bêta, si le temps le permet.

## 6. Demandes

**À Claude :**

1. Livrer `analyze`, `timeline`, `render`, `render/status`, `download`, `DELETE` en suivant `docs/API.md`.
2. Fournir un moyen explicite de tester l'analyse sans réseau (injection de fournisseur ou serveur factice identifié), sinon le parcours restera `skip`.
3. Confirmer le bornage de `heartbeat` (QA-OBS-004) et documenter `TRUST_PROXY` dans `.env.example` quand D-10 sera tranchée.

**À Alex :**

1. Trancher D-04 (accès), D-06 (inclusion), D-08 (codecs), D-10 (tunnel/`trust proxy`), D-13 (Git).
2. Livrer `frontend/` pour l'audit UX et la synchronisation preview/export.

**À Codex :**

1. Consommer `RENDER_JOB_SQL` sans le réécrire ; borner `progress` avant `heartbeat` ; n'écrire que des codes `RENDER_*`.
2. Prévoir un mode `--once` ou un job de test pour que QA puisse exécuter le worker sur les fixtures sans réseau.

## 7. Conclusion

Le socle est solide et testé : contrat, fixtures, backend livré, sécurité de base. Le produit n'est pas encore testable de bout en bout : il manque les routes d'analyse/rendu, le worker, le frontend et l'arbitrage D-04. Le bug backend confirmé a été corrigé et verrouillé par un test ; les deux risques majeurs restants sont opérationnels (limite de débit derrière un tunnel, absence de contrôle d'accès), pas des défauts de code.
