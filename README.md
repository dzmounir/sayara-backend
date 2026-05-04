# SAYARA Backend

Bot WhatsApp d'importation de véhicules — Serveur webhook Node.js + blueprints Make.com.

## Architecture

```
WhatsApp ←→ server.js (webhook) ←→ Make.com (logique) ←→ Airtable / Carbone / Drive
```

- **server.js** reçoit les messages WhatsApp et les forward vers Make.com
- **Make.com** exécute la logique métier et appelle `/make-trigger` pour renvoyer des messages
- **lib/pricing.js** calcule les devis (utilisable aussi depuis Make.com via HTTP)

---

## Déploiement Railway (5 étapes)

### 1. Préparer le dépôt

```bash
git init && git add . && git commit -m "init sayara-backend"
```

### 2. Créer le projet Railway

```bash
# Installer Railway CLI
npm install -g @railway/cli

# Se connecter et déployer
railway login
railway init          # choisir "Empty Project"
railway up            # déploie le repo courant
```

### 3. Configurer les variables d'environnement

Dans Railway > votre projet > Variables, ajouter **toutes** les clés de `.env.example` :

```bash
# Ou via CLI (exemple)
railway variables set WHATSAPP_VERIFY_TOKEN=votre_token
railway variables set WHATSAPP_ACCESS_TOKEN=votre_token
# ... répéter pour chaque variable
```

### 4. Récupérer l'URL Railway

```bash
railway domain   # génère *.up.railway.app
```

Mettre cette URL dans :
- Variable `SERVER_HOST` sur Railway
- **Meta Business Suite** > WhatsApp > Configuration > URL de rappel du webhook

### 5. Vérifier le déploiement

```bash
# Tester le webhook Meta
curl https://votre-app.up.railway.app/webhook?hub.mode=subscribe&hub.verify_token=sayara_webhook_secret_2024&hub.challenge=test
# Doit retourner : test
```

---

## Configuration Make.com (3 étapes)

### 1. Créer les webhooks

Pour chaque blueprint dans `blueprints/`, créer un webhook Make.com :
- Make.com > Webhooks > Add webhook
- Copier l'URL dans les variables Railway correspondantes

| Blueprint | Variable Railway |
|-----------|-----------------|
| 01_accueil | `MAKE_WEBHOOK_URL` |
| 02_qualification | auto-routé depuis 01 |
| 09_documents_sourceur | `MAKE_WEBHOOK_URL_SOURCEURS` |

### 2. Importer les blueprints

1. Make.com > Scenarios > Create new scenario
2. Menu "..." > Import Blueprint
3. Sélectionner le fichier `.json` correspondant
4. Remplacer les `{{PLACEHOLDERS}}` par vos vraies valeurs (Base IDs, folder IDs...)

### 3. Activer les scénarios

Activer dans cet ordre :
1. `01_accueil` — webhook principal (tous les messages arrivent ici d'abord)
2. `02_qualification` → `03_devis` → `04_contrat`
3. `05_score_intention` (parallèle avec 04)
4. `09_documents_sourceur` (webhook séparé pour les sourceurs)
5. `10_penalites_retard` + `08_rapport_hebdo` (schedulers)
6. `14_sync_prix_sourceurs` (scheduler toutes les 6h)

---

## Tables Airtable requises

| Table | Usage |
|-------|-------|
| `DOSSIERS` | Un enregistrement par client/commande |
| `DEMANDES_MARCHE` | Toutes les demandes (statistiques) |
| `SOURCEURS` | Sourceurs actifs avec leurs contacts |
| `NOTAIRES_PAR_COMMUNE` | Notaires par zone géographique |
| `CATALOGUE` | Véhicules disponibles avec prix |
| `VARIABLES_GLOBALES` | Taux de conversion, commissions... |
| `PRIX_SOURCEURS` | Catalogue prix par sourceur (sync auto) |
| `AVIS` | Avis clients post-livraison |
| `CONTENU` | Messages multilingues (AR/FR/EN) |

---

## Développement local

```bash
npm install

# Créer .env depuis l'exemple
cp .env.example .env
# Remplir les valeurs dans .env

# Lancer le serveur
npm run dev

# Exposer en local pour tester Meta webhook (requiert ngrok)
ngrok http 3001
# Utiliser l'URL ngrok comme SERVER_HOST
```
