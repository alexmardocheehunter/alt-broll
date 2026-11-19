# Décisions : ALT B-ROLL

Journal des décisions techniques (PROJECT_MASTER §0). Mise à jour : 18/11/2026, Claude Code.

Le 18/11, Alex a tranché l'accès (D-04) et délégué les autres choix avec une consigne : « ce qui est sûr de fonctionner et qui sera fluide ». Toutes les décisions ci-dessous sont arrêtées ; une nouvelle question ouvre une nouvelle entrée.

| ID | Sujet | Décision | Remarque |
|---|---|---|---|
| D-01 | Racine du projet | `C:\OASIS\GitHub\Alt.roll` = le `alt-hol/` du document | `PROJECT_MASTER.txt` extrait à l'identique de `LES INSTRUCTIONS.txt` |
| D-02 | Socle du backend | Node 24 (TypeScript natif), Express 5, zod 4, `node:sqlite`, `node:test` ; un seul `.env` à la racine | aucune compilation native sous Windows |
| D-03 | Source de vérité | SQLite : le projet est un document JSON ; l'état du rendu est lu dans `render_jobs` | aucun `project.json` sur disque |
| D-04 | Accès | **Connexion Google** (choix d'Alex), **reportée** : pas prioritaire | détail ci-dessous |
| D-05 | B-rolls de l'export | téléchargés et vérifiés par le backend ; le worker n'accède pas au réseau | appliqué par Codex (`renderer/INTEGRATION.md`) |
| D-06 | Inclusion des B-rolls | inclus par défaut jusqu'au refus : `enabled && status !== 'rejected' && selectedCandidateId !== null` | l'utilisateur peut exporter tout de suite ; preview = export |
| D-07 | Règles de rendu | celles du contrat (§6) : audio source seul, cover/contain, pas de chevauchement, temps alignés sur la frame, H.264/AAC | appliquées par Codex. Précision (19/11) : le worker refuse un segment plus long que sa vidéo réelle (à une image près) ; le backend borne donc chaque segment à la durée mesurée après téléchargement |
| D-08 | Vidéos acceptées | MP4 H.264 avec piste audio ; HEVC et .mov refusés avec un message qui explique quoi faire | P1 : conversion automatique des vidéos d'iPhone |
| D-09 | Écarts à la §6 | acceptés ; contrat v1 adopté | aucun type ni valeur modifié en l'adoptant |
| D-10 | Exposition du backend | **Tailscale Funnel** depuis le PC d'Alex | détail ci-dessous |
| D-11 | Un projet par utilisateur | reporté avec D-04 : sans connexion, pas d'utilisateur à compter | — |
| D-12 | Durée des vidéos | 5 s à 180 s, configurables | la fixture de 30 s d'OpenCode passe |
| D-13 | Git | dépôt créé par Alex le 18/11 (commit initial `9c4654e`) ; chaque agent ne commite que sur demande d'Alex | `.env` vérifié ignoré, aucun secret suivi |
| D-14 | Modèle d'analyse | **budget zéro** (Alex, 19/11) : `inclusionai/ling-3.2-flash:free`, secours `nvidia/nemotron-3.5-super-vl:free` (vision) puis `baidu/ernie-5.5-flash-preview:free` (texte seul) | détail ci-dessous |
| D-15 | Tests sans réseau (QA-002) | `PROVIDER_MODE=mock` : fournisseurs simulés, refusés en production. Contrat : valeur `simulation` ajoutée à `TRANSCRIPTION_PROVIDERS` et `BROLL_PROVIDERS` | changement compatible ; ✅ validateur d'OpenCode mis à jour le 19/11 (`transcript.provider` accepte `groq` et `simulation`) |
| D-16 | Langue de transcription | français imposé à Whisper (`TRANSCRIPTION_LANGUAGE=fr`, `auto` possible) | public francophone ; évite les erreurs de détection sur les débuts de vidéo |
| D-17 | Plafond d'analyses | 50 par 24 h glissantes, tous utilisateurs (`MAX_ANALYSES_PER_DAY`) | coût borné tant que la connexion Google n'existe pas |

## D-04 : connexion Google, reportée

- **Plus tard** : bouton « Continuer avec Google » via Firebase Authentication, cohérent avec Firebase Hosting. Le frontend envoie le jeton Firebase dans `Authorization: Bearer` ; le backend le vérifie, rattache chaque projet à son utilisateur et signe les liens vidéo et de téléchargement (un `<video src>` ne peut pas envoyer d'en-tête).
- **En attendant** : pas d'écran de connexion. Le coût reste borné même si l'URL du backend circule : identifiants de projet impossibles à deviner, limite de débit par adresse IP, plafond quotidien d'analyses (ajouté à l'étape 3), limite de crédit à fixer sur la clé OpenRouter.

## D-08 : pourquoi ni .mov ni HEVC pour l'instant

Le MP4 H.264 est lu par tous les navigateurs (preview) et par FFmpeg (export) : rien à convertir, donc rien qui puisse casser. Les vidéos d'iPhone (.mov, souvent en HEVC) demandent une conversion à l'import ; elle est prévue en P1, une fois le parcours P0 validé. En attendant, le message d'erreur indique d'exporter la vidéo en MP4 H.264. Un seul réglage à changer : `ACCEPTED_VIDEO_CODECS` dans `backend/src/services/upload.service.ts`.

## D-10 : Tailscale Funnel

- URL HTTPS stable et gratuite vers le PC d'Alex, sans nom de domaine. Funnel relaie la connexion chiffrée jusqu'au PC, donc sans le plafond de 100 Mo par requête de l'offre gratuite de Cloudflare, inférieur aux 150 Mo de la bêta. À confirmer vendredi par un import de 150 Mo.
- Réglages : `APP_BASE_URL=https://<machine>.<tailnet>.ts.net`, `FRONTEND_ORIGIN=https://<projet>.web.app`, `TRUST_PROXY=loopback`.
- Mise en place vendredi, au test d'intégration. Repli : Cloudflare Tunnel avec `MAX_UPLOAD_MB=95`.

## D-14 : modèles d'analyse gratuits (budget zéro)

- **Décision d'Alex (19/11)** : rester sur des modèles gratuits. Toute la chaîne coûte 0 $ : Groq (offre gratuite), modèles `:free` d'OpenRouter, Pixabay. La recommandation initiale (Claude Haiku 5.5, payant) est abandonnée.
- **Testé le 19/11 avec la vraie clé** : `ling` lit l'image et respecte le JSON imposé (analyse réelle complète en 31 s). `nemotron` aussi (11 s), à condition de lui laisser de quoi « réfléchir » : limite de réponse portée à 6 000 tokens. `ernie` ne lit pas les images et sert de secours texte seul. `google/gemma-4-31b-it:free` est écarté : il refuse le JSON imposé. La chaîne de 3 modèles est acceptée par OpenRouter et a déjà servi (`ling` indisponible, `nemotron` a répondu).
- Le 19/11, seuls 6 modèles gratuits acceptaient à la fois image et JSON imposé.
- **Parades codées** : 3 modèles essayés dans l'ordre par OpenRouter ; modèles disparus de la liste publique ignorés (vérification toutes les heures) ; image confiée aux seuls modèles qui l'acceptent ; repli sur le texte seul ; message « quota gratuit du jour atteint, réessayez demain » ; plafond de 50 analyses par 24 h.
- **Risques acceptés** : quotas journaliers des modèles gratuits, disparition sans préavis (`ernie` est une version « preview »), lenteur variable (11 à 25 s pour l'analyse). Les hébergeurs gratuits peuvent conserver les données reçues (transcription, planche contact) : à signaler aux testeurs.
- Changer de modèles : `OPENROUTER_MODEL` et `OPENROUTER_FALLBACK_MODEL` (liste séparée par des virgules) dans `.env`, sans toucher au code.
