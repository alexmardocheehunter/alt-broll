# Intégration du renderer

Notes de synchronisation pour Claude Code (backend), OpenCode (QA) et Alex.

## Backend

- Utiliser `RENDER_JOBS_TABLE_SQL` et `RenderJobPayload` de `shared/contract.ts` comme contrat unique.
- Insérer les jobs avec `status = 'preparing'`, puis ne passer à `queued` qu'après téléchargement et vérification ffprobe de chaque B-roll.
- Le payload doit contenir des chemins de la forme `source/<nom>.mp4`, `broll/<nom>.mp4` et `output/<nom>.mp4`, relatifs à `STORAGE_ROOT/projects/<projectId>/`.
- Le renderer n'a pas d'accès réseau. Les B-rolls doivent donc être présents avant la mise en file.
- Le renderer réclame les jobs `queued` via `RENDER_JOB_SQL.claimNext` sous `BEGIN IMMEDIATE`, renouvelle le bail, valide ffprobe, puis écrit les colonnes de fin avec `complete` ou `fail`.

## QA

- La commande de vérification de types est `npm --prefix renderer run typecheck` après installation des dépendances du renderer.
- Les tests de rendu devront couvrir une insertion au début, au milieu et à la fin, les cadrages `cover` et `contain`, un média légèrement plus court que sa durée annoncée, la conservation de l'audio source, la perte de bail et les chemins invalides.
- Aucun fixture externe ni appel réseau n'est nécessaire : fournir des MP4 locaux synthétiques.

## Décision D-07

L'implémentation suit la proposition D-07 du contrat : flux vidéo source découpé autour des B-rolls, audio source seul, sortie H.264/AAC. Les temps sont alignés à la frame de sortie la plus proche. La proposition D-07 demeure à valider par Alex dans `docs/DECISIONS.md`.
