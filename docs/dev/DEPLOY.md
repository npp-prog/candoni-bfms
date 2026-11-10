# Deploying the BFMS backend

The web app (Netlify) rebuilds by itself when `main` changes. The **backend** — Cloud Functions,
Firestore rules and indexes — must be deployed to the Firebase project too. Everything below works
from a tablet or phone browser.

Find your **project ID** first: Firebase console → ⚙ Project settings → General → *Project ID*.

## A. One-time deploy from the browser (Google Cloud Shell)

1. Open <https://console.cloud.google.com>, pick the BFMS project, and tap the **Cloud Shell** icon
   (`>_`, top right). A terminal opens in the browser.
2. Paste, one line at a time (replace `YOUR_PROJECT_ID`):

   ```sh
   git clone https://github.com/npp-prog/candoni-bfms.git && cd candoni-bfms
   npm ci
   npx firebase-tools login --no-localhost
   npx firebase-tools deploy --only firestore,functions --project YOUR_PROJECT_ID
   ```

   `login --no-localhost` shows a link: open it, sign in with the Google account that owns the
   Firebase project, copy the code back into Cloud Shell.
3. Next time: `cd candoni-bfms && git pull && npm ci && npx firebase-tools deploy --only firestore,functions --project YOUR_PROJECT_ID`.

## B. Automatic deploy on every merge (GitHub Actions)

Set this up once; afterwards every merge to `main` deploys the backend, and **Actions → CI →
Run workflow** redeploys on demand.

1. Google Cloud console → IAM & Admin → **Service accounts** → *Create service account*
   `bfms-deployer`, with the roles **Firebase Admin**, **Cloud Functions Admin**,
   **Service Account User**, **Artifact Registry Administrator** and **Cloud Build Editor**.
2. Open the account → **Keys** → *Add key* → *Create new key* → **JSON**. A file downloads.
3. GitHub → the repository → Settings → **Secrets and variables → Actions**:
   - *Secrets* → New repository secret **`GCP_SA_KEY`** = the whole content of that JSON file.
   - *Variables* → New repository variable **`FIREBASE_PROJECT_ID`** = your project ID.
4. GitHub → **Actions → CI → Run workflow** (branch `main`). The *deploy-backend* job deploys.
5. Delete the downloaded JSON file from the tablet. The key can be revoked any time in step 2's page.

Without these settings the deploy job is skipped with a warning instead of failing.
(Workload Identity Federation — variables `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA` — is also supported and avoids a stored key.)

## Also needed once for Google sign-in

Firebase console → Authentication:
- **Sign-in method** → enable **Google**.
- **Settings → Authorized domains** → add `candoni-bfms.netlify.app`.
