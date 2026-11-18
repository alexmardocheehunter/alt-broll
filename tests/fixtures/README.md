# Fixtures ALT B-ROLL : provenance et mode d'emploi

Tout le contenu de ce dossier est **synthétique**, généré localement par FFmpeg (`lavfi`). Aucune vidéo Pixabay, aucun extrait de film, aucune donnée personnelle, aucune image tierce. Il n'y a donc **aucun droit à gérer** et rien à télécharger.

Le générateur est [`build-fixtures.mjs`](build-fixtures.mjs). Il écrit aussi [`media/manifest.json`](media/manifest.json), qui contient la taille et le SHA-256 de chaque fichier : les tests détectent toute fixture modifiée ou remplacée à la main.

## Régénérer

Depuis `tests/` :

```powershell
npm run fixtures          # crée uniquement les fichiers manquants
npm run fixtures:force    # régénère tout et réécrit le manifeste
```

Prérequis : FFmpeg dans le `PATH` (ou `FFMPEG_PATH`) avec `libx264`, le filtre `drawtext` et l'encodeur `aac`. Le script échoue clairement si un outil manque.

> Une régénération avec une autre version de FFmpeg peut produire des octets différents (donc d'autres SHA-256). C'est normal : relancer `npm run fixtures:force` réécrit le manifeste, puis `npm test` vérifie le nouvel état.

## Médias (`media/`)

| Fichier | Format | Rôle |
|---|---|---|
| `source-30s.mp4` | 30 s · 640 × 360 · 30 i/s · H.264 + AAC mono | **Source de référence** du parcours P0 ; images numérotées « SOURCE n » pour vérifier un rendu à l'œil |
| `source-rotated-10s.mp4` | 10 s · 640 × 360 codé, rotation 90° → 360 × 640 affiché · H.264 + AAC | Vérifie que le backend applique la rotation (dimensions d'affichage) |
| `broll-city-8s.mp4` | 8 s · 640 × 360 · muet | B-roll paysage de test |
| `broll-portrait-6s.mp4` | 6 s · 360 × 640 · muet | B-roll vertical, cas `contain` |
| `broll-short-4s.mp4` | 4 s · 640 × 360 · muet | B-roll court, borne la durée d'un segment |
| `no-audio-10s.mp4` | 10 s · 640 × 360 · **sans audio** | Doit être refusé à l'import (`VIDEO_NO_AUDIO`) |
| `audio-only-10s.mp4` | 10 s · AAC seul | Doit être refusé (`VIDEO_NO_VIDEO_STREAM`) |
| `too-short-3s.mp4` | 3 s · 320 × 180 · AAC | Sous la durée minimale de 5 s (`VIDEO_TOO_SHORT`) |
| `too-long-181s.mp4` | 181 s · 160 × 120 · 5 i/s · AAC | Au-delà de la limite de 180 s (`VIDEO_TOO_LONG`), volontairement léger |
| `truncated.mp4` | 4 Kio extraits de `source-30s.mp4` | MP4 tronqué, illisible (`VIDEO_UNREADABLE`) |
| `not-a-video.mp4` | texte brut renommé `.mp4` | Signature MP4 absente (`UPLOAD_UNSUPPORTED_TYPE`) |

Les B-rolls portent le texte « MOCK - NOT PIXABAY » : impossible de les confondre avec un média réel. Les URLs des fixtures JSON pointent vers `example.com` et les fichiers correspondants sont servis par les tests, jamais par le réseau.

## Projets et jobs (`projects/`, `jobs/`)

| Fichier | Contenu |
|---|---|
| `projects/project.fixture.json` | Projet complet et conforme : source `source-30s.mp4`, transcription fictive, analyse `completed`, quatre suggestions (acceptée, proposée, refusée, désactivée) et une timeline de deux segments |
| `jobs/render-job.payload.landscape.json` | `RenderJobPayload` 640 × 360 avec deux segments (`cover`, `contain`) |
| `jobs/render-job.payload.portrait.json` | `RenderJobPayload` 360 × 640 avec un segment issu de `source-rotated-10s.mp4` |

Règles suivies par ces JSON :

- identifiants réservés aux fixtures : `fixture_`, `proj_fix_`, `br_fix_`, `cand_fix_`, `job_fix_` ;
- aucune clé, aucun jeton, aucun chemin absolu ;
- aucune URL réelle : `example.com` ou `localhost` uniquement ;
- durées et dimensions identiques à celles des médias réellement présents ;
- transcription et analyse **fictives**, avec la mention explicite qu'aucune API n'a été appelée.

## Ajouter une fixture

1. Ajouter la génération dans `build-fixtures.mjs` (fonction `encode` ou écriture explicite), avec un libellé lisible.
2. Lancer `npm run fixtures:force` : le manifeste est réécrit.
3. Ajouter le fichier au tableau du présent README et, si nécessaire, aux tests `renderer/fixtures.test.ts`.
4. Vérifier `npm test` : l'intégrité SHA-256 et les caractéristiques réelles doivent passer.
5. Ne jamais committer un média téléchargé, même « libre de droits » : la règle du projet est 100 % synthétique.

## Ce qu'il ne faut pas faire

- Modifier un MP4 à la main : le manifeste ne correspondra plus et les tests échoueront (c'est voulu).
- Ajouter un fichier sans l'inscrire au manifeste : `fixtures.test.ts` signale un « fichier orphelin ».
- Dépasser 10 Mio au total : le test d'intégrité échoue pour garder le dossier léger.
- Utiliser une police exotique pour `drawtext` : le script choisit une police système disponible ; si aucune ne l'est, il le signale.
