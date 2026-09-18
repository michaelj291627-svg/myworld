/**
 * My World — cloud photo gallery.
 *
 * Storage model (Firebase Storage is paid, so images live in Firestore):
 *   - Firestore "photos"   → one doc per photo; the image is a compressed
 *                            Base64 data URL kept under Firestore's ~1MB limit.
 *   - Firestore "folders"  → one doc per user-created folder.
 *
 * "All Photos" is a virtual folder (folderId === null) that shows everything.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
let auth = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
}

/* ---------- State & DOM references ---------- */

let folders = []; // [{id, name, createdAt}]
let photos = []; // [{id, name, folderId, url(dataURL), size, type, createdAt}]
let currentFolderId = null; // null = "All Photos"
let visiblePhotos = [];
let currentIndex = -1;
let currentUser = null;
let isAdmin = false;
let allUsers = [];
let isRegistering = false;

const el = {
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
  homeBtn: document.getElementById("homeBtn"),
  welcomeScreen: document.getElementById("welcomeScreen"),
  welcomeEmail: document.getElementById("welcomeEmail"),
  welcomeRole: document.getElementById("welcomeRole"),
  welcomeLogout: document.getElementById("welcomeLogout"),
  goToPhotosBtn: document.getElementById("goToPhotosBtn"),
  refreshUsersBtn: document.getElementById("refreshUsersBtn"),
  userList: document.getElementById("userList"),
  userRowTemplate: document.getElementById("userRowTemplate"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightboxImg"),
  lightboxCaption: document.getElementById("lightboxCaption"),
  lightboxClose: document.getElementById("lightboxClose"),
  lightboxDelete: document.getElementById("lightboxDelete"),
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

/** Reject after `ms` if the promise hasn't settled, so the UI can recover. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/** Share the actual image via the device share sheet (WhatsApp etc.). */
async function shareToWhatsApp(photo) {
  try {
    const blob = await (await fetch(photo.url)).blob();
    const file = new File([blob], `${photo.name}.jpg`, { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: photo.name, text: photo.name });
      return;
    }
    // Desktop can't attach a local image to WhatsApp; open a chat with the caption.
    window.open(`https://wa.me/?text=${encodeURIComponent(photo.name)}`, "_blank", "noopener");
    toast("Tip: use a phone to send the image itself to WhatsApp.");
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.error(err);
      toast("Could not share this photo.");
    }
  }
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
  el.configBanner.hidden = true;
  try {
    // Time-box the read so the UI never spins forever if Firestore isn't set up.
    await withTimeout(Promise.all([loadFolders(), loadPhotos()]), 12000);
    renderFolders();
    render();
  } catch (err) {
    console.error(err);
    el.configBanner.hidden = false;
    el.configBanner.innerHTML =
      "⚠️ Couldn't reach Firestore. In the Firebase console create the " +
      "<strong>Firestore Database</strong> (test mode), then reload. " +
      "If it exists, deploy the rules so reads are allowed.";
    el.emptyState.style.display = "block";
  } finally {
    el.loadingState.hidden = true;
  }
}

/* ---------- Upload ---------- */

const MAX_DOC_BYTES = 950000; // stay safely under Firestore's ~1,048,576 byte doc limit

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function drawToDataUrl(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function approxBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return Math.floor((dataUrl.length - comma - 1) * 0.75);
}

/** Resize + compress in the browser until the Base64 fits in one Firestore doc. */
async function compressToDataUrl(file) {
  const img = await loadImage(file);
  let maxDim = 1600;
  let quality = 0.82;
  let dataUrl = drawToDataUrl(img, maxDim, quality);
  while (approxBytes(dataUrl) > MAX_DOC_BYTES && (quality > 0.4 || maxDim > 600)) {
    if (quality > 0.5) quality -= 0.1;
    else maxDim = Math.round(maxDim * 0.8);
    dataUrl = drawToDataUrl(img, maxDim, quality);
  }
  return dataUrl;
}

