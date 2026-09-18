# 🌍 My World

A simple, cloud-backed photo gallery. Upload, organize into **folders**, search,
sort, rename, and delete photos — all stored in **Firebase** and hosted on **Vercel**.

- **UI**: static HTML / CSS / vanilla JS (no build step)
- **Images**: stored in Firestore as compressed Base64 (Firebase Storage is paid,
  so images are resized in the browser to fit Firestore's ~1MB document limit)
- **Metadata & folders**: Firebase **Firestore**
- **Hosting**: Vercel

## Features

- **Accounts & roles**: email/password sign-in with an **admin** (full read/write)
  and view-only users
- Drag & drop or browse to upload (multiple files) with live progress *(admin)*
- Create/delete **folders** and move photos between them *(admin)*
- "All Photos" view plus per-folder views with counts
- Search by name, sort by date/name/size
- Pick any uploaded photo as the **page background** (saved per browser)
- Lightbox viewer with keyboard navigation (← / → / Esc)
- Rename, download, delete photos; clear a whole folder *(admin)*

## 1. Configure Firebase

1. Create a project at <https://console.firebase.google.com>.
2. Add a **Web App** and copy the `firebaseConfig` values.
3. Paste them into [`firebase-config.js`](firebase-config.js) (replace `REPLACE_ME`).
4. In the console, enable:
   - **Authentication → Sign-in method → Email/Password**
   - **Firestore Database** (Storage is not needed — images are stored in Firestore)
5. **Set the admin email** in two places so they match:
   - `ADMIN_EMAILS` in [`firebase-config.js`](firebase-config.js)
   - `isAdmin()` email in [`firestore.rules`](firestore.rules)
6. Deploy the rules:
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules
   ```

### Creating the admin account
Open the app, go to the **Register** tab, and sign up using the exact admin email
you configured above. That account becomes the admin. Anyone else who registers
gets **view-only** access.

## 2. Run locally

Any static server works:

```bash
npx serve .
# then open the printed URL
```

## 3. Deploy to Vercel

```bash
npm i -g vercel
vercel        # first deploy (follow prompts)
vercel --prod # production deploy
```

The app is fully static, so Vercel serves it as-is (see `vercel.json`).
