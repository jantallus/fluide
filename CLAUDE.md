# Parabooking API — Guide Claude Code

## Ce qu'est ce projet

API REST Node.js/Express déployée sur Railway sous **api.parabooking.app**.
Sert les deux backoffices (Fluide et Aravis) et les deux sites clients.
Base de données PostgreSQL partagée sur Railway.

---

## Structure des dossiers

```
routes/
├── auth.js          → POST /api/login, POST /api/logout
├── users.js         → CRUD utilisateurs + disponibilités moniteurs
├── slots.js         → créneaux de vol (planning)
├── bookings.js      → réservations
├── aravis.js        → endpoints publics Aravis (sans authentification)
└── …

middleware/
├── auth.js          → authenticateUser, authenticateAdmin, authenticateAdminOrPartner
└── …

schemas/
└── index.js         → validation Zod pour tous les endpoints

db.js                → pool PostgreSQL
```

---

## Authentification

JWT signé avec `JWT_SECRET`. Le token est posé en cookie HttpOnly par `/api/login`.

### Middlewares disponibles

| Middleware | Accès autorisé |
|---|---|
| `authenticateUser` | Tout utilisateur connecté |
| `authenticateAdmin` | `role = 'admin'` uniquement |
| `authenticateAdminOrPartner` | `admin`, `aravis` |

Le JWT contient : `{ id, email, role, enseigne }`.
Le champ **`enseigne`** (`'fluide'` ou `'aravis'`) indique à quel backoffice appartient l'utilisateur.

---

## Modèle utilisateur — champs importants

| Champ | Valeurs | Rôle |
|---|---|---|
| `role` | `admin`, `aravis`, `monitor`, `permanent` | Permissions |
| `enseigne` | `fluide`, `aravis` | Backoffice de destination à la connexion |
| `is_active_monitor` | boolean | Apparaît dans le planning |
| `status` | `Actif`, `Inactif` | Filtre dans les listes |

Un **admin Aravis** a `role = 'admin'` et `enseigne = 'aravis'`.
Un **moniteur Aravis** a `role = 'aravis'` (enseigne aravis implicite).

---

## Endpoints publics Aravis (sans auth)

Ces deux endpoints sont appelés directement par le site aravis-parapente.com :

```
GET  /api/public/aravis/slots?from=YYYY-MM-DD&to=YYYY-MM-DD
POST /api/public/aravis/request
```

**Ne pas ajouter d'authentification sur ces routes** — le site aravis-parapente.com ne dispose pas de système de connexion.

---

## Ce qu'il NE FAUT PAS modifier sans comprendre l'impact

### ⚠️ `middleware/auth.js` — `authenticateAdminOrPartner`
Doit inclure `'aravis'` dans la liste des rôles autorisés.
Si on modifie cette liste, le backoffice Aravis peut perdre l'accès à ses données.

### ⚠️ Route `/api/login` — `routes/auth.js`
Doit retourner `enseigne` dans la réponse ET dans le payload JWT.
Si `enseigne` disparaît du JWT, le frontend ne sait plus vers quel backoffice rediriger.

### ⚠️ `schemas/index.js` — validation des rôles
Les rôles valides : `admin`, `monitor`, `permanent`, `aravis`.
Ne pas supprimer `aravis` — des utilisateurs en production ont ce rôle.

### ⚠️ Requêtes SQL avec filtre sur `role`
Plusieurs requêtes filtrent par rôle (`WHERE role IN (...)`).
Si on ajoute un nouveau rôle, vérifier que ces requêtes l'incluent.
Exemples : `GET /api/monitors-admin`, `GET /api/monitors`.

---

## Variables d'environnement

```
DATABASE_URL=postgresql://...
JWT_SECRET=...        # même valeur que le frontend
NODE_ENV=production
```

---

## Déploiement

```bash
git push    # Railway redéploie automatiquement depuis main
```

Le frontend est dans le repo séparé `parabooking-admin`.
Voir son `CLAUDE.md` pour la structure des routes et des backoffices.
