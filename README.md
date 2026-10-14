# Caisse 💰

Application web (installable sur téléphone) pour suivre son portefeuille, ses dépenses et ses revenus du mois.

## Fonctionnalités

- **Accueil** : patrimoine total, revenus / dépenses / solde du mois, taux d'épargne, comparaison avec le mois précédent, dépenses par catégorie, budgets, dernières opérations.
- **Opérations** : liste par jour, recherche, filtre (dépenses, revenus, virements), modification et suppression.
- **Comptes** : plusieurs comptes (espèces, banque, épargne, mobile money…) avec solde initial et virements entre comptes.
- **Stats** : graphique revenus vs dépenses sur 3, 6 ou 12 mois, moyennes mensuelles, top des dépenses.
- **Réglages** : devise (franc CFA par défaut), thème clair/sombre, catégories et budgets mensuels, sauvegarde/restauration JSON, export CSV (Excel).

- **Compte en ligne** : identifiant + mot de passe. Les données sont enregistrées sur votre site Netlify (Netlify Blobs) et synchronisées entre tous vos appareils, même après une utilisation hors connexion.
- **Code PIN** : verrouille l'app sur le téléphone (à l'ouverture et après 1 minute en arrière-plan).

La connexion est obligatoire : sans compte, l'app reste sur l'écran de connexion.

## Lancer l'app

```bash
npm install
npm run dev
# puis ouvrir http://localhost:8888
```

Le serveur de développement sert l'app et l'API ; les comptes sont stockés dans `.data/`.

## Déployer sur Netlify

1. Sur [app.netlify.com](https://app.netlify.com) : **Add new site → Import an existing project → GitHub**, choisir le dépôt `Caisse` et la branche.
2. Laisser les réglages par défaut : `netlify.toml` indique déjà le dossier à publier (`public/`) et celui de l'API (`netlify/functions/`). Netlify Blobs est activé automatiquement, rien à configurer.
3. Cliquer sur **Deploy**.

Ensuite, sur le téléphone, ouvrir l'URL Netlify puis :
- **Android (Chrome)** : menu ⋮ → « Installer l'application » ;
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ».

L'app apparaît alors avec son icône et fonctionne hors-ligne.

## Fichiers

| Fichier | Rôle |
|---|---|
| `public/index.html` | Structure de la page |
| `public/style.css` | Styles (mobile d'abord, mode sombre) |
| `public/app.js` | Logique : données, calculs, vues, formulaires |
| `public/auth.js` | Compte, synchronisation entre appareils, code PIN |
| `public/sw.js` | Service worker (hors-ligne) |
| `public/manifest.webmanifest`, `public/icons/` | Installation comme application |
| `netlify/functions/api.mjs` | API `/api/*` sur Netlify (comptes et données) |
| `netlify/functions/lib/api.mjs` | Logique de l'API (mots de passe chiffrés avec scrypt, jetons signés) |
| `scripts/dev-server.mjs` | Serveur local pour le développement |
| `netlify.toml` | Configuration Netlify |

## Sécurité

- Les mots de passe ne sont jamais stockés en clair (scrypt + sel).
- Après 5 mauvais mots de passe, le compte est bloqué 5 minutes.
- Changer de mot de passe déconnecte les autres appareils.
- Optionnel : définir la variable d'environnement `CAISSE_SECRET` sur Netlify pour choisir la clé de signature des sessions (sinon elle est générée automatiquement).
- Le code PIN protège l'accès à l'app sur le téléphone ; il ne chiffre pas les données stockées dans le navigateur.