async function uploadOne(file, folderId) {
  const placeholder = renderUploadingCard(file);
  try {
    placeholder?.setProgress(25);
    const dataUrl = await compressToDataUrl(file);
    if (approxBytes(dataUrl) > MAX_DOC_BYTES) throw new Error("too-large");
    placeholder?.setProgress(70);
    const data = {
      name: file.name.replace(/\.[^.]+$/, ""),
      folderId: folderId ?? null,
      url: dataUrl,
      size: approxBytes(dataUrl),
      type: "image/jpeg",
      createdAt: serverTimestamp(),
    };
    const added = await addDoc(collection(db, "photos"), data);
    photos.unshift({ id: added.id, ...data, createdAt: Date.now() });
    placeholder?.setProgress(100);
  } finally {
    placeholder?.remove();
  }
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
    toast(
      err?.message === "too-large"
        ? "A photo is too large even after compression."
        : "Upload failed. Please try again."
    );
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
    node.querySelector(".share").addEventListener("click", () => shareToWhatsApp(photo));
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

/** Delete the photo currently open in the lightbox, then advance or close. */
async function deleteFromLightbox() {
  const photo = visiblePhotos[currentIndex];
  if (!photo) return;
  const before = visiblePhotos.length;
  await deletePhoto(photo); // handles confirm + Firestore delete + re-render
  if (visiblePhotos.length === before) return; // cancelled or failed
  if (visiblePhotos.length === 0) {
    closeLightbox();
  } else {
    currentIndex = Math.min(currentIndex, visiblePhotos.length - 1);
    showLightboxPhoto();
  }
}

/* ---------- Event wiring ---------- */

el.uploadBtn.addEventListener("click", () => el.fileInput.click());

el.fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  el.fileInput.value = "";
});

el.searchInput.addEventListener("input", render);
el.sortSelect.addEventListener("change", render);
el.clearAllBtn.addEventListener("click", clearFolder);
el.resetBgBtn.addEventListener("click", clearBackground);
el.newFolderBtn.addEventListener("click", createFolder);
el.menuToggle.addEventListener("click", () => el.sidebar.classList.toggle("open"));

el.lightboxClose.addEventListener("click", closeLightbox);
el.lightboxDelete.addEventListener("click", deleteFromLightbox);
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
    el.welcomeEmail.textContent = currentUser.email;
    el.welcomeRole.textContent = isAdmin ? "Admin" : "Viewer";
    el.welcomeRole.classList.toggle("admin", isAdmin);
  }
}

/* ---------- Welcome navigation ---------- */

// Home-page background images (rotated every minute for all users).
const HOME_BACKGROUNDS = [
  "silhouettes-family-walking-together-against-vibrant-colorful-background_1305360-6079.avif",
  "family-four-is-walking-through-field-grass-with-beautiful-sunset-background-scene-is-peaceful-serene-as-family-enjoys-their-time-together-nature_190086-11756.avif",
];
const HOME_BG_OVERLAY = "linear-gradient(rgba(15,18,32,0.74), rgba(15,18,32,0.9))";
let homeBgIndex = 0;
let homeBgTimer = null;

function applyHomeBg() {
  const src = encodeURI(HOME_BACKGROUNDS[homeBgIndex]);
  el.welcomeScreen.style.backgroundImage = `${HOME_BG_OVERLAY}, url("${src}")`;
}

function startHomeBgRotation() {
  homeBgIndex = Math.floor(Math.random() * HOME_BACKGROUNDS.length);
  applyHomeBg();
  clearInterval(homeBgTimer);
  homeBgTimer = setInterval(() => {
    homeBgIndex = (homeBgIndex + 1) % HOME_BACKGROUNDS.length;
    applyHomeBg();
  }, 60000);
}

function stopHomeBgRotation() {
  clearInterval(homeBgTimer);
  homeBgTimer = null;
}

function showWelcome() {
  el.welcomeScreen.hidden = false;
  startHomeBgRotation();
  if (isAdmin) loadUsers();
}

function goToPhotos() {
  el.welcomeScreen.hidden = true;
  stopHomeBgRotation();
}

/* ---------- User accounts (admin) ---------- */

