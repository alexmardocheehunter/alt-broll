# Worker de rendu ALT B-ROLL

Prérequis : Node.js 24+, FFmpeg et ffprobe accessibles dans le PATH. Le worker et le backend lisent le même `.env` à la racine et utilisent la même base SQLite et le même `STORAGE_ROOT`.

Installer les outils de vérification depuis la racine avec `npm --prefix renderer install`.

Depuis la racine : `node renderer/src/worker.ts` (ou `npm --prefix renderer start`). Pour prendre au plus un job disponible et quitter, utilisez `node renderer/src/worker.ts --once`. Variables lues : `DATABASE_PATH`, `STORAGE_ROOT`, `FFMPEG_PATH`, `FFPROBE_PATH`, `MAX_CONCURRENT_RENDERS`.

Le worker ne contacte aucun service réseau et ne lit que les jobs `queued`. Il récupère les fichiers B-roll déjà téléchargés par le backend, valide les chemins sous le dossier du projet, encode vers un fichier temporaire, inspecte le résultat avec ffprobe puis le renomme atomiquement. Les erreurs FFmpeg détaillées restent dans les logs ; seules des erreurs structurées et sans chemins sont écrites dans SQLite.

Le filtre `concat` assemble les portions de la source découpées autour des B-rolls, sans toucher à l'audio original. Les segments sont alignés sur la frame la plus proche et les médias courts sont figés sur leur dernière image jusqu'à la fin du segment.

Vérifications locales effectuées : typecheck TypeScript, puis jobs SQLite isolés rendus depuis les fixtures locales en paysage (640 × 360, 30 s, deux B-rolls) et portrait (360 × 640, 10 s, un B-roll). Les deux jobs sont passés à `completed` après validation ffprobe ; les bases et fichiers temporaires de vérification ont été supprimés.
