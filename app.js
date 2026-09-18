/**
 * My World — cloud photo gallery.
 *
 * Storage model:
 *   - Firebase Storage        → the actual image files (photos/{id}/{filename})
 *   - Firestore "photos"      → one doc per photo (name, folderId, url, size…)
 *   - Firestore "folders"     → one doc per user-created folder
 *
 * "All Photos" is a virtual folder (folderId === null) that shows everything.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig, isConfigured, isAdminEmail } from "./firebase-config.js";

/* ---------- Firebase init ---------- */

let db = null;
let storage = null;
let auth = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  storage = getStorage(app);
  auth = getAuth(app);
}

/* ---------- State & DOM references ---------- */

let folders = []; // [{id, name, createdAt}]
let photos = []; // [{id, name, folderId, storagePath, url, size, type, createdAt}]
let currentFolderId = null; // null = "All Photos"
let visiblePhotos = [];
let currentIndex = -1;
let currentUser = null;
let isAdmin = false;

const el = {
  dropZone: document.getElementById("dropZone"),
  dropTarget: document.getElementById("dropTarget"),
  fileInput: document.getElementById("fileInput"),
  uploadBtn: document.getElementById("uploadBtn"),
  gallery: document.getElementById("gallery"),
  emptyState: document.getElementById("emptyState"),
  loadingState: document.getElementById("loadingState"),
  photoCount: document.getElementById("photoCount"),
  totalSize: document.getElementById("totalSize"),
  currentFolderName: document.getElementById("currentFolderName"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  resetBgBtn: document.getElementById("resetBgBtn"),
  bgLayer: document.getElementById("bgLayer"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  cardTemplate: document.getElementById("cardTemplate"),
  folderTemplate: document.getElementById("folderTemplate"),
  folderList: document.getElementById("folderList"),
  newFolderBtn: document.getElementById("newFolderBtn"),
  sidebar: document.getElementById("sidebar"),
  menuToggle: document.getElementById("menuToggle"),
  configBanner: document.getElementById("configBanner"),
  toast: document.getElementById("toast"),
  authScreen: document.getElementById("authScreen"),
  authTabs: document.querySelectorAll(".auth-tab"),
  loginForm: document.getElementById("loginForm"),
  registerForm: document.getElementById("registerForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  regEmail: document.getElementById("regEmail"),
  regPassword: document.getElementById("regPassword"),
  regConfirm: document.getElementById("regConfirm"),
  authError: document.getElementById("authError"),
  forgotBtn: document.getElementById("forgotBtn"),
  userBox: document.getElementById("userBox"),
  userEmail: document.getElementById("userEmail"),
  roleBadge: document.getElementById("roleBadge"),
  logoutBtn: document.getElementById("logoutBtn"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightboxImg"),
  lightboxCaption: document.getElementById("lightboxCaption"),
  lightboxClose: document.getElementById("lightboxClose"),
  lightboxPrev: document.getElementById("lightboxPrev"),
  lightboxNext: document.getElementById("lightboxNext"),
};

/* ---------- Helpers ---------- */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts) {
  if (!ts) return "";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function toMillis(ts) {
  if (!ts) return 0;
  return ts.toMillis ? ts.toMillis() : new Date(ts).getTime();
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2600);
}

/** Client-side guard for write actions. Server rules enforce this for real. */
function requireAdmin() {
  if (!isAdmin) {
    toast("View-only access — admin rights required.");
    return false;
  }
  return true;
}

function folderName(id) {
  if (id === null) return "All Photos";
  return folders.find((f) => f.id === id)?.name ?? "All Photos";
}

/* ---------- Page background ---------- */

const BG_KEY = "my-world-bg";

/** Apply the saved background photo, or clear it if that photo no longer exists. */
function applyBackground() {
  const id = localStorage.getItem(BG_KEY);
  const photo = id ? photos.find((p) => p.id === id) : null;
  if (photo) {
    el.bgLayer.style.backgroundImage = `linear-gradient(rgba(15,18,32,0.72), rgba(15,18,32,0.86)), url("${photo.url}")`;
    document.body.classList.add("has-bg");
    el.resetBgBtn.hidden = false;
  } else {
    if (id) localStorage.removeItem(BG_KEY);
    el.bgLayer.style.backgroundImage = "";
    document.body.classList.remove("has-bg");
    el.resetBgBtn.hidden = true;
  }
}

function setBackground(photo) {
  localStorage.setItem(BG_KEY, photo.id);
  applyBackground();
  toast(`"${photo.name}" set as background`);
}

function clearBackground() {
  localStorage.removeItem(BG_KEY);
  applyBackground();
  toast("Background reset");
}

/* ---------- Data loading ---------- */

async function loadFolders() {
  const snap = await getDocs(query(collection(db, "folders"), orderBy("name")));
  folders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadPhotos() {
  const snap = await getDocs(query(collection(db, "photos"), orderBy("createdAt", "desc")));
  photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function refresh() {
  if (!isConfigured) {
    el.configBanner.hidden = false;
    el.emptyState.style.display = "block";
    renderFolders();
    return;
  }
  el.loadingState.hidden = false;
  el.emptyState.style.display = "none";
  try {
    await Promise.all([loadFolders(), loadPhotos()]);
    renderFolders();
    render();
  } catch (err) {
    console.error(err);
    toast("Could not load data. Check your Firebase config and rules.");
  } finally {
    el.loadingState.hidden = true;
  }
}

/* ---------- Upload ---------- */

function uploadOne(file, folderId) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const path = `photos/${id}/${file.name}`;
    const task = uploadBytesResumable(storageRef(storage, path), file, {
      contentType: file.type,
    });

    // Optimistic placeholder card so the user sees progress immediately.
    const placeholder = renderUploadingCard(file);

    task.on(
      "state_changed",
      (snap) => {
        const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
        placeholder?.setProgress(pct);
      },
      (err) => {
        placeholder?.remove();
        reject(err);
      },
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        const data = {
          name: file.name.replace(/\.[^.]+$/, ""),
          folderId: folderId ?? null,
          storagePath: path,
          url,
          size: file.size,
          type: file.type,
          createdAt: serverTimestamp(),
        };
        const added = await addDoc(collection(db, "photos"), data);
        photos.unshift({ id: added.id, ...data, createdAt: Date.now() });
        placeholder?.remove();
        resolve();
      }
    );
  });
}

async function handleFiles(fileList) {
  if (!isConfigured) {
    toast("Configure Firebase first (see firebase-config.js).");
    return;
  }
  if (!requireAdmin()) return;
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) {
    toast("Please choose image files.");
    return;
  }
  toast(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`);
  try {
    for (const file of files) await uploadOne(file, currentFolderId);
    toast("Upload complete");
  } catch (err) {
    console.error(err);
    toast("Upload failed. Check Storage rules.");
  }
  render();
  renderFolders();
}

/* ---------- Rendering ---------- */

function getVisiblePhotos() {
  const q = el.searchInput.value.trim().toLowerCase();
  let list = photos.filter((p) => {
    const inFolder = currentFolderId === null || p.folderId === currentFolderId;
    return inFolder && p.name.toLowerCase().includes(q);
  });

  switch (el.sortSelect.value) {
    case "oldest":
      list.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
      break;
    case "name":
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "size":
      list.sort((a, b) => b.size - a.size);
      break;
    default:
      list.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  }
  return list;
}

function moveOptions(selectedId) {
  const opts = [`<option value="">All Photos (no folder)</option>`];
  for (const f of folders) {
    const sel = f.id === selectedId ? " selected" : "";
    opts.push(`<option value="${f.id}"${sel}>${escapeHtml(f.name)}</option>`);
  }
  return opts.join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render() {
  visiblePhotos = getVisiblePhotos();
  el.gallery.innerHTML = "";

  const total = photos.filter((p) => currentFolderId === null || p.folderId === currentFolderId);
  el.emptyState.style.display = visiblePhotos.length === 0 ? "block" : "none";
  el.currentFolderName.textContent = folderName(currentFolderId);
  el.dropTarget.textContent = folderName(currentFolderId);

  for (let i = 0; i < visiblePhotos.length; i++) {
    const photo = visiblePhotos[i];
    const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
    const img = node.querySelector("img");
    const nameInput = node.querySelector(".card-name");
    const meta = node.querySelector(".card-meta");
    const moveSel = node.querySelector(".card-move");

    img.src = photo.url;
    img.alt = photo.name;
    nameInput.value = photo.name;
    nameInput.readOnly = !isAdmin;
    meta.textContent = `${formatSize(photo.size)} • ${formatDate(photo.createdAt)}`;
    moveSel.innerHTML = moveOptions(photo.folderId ?? "");

    node.querySelector(".card-media").addEventListener("click", () => openLightbox(i));
    node.querySelector(".view").addEventListener("click", () => openLightbox(i));
    node.querySelector(".setbg").addEventListener("click", () => setBackground(photo));
    node.querySelector(".download").addEventListener("click", () => downloadPhoto(photo));
    node.querySelector(".delete").addEventListener("click", () => deletePhoto(photo));

    nameInput.addEventListener("change", async () => {
      if (!requireAdmin()) {
        nameInput.value = photo.name;
        return;
      }
      const name = nameInput.value.trim() || "Untitled";
      nameInput.value = name;
      photo.name = name;
      await updateDoc(doc(db, "photos", photo.id), { name });
      toast("Renamed");
    });

    moveSel.addEventListener("change", async () => {
      if (!requireAdmin()) return;
      const target = moveSel.value || null;
      photo.folderId = target;
      await updateDoc(doc(db, "photos", photo.id), { folderId: target });
      toast(`Moved to ${folderName(target)}`);
      render();
      renderFolders();
    });

    el.gallery.appendChild(node);
  }

  el.photoCount.textContent = `${total.length} photo${total.length === 1 ? "" : "s"}`;
  el.totalSize.textContent = formatSize(total.reduce((s, p) => s + p.size, 0));
  applyBackground();
}

/** Adds a temporary card that shows upload progress; returns handles to update it. */
function renderUploadingCard(file) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector("img");
  const bar = node.querySelector(".card-progress");
  const fill = bar.querySelector("span");
  node.querySelector(".card-name").value = file.name;
  node.querySelector(".card-meta").textContent = "Uploading…";
  node.querySelector(".card-actions").style.display = "none";
  img.src = URL.createObjectURL(file);
  bar.hidden = false;
  el.emptyState.style.display = "none";
  el.gallery.prepend(node);
  return {
    setProgress: (pct) => (fill.style.width = `${pct}%`),
    remove: () => node.remove(),
  };
}

function renderFolders() {
  el.folderList.innerHTML = "";

  const makeItem = (id, name, count) => {
    const node = el.folderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".folder-name").textContent = name;
    node.querySelector(".folder-count").textContent = count;
    if (id === currentFolderId) node.classList.add("active");
    if (id === null) {
      node.querySelector(".folder-icon").textContent = "🗂️";
      node.querySelector(".folder-del").remove();
    } else {
      node.querySelector(".folder-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteFolder(id, name);
      });
    }
    node.querySelector(".folder-btn").addEventListener("click", () => selectFolder(id));
    el.folderList.appendChild(node);
  };

  makeItem(null, "All Photos", photos.length);
  for (const f of folders) {
    const count = photos.filter((p) => p.folderId === f.id).length;
    makeItem(f.id, f.name, count);
  }
}

function selectFolder(id) {
  currentFolderId = id;
  el.sidebar.classList.remove("open");
  render();
  renderFolders();
}

/* ---------- Folder actions ---------- */

async function createFolder() {
  if (!isConfigured) {
    toast("Configure Firebase first (see firebase-config.js).");
    return;
  }
  if (!requireAdmin()) return;
  const name = prompt("Folder name:");
  if (!name || !name.trim()) return;
  const data = { name: name.trim(), createdAt: serverTimestamp() };
  const added = await addDoc(collection(db, "folders"), data);
  folders.push({ id: added.id, ...data });
  folders.sort((a, b) => a.name.localeCompare(b.name));
  toast(`Folder "${data.name}" created`);
  renderFolders();
}

async function deleteFolder(id, name) {
  if (!requireAdmin()) return;
  const count = photos.filter((p) => p.folderId === id).length;
  const msg =
    count > 0
      ? `Delete folder "${name}"? Its ${count} photo(s) will move to All Photos.`
      : `Delete folder "${name}"?`;
  if (!confirm(msg)) return;

  const affected = photos.filter((p) => p.folderId === id);
  await Promise.all(affected.map((p) => updateDoc(doc(db, "photos", p.id), { folderId: null })));
  affected.forEach((p) => (p.folderId = null));

  await deleteDoc(doc(db, "folders", id));
  folders = folders.filter((f) => f.id !== id);
  if (currentFolderId === id) currentFolderId = null;
  toast("Folder deleted");
  render();
  renderFolders();
}

/* ---------- Photo actions ---------- */

async function downloadPhoto(photo) {
  try {
    const res = await fetch(photo.url);
    const blob = await res.blob();
    const ext = (photo.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${photo.name}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(photo.url, "_blank");
  }
}

async function deletePhoto(photo) {
  if (!requireAdmin()) return;
  if (!confirm(`Delete "${photo.name}"?`)) return;
  try {
    await deleteDoc(doc(db, "photos", photo.id));
    if (photo.storagePath) {
      await deleteObject(storageRef(storage, photo.storagePath)).catch(() => {});
    }
    photos = photos.filter((p) => p.id !== photo.id);
    toast("Photo deleted");
    render();
    renderFolders();
  } catch (err) {
    console.error(err);
    toast("Delete failed.");
  }
}

async function clearFolder() {
  if (!requireAdmin()) return;
  const target = photos.filter((p) => currentFolderId === null || p.folderId === currentFolderId);
  if (target.length === 0) return;
  const where = folderName(currentFolderId);
  if (!confirm(`Delete all ${target.length} photo(s) in "${where}"? This cannot be undone.`)) return;
  try {
    for (const p of target) {
      await deleteDoc(doc(db, "photos", p.id));
      if (p.storagePath) await deleteObject(storageRef(storage, p.storagePath)).catch(() => {});
    }
    const ids = new Set(target.map((p) => p.id));
    photos = photos.filter((p) => !ids.has(p.id));
    toast("Folder cleared");
    render();
    renderFolders();
  } catch (err) {
    console.error(err);
    toast("Clear failed.");
  }
}

/* ---------- Lightbox ---------- */

function openLightbox(index) {
  currentIndex = index;
  showLightboxPhoto();
  el.lightbox.hidden = false;
}

function showLightboxPhoto() {
  const photo = visiblePhotos[currentIndex];
  if (!photo) return;
  el.lightboxImg.src = photo.url;
  el.lightboxImg.alt = photo.name;
  el.lightboxCaption.textContent = `${photo.name} — ${formatSize(photo.size)} • ${formatDate(
    photo.createdAt
  )}`;
}

function closeLightbox() {
  el.lightbox.hidden = true;
  currentIndex = -1;
}

function navLightbox(step) {
  if (visiblePhotos.length === 0) return;
  currentIndex = (currentIndex + step + visiblePhotos.length) % visiblePhotos.length;
  showLightboxPhoto();
}

/* ---------- Event wiring ---------- */

el.uploadBtn.addEventListener("click", () => el.fileInput.click());
el.dropZone.addEventListener("click", () => el.fileInput.click());
el.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    el.fileInput.click();
  }
});

el.fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  el.fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("dragover");
  })
);
el.dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

el.searchInput.addEventListener("input", render);
el.sortSelect.addEventListener("change", render);
el.clearAllBtn.addEventListener("click", clearFolder);
el.resetBgBtn.addEventListener("click", clearBackground);
el.newFolderBtn.addEventListener("click", createFolder);
el.menuToggle.addEventListener("click", () => el.sidebar.classList.toggle("open"));

el.lightboxClose.addEventListener("click", closeLightbox);
el.lightboxPrev.addEventListener("click", () => navLightbox(-1));
el.lightboxNext.addEventListener("click", () => navLightbox(1));
el.lightbox.addEventListener("click", (e) => {
  if (e.target === el.lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (el.lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") navLightbox(-1);
  if (e.key === "ArrowRight") navLightbox(1);
});

/* ---------- Auth ---------- */

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "That email address looks invalid.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

function showAuthTab(tab) {
  el.authTabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  el.loginForm.hidden = tab !== "login";
  el.registerForm.hidden = tab !== "register";
  el.authError.style.color = "";
  el.authError.textContent = "";
}

function updateAuthUI() {
  const signedIn = !!currentUser;
  el.authScreen.hidden = signedIn;
  el.userBox.hidden = !signedIn;
  document.body.classList.toggle("is-admin", isAdmin);
  document.body.classList.toggle("is-viewer", signedIn && !isAdmin);
  if (signedIn) {
    el.userEmail.textContent = currentUser.email;
    el.roleBadge.textContent = isAdmin ? "Admin" : "Viewer";
    el.roleBadge.classList.toggle("admin", isAdmin);
  }
}

el.authTabs.forEach((btn) => btn.addEventListener("click", () => showAuthTab(btn.dataset.tab)));

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.authError.style.color = "";
  el.authError.textContent = "";
  try {
    await signInWithEmailAndPassword(auth, el.loginEmail.value.trim(), el.loginPassword.value);
    el.loginForm.reset();
  } catch (err) {
    el.authError.textContent = friendlyAuthError(err.code);
  }
});

el.registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.authError.style.color = "";
  el.authError.textContent = "";
  if (el.regPassword.value !== el.regConfirm.value) {
    el.authError.textContent = "Passwords do not match.";
    return;
  }
  try {
    await createUserWithEmailAndPassword(auth, el.regEmail.value.trim(), el.regPassword.value);
    el.registerForm.reset();
  } catch (err) {
    el.authError.textContent = friendlyAuthError(err.code);
  }
});

el.logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    toast("Could not log out.");
  }
});

el.forgotBtn.addEventListener("click", async () => {
  const email = el.loginEmail.value.trim();
  if (!email) {
    el.authError.textContent = "Enter your email above, then click Forgot password.";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    el.authError.style.color = "var(--accent)";
    el.authError.textContent = `Password reset link sent to ${email}. Check your inbox.`;
  } catch (err) {
    el.authError.style.color = "";
    el.authError.textContent = friendlyAuthError(err.code);
  }
});

/* ---------- Boot ---------- */

if (isConfigured) {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    isAdmin = !!user && isAdminEmail(user.email);
    updateAuthUI();
    if (user) {
      refresh();
    } else {
      photos = [];
      folders = [];
      currentFolderId = null;
      el.gallery.innerHTML = "";
      el.folderList.innerHTML = "";
      showAuthTab("login");
    }
  });
} else {
  el.authScreen.hidden = false;
  el.loginForm.hidden = true;
  el.registerForm.hidden = true;
  el.authError.textContent = "Firebase is not configured yet. Edit firebase-config.js to enable sign-in.";
}
