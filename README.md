# Caisse 💰

Application web (installable sur téléphone) pour suivre son portefeuille, ses dépenses et ses revenus du mois.

## Fonctionnalités

- **Accueil** : patrimoine total, revenus / dépenses / solde du mois, taux d'épargne, comparaison avec le mois précédent, dépenses par catégorie, budgets, dernières opérations.
- **Opérations** : liste par jour, recherche, filtre (dépenses, revenus, virements), modification et suppression.
- **Comptes** : plusieurs comptes (espèces, banque, épargne, mobile money…) avec solde initial et virements entre comptes.
- **Stats** : graphique revenus vs dépenses sur 3, 6 ou 12 mois, moyennes mensuelles, top des dépenses.
- **Réglages** : devise, thème clair/sombre, catégories et budgets mensuels, sauvegarde/restauration JSON, export CSV (Excel).

Les données restent **uniquement sur votre appareil** (stockage local du navigateur). Pensez à faire une sauvegarde JSON de temps en temps.

## Lancer l'app

Aucune dépendance. Servez le dossier avec n'importe quel serveur statique :

```bash
npx http-server .
# puis ouvrir http://localhost:8080
```

Pour l'utiliser sur téléphone, hébergez le dossier (GitHub Pages, Netlify…), ouvrez l'URL puis « Ajouter à l'écran d'accueil ». L'app fonctionne ensuite hors-ligne.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `style.css` | Styles (mobile d'abord, mode sombre) |
| `app.js` | Logique : données, calculs, vues, formulaires |
| `sw.js` | Service worker (hors-ligne) |
| `manifest.webmanifest`, `icon.svg` | Installation comme application |