/** Read the caller's profile; create it during registration or for the primary admin. */
async function ensureUserProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return { id: user.uid, ...snap.data() };
  if (isRegistering || isAdminEmail(user.email)) {
    const data = {
      email: user.email,
      role: isAdminEmail(user.email) ? "admin" : "viewer",
      createdAt: serverTimestamp(),
    };
    await setDoc(ref, data);
    isRegistering = false;
    return { id: user.uid, ...data };
  }
  return null; // profile was deleted by an admin
}

async function loadUsers() {
  if (!isAdmin) return;
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("email")));
    allUsers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderUserList();
  } catch (err) {
    console.error(err);
    toast("Couldn't load users.");
  }
}

function renderUserList() {
  el.userList.innerHTML = "";
  for (const u of allUsers) {
    const node = el.userRowTemplate.content.firstElementChild.cloneNode(true);
    const roleBadge = node.querySelector(".user-row-role");
    const toggle = node.querySelector(".user-role-toggle");
    const del = node.querySelector(".user-delete");
    const admin = u.role === "admin";
    const isSelf = currentUser && u.id === currentUser.uid;
    const isPrimary = isAdminEmail(u.email);

    node.querySelector(".user-row-email").textContent = u.email;
    roleBadge.textContent = admin ? "Admin" : "Viewer";
    roleBadge.classList.toggle("admin", admin);
    toggle.textContent = admin ? "Make viewer" : "Make admin";

    // The primary admin can't be demoted or deleted; you can't delete yourself.
    toggle.disabled = isPrimary;
    del.disabled = isPrimary || isSelf;

    toggle.addEventListener("click", () => changeUserRole(u, admin ? "viewer" : "admin"));
    del.addEventListener("click", () => deleteUser(u));
    el.userList.appendChild(node);
  }
}

async function changeUserRole(u, role) {
  if (!isAdmin) return;
  try {
    await updateDoc(doc(db, "users", u.id), { role });
    u.role = role;
    renderUserList();
    toast(`${u.email} is now ${role}`);
  } catch (err) {
    console.error(err);
    toast("Could not update role.");
  }
}

async function deleteUser(u) {
  if (!isAdmin) return;
  if (currentUser && u.id === currentUser.uid) {
    toast("You can't delete your own account.");
    return;
  }
  if (isAdminEmail(u.email)) {
    toast("The primary admin can't be deleted.");
    return;
  }
  if (!confirm(`Delete account ${u.email}? They will lose access to My World.`)) return;
  try {
    await deleteDoc(doc(db, "users", u.id));
    allUsers = allUsers.filter((x) => x.id !== u.id);
    renderUserList();
    toast("Account removed");
  } catch (err) {
    console.error(err);
    toast("Could not delete account.");
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
    isRegistering = true;
    await createUserWithEmailAndPassword(auth, el.regEmail.value.trim(), el.regPassword.value);
    el.registerForm.reset();
  } catch (err) {
    isRegistering = false;
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

el.welcomeLogout.addEventListener("click", () => el.logoutBtn.click());
el.goToPhotosBtn.addEventListener("click", goToPhotos);
el.homeBtn.addEventListener("click", showWelcome);
el.refreshUsersBtn.addEventListener("click", loadUsers);

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
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      let profile;
      try {
        profile = await ensureUserProfile(user);
      } catch (err) {
        console.error(err);
        toast("Couldn't load your account.");
        return;
      }
      if (!profile) {
        alert("Your account has been removed by the admin.");
        await signOut(auth);
        return;
      }
      isAdmin = profile.role === "admin" || isAdminEmail(user.email);
      updateAuthUI();
      showWelcome();
      refresh();
    } else {
      isAdmin = false;
      allUsers = [];
      photos = [];
      folders = [];
      currentFolderId = null;
      el.gallery.innerHTML = "";
      el.folderList.innerHTML = "";
      el.userList.innerHTML = "";
      el.welcomeScreen.hidden = true;
      stopHomeBgRotation();
      updateAuthUI();
      showAuthTab("login");
    }
  });
} else {
  el.authScreen.hidden = false;
  el.loginForm.hidden = true;
  el.registerForm.hidden = true;
  el.authError.textContent = "Firebase is not configured yet. Edit firebase-config.js to enable sign-in.";
}
