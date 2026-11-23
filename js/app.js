// Daily Diaries - app logic
// Data lives only in Cloud Firestore (users/{uid}/days/{date} and users/{uid}/tasks/{id}).
// Nothing is written to localStorage or sessionStorage.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, GoogleAuthProvider,
  signOut, setPersistence, indexedDBLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, memoryLocalCache,
  doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { QUOTES } from "./quotes.js";

/* ==========================================================================
   Constants
   ========================================================================== */

// The four priority buckets. Keys are kept from the earlier version so saved tasks still match.
const PRIORITIES = [
  { key: "urgent",   label: "High priority",              color: "#FDA4AF", hint: "Must do now" },
  { key: "normal",   label: "Medium priority",            color: "#FDE047", hint: "Should do soon" },
  { key: "okay",     label: "Low priority",               color: "#7DD3FC", hint: "Nice to do" },
  { key: "whenever", label: "No priority / Whenever",     color: "#52525B", hint: "Whenever I like, have time or am in the mood" }
];
// Old saved values that map onto the four buckets above.
const LEGACY_PRIORITY = { none: "whenever" };
const normalizePriority = p => (p in LEGACY_PRIORITY ? LEGACY_PRIORITY[p] : (p ?? null));
// Fallback colour for tasks that are not yet in a bucket (not shown as a chip).
const UNSORTED = { key: null, label: "Not sorted", color: "#475569", hint: "Not prioritised yet" };
const PRIORITY_BY_KEY = Object.fromEntries(PRIORITIES.map(p => [p.key, p]));
// Short names for the one-line bucket summary on phones.
const SHORT_LABEL = { urgent: "High", normal: "Medium", okay: "Low", whenever: "Whenever" };

// Ratings are shown with a medal name first and the original day name second.
// Keys are unchanged, so existing saved ratings still match.
// Keys are unchanged from earlier versions, so saved ratings still match.
const RATINGS = [
  { key: "gold",    shape: "diamond", metal: "Diamond day",     title: "Standout day", desc: "I achieved something, made a difference, and this day stood out.", color: "#7DD3FC" },
  { key: "best",    shape: "gold",    metal: "Golden day",      title: "Best day",     desc: "I made good use of everything and I feel happy.",                   color: "#FDE047" },
  { key: "average", shape: "silver",  metal: "Silver day",      title: "Average day",  desc: "Some done, some not. Nothing spent, nothing bad.",                 color: "#CBD5E1" },
  { key: "wasted",  shape: "rust",    metal: "Rusty iron day",  title: "Wasted day",   desc: "A flop. The day was totally wasted.",                              color: "#C2410C" }
];

// The two entry lists. Each one is saved as an array on the day's page.
const ENTRY_KINDS = {
  gratitude: { field: "gratitudeItems", legacy: d => splitGratitude(d.gratitude || "") },
  release: { field: "frustrationItems", legacy: d => String(d.frustrations || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
};
// items = saved entries; editing/draft = the open editor (saved only when the edit button is tapped again).
const entryState = {
  gratitude: { items: [], editing: false, draft: [] },
  release: { items: [], editing: false, draft: [] }
};
const GRATITUDE_SPLIT = /(?=\bI\s*(?:['’]\s*m|\s+am)\s+grateful\b)/i;
// Diamond badge with a floating gem, a light sweep and twinkling sparkles (animated in styles.css).
const DIAMOND_SVG = `<svg class="badge-icon diamond" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="dia-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F0FBFF"/><stop offset="0.5" stop-color="#7DD3FC"/><stop offset="1" stop-color="#38BDF8"/></linearGradient><clipPath id="dia-clip"><path d="M32 6 L56 26 L32 58 L8 26 Z"/></clipPath></defs><g class="gem"><path d="M32 6 L56 26 L32 58 L8 26 Z" fill="url(#dia-grad)"/><path d="M8 26 H56 M22 26 L32 6 L42 26 M22 26 L32 58 L42 26" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.4" stroke-linejoin="round"/><g clip-path="url(#dia-clip)"><rect class="shine" x="0" y="0" width="9" height="64" fill="rgba(255,255,255,0.85)"/></g></g><path class="spark s1" d="M54 4 L55.6 8.4 L60 10 L55.6 11.6 L54 16 L52.4 11.6 L48 10 L52.4 8.4 Z" fill="#ffffff"/><path class="spark s2" d="M10 2 L11.2 5.2 L14.4 6.4 L11.2 7.6 L10 10.8 L8.8 7.6 L5.6 6.4 L8.8 5.2 Z" fill="#ffffff"/><path class="spark s3" d="M58 44 L59 46.6 L61.6 47.6 L59 48.6 L58 51.2 L57 48.6 L54.4 47.6 L57 46.6 Z" fill="#E0F7FF"/></svg>`;
// Star-shaped badges for the Golden, Silver and Rusty iron days.
const BIG_STAR = "M32 4 L39.5 22.5 L59 24.5 L44 37.5 L48.5 57 L32 46.5 L15.5 57 L20 37.5 L5 24.5 L24.5 22.5 Z";
const SPARK_L = `<path class="spark s1" d="M54 4 L55.6 8.4 L60 10 L55.6 11.6 L54 16 L52.4 11.6 L48 10 L52.4 8.4 Z" fill="#FFFBEB"/>`;
const SPARK_R = `<path class="spark s2" d="M10 2 L11.2 5.2 L14.4 6.4 L11.2 7.6 L10 10.8 L8.8 7.6 L5.6 6.4 L8.8 5.2 Z" fill="#FFFBEB"/>`;
const GOLD_SVG = `<svg class="badge-icon gold" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="gold-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FEF9C3"/><stop offset="0.45" stop-color="#FDE047"/><stop offset="1" stop-color="#CA8A04"/></linearGradient><radialGradient id="gold-radial"><stop offset="0" stop-color="#FDE047" stop-opacity="0.6"/><stop offset="1" stop-color="#FDE047" stop-opacity="0"/></radialGradient><clipPath id="gold-clip"><path d="${BIG_STAR}"/></clipPath></defs><circle class="glow" cx="32" cy="32" r="31" fill="url(#gold-radial)"/><g class="halo"><circle cx="32" cy="32" r="29" fill="none" stroke="#FDE047" stroke-width="1.2" stroke-dasharray="3 5"/></g><g class="body"><path d="${BIG_STAR}" fill="url(#gold-grad)" stroke="#EAB308" stroke-width="1.5" stroke-linejoin="round"/><g clip-path="url(#gold-clip)"><rect class="sheen" x="0" y="0" width="12" height="64" fill="rgba(255,255,255,0.85)"/></g></g>${SPARK_L}${SPARK_R}</svg>`;
// One crack line shared by the rusty star and the silver star, so the healing follows the same scratches exactly.
const CRACK_MAIN = "M36 6 L30 26 L38 40 L28 58";
const CRACK_BRANCHES = "M30 26 L19 31 L13 28 M38 40 L49 35 L57 38 M28 58 L22 51 L16 53 M36 6 L45 13 L52 10";
const CRACK_ALL = `${CRACK_MAIN} ${CRACK_BRANCHES}`;
const SILVER_SVG = `<svg class="badge-icon silver" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="silver-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#CBD5E1"/><stop offset="1" stop-color="#64748B"/></linearGradient><radialGradient id="heal-aura"><stop offset="0" stop-color="#A7F3D0" stop-opacity="0.55"/><stop offset="1" stop-color="#A7F3D0" stop-opacity="0"/></radialGradient><clipPath id="silver-clip"><path d="${BIG_STAR}"/></clipPath></defs><circle class="aura" cx="32" cy="32" r="31" fill="url(#heal-aura)"/><g class="body"><path d="${BIG_STAR}" fill="url(#silver-grad)" stroke="#94A3B8" stroke-width="1.5" stroke-linejoin="round"/><g clip-path="url(#silver-clip)"><rect class="sheen" x="0" y="0" width="10" height="64" fill="rgba(255,255,255,0.7)"/></g><g clip-path="url(#silver-clip)"><path class="scar" d="${CRACK_ALL}" fill="none" stroke="#64748B" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"/><path class="heal seam-glow" pathLength="100" d="${CRACK_ALL}" fill="none" stroke="#6EE7B7" stroke-opacity="0.35" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path class="heal seam" pathLength="100" d="${CRACK_ALL}" fill="none" stroke="#F1F5F9" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/></g></g><circle class="glint" r="1.9" fill="#ECFDF5"><animateMotion dur="4.2s" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.55;1" keyPoints="0;1;1" path="${CRACK_MAIN}"/></circle><g class="plus p1"><path d="M12 40 h4 M14 38 v4" stroke="#A7F3D0" stroke-width="1.6" stroke-linecap="round"/></g><g class="plus p2"><path d="M50 44 h4 M52 42 v4" stroke="#A7F3D0" stroke-width="1.6" stroke-linecap="round"/></g><g class="plus p3"><path d="M30 57 h3 M31.5 55.5 v3" stroke="#6EE7B7" stroke-width="1.4" stroke-linecap="round"/></g></svg>`;
const RUST_SVG = `<svg class="badge-icon rust" viewBox="0 0 64 64" aria-hidden="true"><defs><filter id="rust-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="noise"/><feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.12  0 0 0 0 0.03  0 0 0 -2.4 1.3" result="spots"/><feComposite in="spots" in2="SourceGraphic" operator="in" result="rustSpots"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="rustSpots"/></feMerge></filter><linearGradient id="rust-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C2410C"/><stop offset="0.6" stop-color="#9A3412"/><stop offset="1" stop-color="#6B3A1F"/></linearGradient><clipPath id="rust-star"><path d="${BIG_STAR}"/></clipPath><clipPath id="rust-left"><polygon points="0,0 36,0 36,6 30,26 38,40 28,58 28,64 0,64"/></clipPath><clipPath id="rust-right"><polygon points="36,0 64,0 64,64 28,64 28,58 38,40 30,26 36,6"/></clipPath></defs><g class="body"><g class="shard shard-a"><path d="${BIG_STAR}" fill="url(#rust-grad)" stroke="#7C2D12" stroke-width="1.5" stroke-linejoin="round" filter="url(#rust-grain)" clip-path="url(#rust-left)"/></g><g class="shard shard-b"><path d="${BIG_STAR}" fill="url(#rust-grad)" stroke="#7C2D12" stroke-width="1.5" stroke-linejoin="round" filter="url(#rust-grain)" clip-path="url(#rust-right)"/></g><g clip-path="url(#rust-star)"><path class="crack" d="${CRACK_ALL}" fill="none" stroke="#1C0A02" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></g></g><polygon class="flake f1" points="17,45 23,41 24,48" fill="#B45309"/><polygon class="flake f2" points="44,51 50,47 49,54" fill="#9A3412"/><polygon class="flake f3" points="30,56 35,53 34,59" fill="#B45309"/></svg>`;
const BADGE_SVG = { diamond: DIAMOND_SVG, gold: GOLD_SVG, silver: SILVER_SVG, rust: RUST_SVG };
const STAR_PATH ="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6-4.9-4.6 6.6-.8z";
const DOTS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`;

/* ==========================================================================
   Firebase
   ========================================================================== */

const configured = firebaseConfig && !String(firebaseConfig.apiKey).startsWith("YOUR_");
let auth = null;
let db = null;

if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Keep the sign-in in IndexedDB (not localStorage).
  setPersistence(auth, indexedDBLocalPersistence).catch(() => {});
  // Firestore is the only place data is stored. The cache lives in memory
  // for this session only, so nothing is kept in the browser between visits.
  // Every device reads the same Firestore data, so all devices stay in sync.
  db = initializeFirestore(app, {
    localCache: memoryLocalCache()
  });
}

const dayRef = (uid, key) => doc(db, "users", uid, "days", key);
const tasksCol = uid => collection(db, "users", uid, "tasks");
const taskRef = (uid, id) => doc(db, "users", uid, "tasks", id);
const prefsRef = uid => doc(db, "users", uid, "settings", "blueprint");

/* ==========================================================================
   Date and text helpers (function declarations are hoisted, so they are safe
   to call from the state block below)
   ========================================================================== */

function pad(n) { return String(n).padStart(2, "0"); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); }
function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 864e5); }
function dayOfYear(k) { const d = parseKey(k); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); }
function longDate(k) {
  return parseKey(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function shortDate(k) {
  return parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Capital first letter of every word; collapses extra spaces.
function capitalizeWords(s) {
  return s.replace(/\s+/g, " ").trim().replace(/(^|\s)(\p{Ll})/gu, (m, sp, c) => sp + c.toUpperCase());
}
// Splits "I'm grateful to ... I'm grateful for ..." into separate entries.
function splitGratitude(text) {
  return text.split(GRATITUDE_SPLIT).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/* ==========================================================================
   State
   ========================================================================== */

let user = null;
let today = dateKey(new Date());
let viewKey = today;
let dayData = {};
let tasks = [];
let dayUnsub = null;
let tasksUnsub = null;
let view = null;                // "dump" | "prioritize" | "buckets"; null until tasks load
let preparing = new Set();      // task ids being coloured in the prioritise step
let prepSession = new Set();    // every task sent to the prioritise step since the buckets were last shown
let dragging = false;
let pendingRender = false;
let taskSpeech = null;
let managerSpeech = null;
let activeMicStop = null;       // stops whichever microphone is currently on
let bucketIndex = 0;            // which priority bucket is shown (0-3)
let showAllBuckets = false;     // true: all four buckets visible at once
let bucketLock = false;         // true: the one-bucket / all-buckets choice is locked (double-click the button)
let prefsUnsub = null;          // listens to the saved bucket view + lock (users/{uid}/settings/blueprint)
let dragEndedAt = 0;            // when the last task drag finished, so the click that follows it is ignored

/* ==========================================================================
   DOM refs
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const els = {
  loading: $("#loading-screen"),
  auth: $("#auth-screen"),
  authError: $("#auth-error"),
  app: $("#app"),
  signin: $("#google-signin"),
  signout: $("#signout"),
  avatar: $("#user-avatar"),
  userInitial: $("#user-initial"),
  userMenuBtn: $("#user-menu-btn"),
  userMenuPop: $("#user-menu-pop"),
  prev: $("#prev-day"),
  next: $("#next-day"),
  jumpToday: $("#jump-today"),
  todayLabel: $("#today-label"),
  dateLong: $("#page-date-long"),
  page: $(".page"),
  noData: $("#no-data"),
  quoteText: $("#quote-text"),
  quoteAuthor: $("#quote-author"),
  saveStatus: $("#save-status"),
  submittedBadge: $("#submitted-badge"),
  entryInput: { gratitude: $("#gratitude-input"), release: $("#release-input") },
  entryList: { gratitude: $("#gratitude-list"), release: $("#release-list") },
  entryEmpty: { gratitude: $("#gratitude-empty"), release: $("#release-empty") },
  entryEdit: { gratitude: $("#gratitude-edit"), release: $("#release-edit") },
  viewDump: $("#view-dump"),
  viewPrioritize: $("#view-prioritize"),
  viewBuckets: $("#view-buckets"),
  taskForm: $("#task-form"),
  taskInput: $("#task-input"),
  dumpList: $("#dump-list"),
  dumpEmpty: $("#dump-empty"),
  dumpCount: $("#dump-count"),
  goPrioritize: $("#go-prioritize"),
  prioritizeList: $("#prioritize-list"),
  backDump: $("#back-dump"),
  showBuckets: $("#show-buckets"),
  addMore: $("#add-more"),
  buckets: $("#buckets"),
  bucketPrev: $("#bucket-prev"),
  bucketNext: $("#bucket-next"),
  bucketCurrent: $("#bucket-current"),
  bucketsEmpty: $("#buckets-empty"),
  completed: $("#completed-today"),
  completedCount: $("#completed-count"),
  completedList: $("#completed-list"),
  ratings: $("#ratings"),
  submitBtn: $("#submit-page"),
  submitNote: $("#submit-note"),
  openManager: $("#open-manager"),
  toggleBuckets: $("#toggle-all-buckets"),
  lockBuckets: $("#lock-buckets"),
  backBuckets: $("#back-buckets"),
  unsortedNote: $("#unsorted-note"),
  blueprintCard: $("#blueprint-card"),
  pastNote: $("#past-note"),
  bucketSummary: $("#bucket-summary"),
  prioQuickSort: $("#prio-quick-sort"),
  managerQuickSort: $("#manager-quick-sort"),
  dayLockNote: $("#day-lock-note"),
  openStars: $("#open-stars"),
  stars: $("#stars"),
  starsDone: $("#stars-done"),
  starsRated: $("#stars-rated"),
  calPrev: $("#cal-prev"),
  calNext: $("#cal-next"),
  calTitle: $("#cal-title"),
  calGrid: $("#cal-grid"),
  calLegend: $("#cal-legend"),
  manager: $("#manager"),
  managerList: $("#manager-list"),
  managerEmpty: $("#manager-empty"),
  managerCount: $("#manager-count"),
  toast: $("#toast")
};

/* ==========================================================================
   UI helpers
   ========================================================================== */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) node.style.setProperty(sk, sv); else node.style[sk] = sv;
      }
    } else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  children.flat().forEach(c => { if (c !== null && c !== undefined) node.append(c); });
  return node;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setStatus(text, kind = "") {
  els.saveStatus.textContent = text;
  els.saveStatus.className = "save-status " + kind;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A task starts on the day it was added for (createdOn), so a task for a future day stays hidden until then.
const startedBy = (t, key) => !t.createdOn || t.createdOn <= key;

function openTasks() {
  return tasks
    .filter(t => t.status !== "done" && startedBy(t, today))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
// Dump = added but not yet prioritised (no colour).
const dumpTasks = () => dayScopeTasks().filter(t => !t.priority);
const sortedTasks = () => openTasks().filter(t => !!t.priority);

// Past and future days show only the tasks added for that specific day, in a bucket, and not yet
// completed. Carried-over tasks never appear on any day except today. A future day with nothing added
// for it has empty buckets.
function tasksAddedOn(key) {
  return tasks
    .filter(t => t.priority && t.status !== "done" && t.createdOn === key)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
const isFutureView = () => viewKey > today;
const isPastView = () => viewKey !== today;   // any day other than today: the board shows that day's own tasks
const isReadOnlyDay = () => viewKey < today;  // earlier days are read only; future days work like today
const boardTasks = () => (isPastView() ? tasksAddedOn(viewKey) : sortedTasks());

// The task list the blueprint works on for the day on screen. Today: every open task that has started.
// A future day: only the open tasks added for that day, so its blueprint starts empty.
const dayScopeTasks = () => (isFutureView()
  ? tasks.filter(t => t.status !== "done" && t.createdOn === viewKey).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  : openTasks());

function nextOrder() {
  const open = openTasks();
  return open.length ? Math.max(...open.map(t => t.order ?? 0)) + 1 : 0;
}

function svgFromString(markup) {
  const wrap = document.createElement("span");
  wrap.innerHTML = markup;
  return wrap.firstElementChild;
}

function checkSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
  svg.append(p);
  return svg;
}

function badgeIcon(r) {
  const holder = document.createElement("span");
  holder.innerHTML = BADGE_SVG[r.shape];
  return holder.firstElementChild;
}

function svgStar() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "star");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", STAR_PATH);
  svg.append(path);
  return svg;
}

/* ==========================================================================
   Auth
   ========================================================================== */

function showScreen(name) {
  els.loading.hidden = name !== "loading";
  els.auth.hidden = name !== "auth";
  els.app.hidden = name !== "app";
}

if (!configured) {
  showScreen("auth");
  els.signin.disabled = true;
  els.authError.hidden = false;
  els.authError.textContent = "Add your Firebase config in js/firebase-config.js to start.";
} else {
  onAuthStateChanged(auth, u => {
    if (u) {
      user = u;
      if (u.photoURL) {
        els.avatar.src = u.photoURL;
        els.avatar.hidden = false;
        els.userInitial.hidden = true;
      } else {
        // No photo: show the first letter of the name instead.
        els.avatar.hidden = true;
        els.userInitial.textContent = (u.displayName || u.email || "?").trim().charAt(0).toUpperCase();
        els.userInitial.hidden = false;
      }
      showScreen("app");
      startListeners();
      renderDate();
      renderQuote();
      // Rebuild the medals now the app is visible. Cards built while the app was hidden can show blank.
      els.ratings.innerHTML = "";
      renderRatings();
    } else {
      user = null;
      stopListeners();
      showScreen("auth");
    }
  });

  els.signin.addEventListener("click", async () => {
    els.authError.hidden = true;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = err?.code || "";
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        // Installed PWAs on phones often can't open popups; use a full-page redirect.
        await signInWithRedirect(auth, provider);
      } else if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        els.authError.hidden = false;
        els.authError.textContent = "Sign-in failed: " + (err.message || code);
      }
    }
  });

  // Profile picture opens a small menu with Sign out.
  const setUserMenu = open => {
    els.userMenuPop.hidden = !open;
    els.userMenuBtn.setAttribute("aria-expanded", String(open));
  };
  els.userMenuBtn.addEventListener("click", e => {
    e.stopPropagation();
    setUserMenu(els.userMenuPop.hidden);
  });
  document.addEventListener("click", e => {
    if (!els.userMenuPop.hidden && !e.target.closest(".user-menu")) setUserMenu(false);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") setUserMenu(false);
  });

  els.signout.addEventListener("click", async () => {
    setUserMenu(false);
    await flushSave();
    await signOut(auth);
  });
}

/* ==========================================================================
   Firestore listeners
   ========================================================================== */

function startListeners() {
  stopListeners();
  subscribeDay();
  tasksUnsub = onSnapshot(tasksCol(user.uid), snap => {
    tasks = snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, ...data, priority: normalizePriority(data.priority) };
    });
    if (view === null) showView(sortedTasks().length ? "buckets" : "dump");
    refreshTasksUI();
  }, err => toast("Could not load tasks: " + err.message, 5000));
  // The one-bucket / all-buckets choice and its lock are saved, so every device shows the same view.
  prefsUnsub = onSnapshot(prefsRef(user.uid), snap => {
    const p = snap.data() || {};
    bucketLock = !!p.locked;
    applyBucketMode(!!p.showAll);
  }, () => {});
}

function stopListeners() {
  if (dayUnsub) dayUnsub();
  if (tasksUnsub) tasksUnsub();
  if (prefsUnsub) prefsUnsub();
  dayUnsub = tasksUnsub = prefsUnsub = null;
  tasks = [];
  dayData = {};
  view = null;
}

function subscribeDay() {
  if (dayUnsub) dayUnsub();
  dayData = {};
  dayUnsub = onSnapshot(dayRef(user.uid, viewKey), snap => {
    dayData = snap.data() || {};
    applyDay();
  }, err => toast("Could not load this page: " + err.message, 5000));
}

function applyDay() {
  syncEntries();
  renderRatings();
  renderSubmitState();
  renderQuote();
  renderCompleted();
}

/* ==========================================================================
   Saving (gratitude & letting-go text, autosave to Firestore)
   ========================================================================== */

// Commits any open entry editor, so nothing is lost when the page changes or closes.
// Each save captures its date synchronously, so this is safe to call just before the date changes.
function flushSave() {
  return Promise.all(Object.keys(ENTRY_KINDS)
    .filter(kind => entryState[kind].editing)
    .map(kind => finishEntryEdit(kind)));
}


// Leaving or hiding the app saves whatever is open: entry editors, and a task whose text is being edited.
// Blurring the box runs its own save.
function saveOpenEdits() {
  const active = document.activeElement;
  if (active?.classList?.contains("task-edit")) active.blur();
  flushSave();
}
window.addEventListener("pagehide", saveOpenEdits);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveOpenEdits();
  if (document.visibilityState === "visible") rolloverIfNewDay();
});

/* ==========================================================================
   Entries: gratitude and letting go
   Speak or type, then press Enter or tap the mic again. The text is tidied
   up and added as an entry. The edit button opens the list for changes
   (edit text, delete lines); tapping it again saves.
   ========================================================================== */

// Common spelling and contraction slips, from speech or typing. Keys are lower case.
const SPOKEN_FIXES = {
  i: "I", im: "I'm", ive: "I've", id: "I'd", hes: "he's", shes: "she's", weve: "we've",
  youre: "you're", theyre: "they're", thats: "that's", whats: "what's", theres: "there's", heres: "here's", lets: "let's",
  dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", wont: "won't", isnt: "isn't", arent: "aren't",
  wasnt: "wasn't", werent: "weren't", havent: "haven't", hasnt: "hasn't", couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't",
  recieve: "receive", teh: "the", becuase: "because", becasue: "because", definately: "definitely", seperate: "separate",
  occured: "occurred", untill: "until", alot: "a lot", freind: "friend", beleive: "believe", wierd: "weird", acheive: "achieve",
  tommorow: "tomorrow", tomorow: "tomorrow", neccessary: "necessary", goverment: "government", familly: "family",
  happyness: "happiness", thier: "their", accomodate: "accommodate", embarass: "embarrass", grattitude: "gratitude",
  gratefull: "grateful", greatful: "grateful", thankyou: "thank you", thanku: "thank you", realy: "really", truely: "truly",
  wich: "which", peice: "piece", enviroment: "environment", finaly: "finally", suprise: "surprise", begining: "beginning",
  occassion: "occasion", recomend: "recommend", existance: "existence", sincerly: "sincerely"
};

// Rule-based tidy-up: removes filler sounds, fixes common slips, repeated words,
// spacing around punctuation, capital letters at sentence starts, and a final full stop.
function tidyText(raw) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/\b(?:um+|uh+|erm+|hmm+)\b[,.]?\s*/gi, "");
  s = s.replace(/[A-Za-z]+/g, w => SPOKEN_FIXES[w.toLowerCase()] ?? w);
  s = s.replace(/\b([A-Za-z]+)(\s+\1\b)+/gi, "$1");
  s = s.replace(/\s+([,.!?;:])/g, "$1").replace(/([,.!?;:])(?=[A-Za-z])/g, "$1 ");
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  s = s.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

// Turns raw entry text into saved entries. Gratitude may hold several "I'm grateful..." sentences.
function cleanEntries(kind, texts) {
  return texts.flatMap(t => {
    const tidy = tidyText(t);
    if (!tidy) return [];
    return kind === "gratitude" ? splitGratitude(tidy) : [tidy];
  });
}

const PENCIL_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>`;

const currentEntries = kind => (entryState[kind].editing ? entryState[kind].draft : entryState[kind].items);

// Takes the saved entries from the day's page, unless an editor is open (its draft is kept).
function syncEntries() {
  for (const kind of Object.keys(ENTRY_KINDS)) {
    const s = entryState[kind];
    if (s.editing) continue;
    const saved = dayData[ENTRY_KINDS[kind].field];
    s.items = Array.isArray(saved) ? saved : ENTRY_KINDS[kind].legacy(dayData);
  }
  renderAllEntries();
}

function renderAllEntries() {
  for (const kind of Object.keys(ENTRY_KINDS)) {
    renderEntries(kind);
    setEntryButton(kind);
  }
}

function renderEntries(kind) {
  const s = entryState[kind];
  const list = els.entryList[kind];
  const items = currentEntries(kind);
  list.innerHTML = "";
  items.forEach((text, i) => {
    if (!s.editing) { list.append(el("li", { text })); return; }
    // A wrapping box that grows to show the whole entry at a glance (Enter adds no new line).
    const input = el("textarea", {
      class: "input entry-input", rows: 2, maxlength: 500, "aria-label": "Entry " + (i + 1),
      oninput: e => { s.draft[i] = e.target.value; fitEntryInput(e.target); },
      onkeydown: e => { if (e.key === "Enter") e.preventDefault(); }
    });
    input.value = text;
    const del = el("button", {
      type: "button", class: "m-del", "aria-label": "Delete entry", title: "Delete",
      onclick: () => { s.draft.splice(i, 1); renderEntries(kind); }
    });
    del.innerHTML = TRASH_SVG;
    list.append(el("li", {}, el("div", { class: "entry-row" }, input, del)));
    fitEntryInput(input);
  });
  els.entryEmpty[kind].hidden = items.length > 0;
}

// Sizes an entry's edit box to its full text, so nothing is hidden behind a scroll.
function fitEntryInput(box) {
  box.style.height = "auto";
  box.style.height = box.scrollHeight + "px";
}

function setEntryButton(kind) {
  const editing = entryState[kind].editing;
  const btn = els.entryEdit[kind];
  btn.classList.toggle("is-editing", editing);
  btn.innerHTML = editing ? CHECK_SVG : PENCIL_SVG;
  btn.setAttribute("aria-label", editing ? "Save entries" : "Edit entries");
  btn.title = editing ? "Save entries" : "Edit entries";
}

async function toggleEntryEdit(kind) {
  if (!entryState[kind].editing && isLockedDay()) return;
  if (!entryState[kind].editing) {
    const s = entryState[kind];
    s.editing = true;
    s.draft = s.items.slice();
    renderEntries(kind);
    setEntryButton(kind);
    return;
  }
  await finishEntryEdit(kind);
}

async function finishEntryEdit(kind) {
  const s = entryState[kind];
  const cleaned = cleanEntries(kind, s.draft);
  s.editing = false;
  s.items = cleaned;
  renderEntries(kind);
  setEntryButton(kind);
  await saveEntries(kind, cleaned);
}

// Adds what is in the input box (typed or spoken) as one or more tidied entries.
async function addEntryFromInput(kind) {
  const input = els.entryInput[kind];
  if (isLockedDay()) { input.value = ""; return; }
  const parts = cleanEntries(kind, [input.value]);
  input.value = "";
  if (!parts.length) return;
  const s = entryState[kind];
  if (s.editing) {
    s.draft.push(...parts);
    renderEntries(kind);
    return;
  }
  s.items = [...s.items, ...parts];
  renderEntries(kind);
  await saveEntries(kind, s.items);
}

async function saveEntries(kind, items) {
  if (!user) return;
  const key = viewKey;   // captured now, before any await
  setStatus("Saving...", "saving");
  try {
    await setDoc(dayRef(user.uid, key), { [ENTRY_KINDS[kind].field]: items, updatedAt: serverTimestamp() }, { merge: true });
    setStatus("All changes saved");
  } catch (err) {
    setStatus("Not saved yet", "error");
    toast("Could not save entries: " + err.message);
  }
}

for (const kind of Object.keys(ENTRY_KINDS)) {
  els.entryInput[kind].addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addEntryFromInput(kind); }
  });
  els.entryEdit[kind].addEventListener("click", () => toggleEntryEdit(kind));
}

/* ==========================================================================
   Date navigation
   ========================================================================== */

// The app was started on this day. Earlier days have no data, so they show "No data available".
const START_KEY = "2026-11-18";

// Only today's page can be written. Earlier days are read only; later days show just the blueprint.
const isLockedDay = () => viewKey !== today;

function renderDate() {
  const isToday = viewKey === today;
  els.dateLong.textContent = longDate(viewKey);
  // Under the date: "Today" on today's page, otherwise the "Back to today" button.
  els.todayLabel.hidden = !isToday;
  els.jumpToday.hidden = isToday;
  const beforeStart = viewKey < START_KEY;
  els.noData.hidden = !beforeStart;
  els.page.classList.toggle("before-start", beforeStart);
  // Gratitude, letting go, the rating and submit are locked on every day except today.
  els.page.classList.toggle("day-locked", isLockedDay());
  els.dayLockNote.hidden = !isLockedDay();
  els.dayLockNote.textContent = viewKey > today
    ? "Locked until this day arrives. Only the blueprint is open for it."
    : "Read only. Past days can be viewed but not changed.";
  // Nothing exists before the app was started, so stop at its first day.
  els.prev.disabled = viewKey <= START_KEY;
  renderSubmitState();   // the note under the page depends on the day shown
}

function goToDay(key) {
  flushSave();
  document.activeElement?.blur?.();
  viewKey = key;
  renderDate();
  renderQuote();
  if (user) subscribeDay();
  renderBlueprint();
}

function rolloverIfNewDay() {
  const now = dateKey(new Date());
  if (now !== today) {
    const wasViewingToday = viewKey === today;
    today = now;
    if (wasViewingToday) viewKey = today;
    renderDate();
    if (wasViewingToday && user) subscribeDay();
    renderBlueprint();
  }
}

els.prev.addEventListener("click", () => { if (viewKey > START_KEY) goToDay(addDays(viewKey, -1)); });
els.next.addEventListener("click", () => goToDay(addDays(viewKey, 1)));
els.jumpToday.addEventListener("click", () => goToDay(today));
setInterval(rolloverIfNewDay, 60_000);

/* ==========================================================================
   Quote of the day (one per day, cycling through 365)
   ========================================================================== */

function renderQuote() {
  const idx = (dayOfYear(viewKey) - 1) % QUOTES.length;
  const q = QUOTES[idx];
  els.quoteText.textContent = "“" + q.text + "”";
  els.quoteAuthor.textContent = "— " + q.author;
}

/* ==========================================================================
   Voice input
   The mic stays on until the user taps it again. The browser may end a
   session on its own after silence, so we restart it while the user still
   wants it on. Returns a controller so the caller can clear the dictation
   buffer after saving (for example, when Enter saves a task).
   ========================================================================== */

function attachSpeech(btn, field, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.title = "Voice input works in Chrome, Edge and Safari";
    return { reset() {}, stop() {} };
  }

  let rec = null;
  let active = false;
  let wantListening = false;
  let base = "";
  let committed = "";
  let lastSet = "";

  const setUI = on => {
    btn.classList.toggle("recording", on);
    btn.setAttribute("aria-pressed", String(on));
  };
  setUI(false);

  function startSession() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    base = field.value;
    if (base && !/\s$/.test(base)) base += " ";
    committed = "";
    lastSet = field.value;

    rec.onresult = e => {
      // If the user typed while listening, treat their text as the new base.
      if (field.value !== lastSet) {
        base = field.value && !/\s$/.test(field.value) ? field.value + " " : field.value;
        committed = "";
      }
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) committed += r[0].transcript.trim() + " ";
        else interim += r[0].transcript;
      }
      lastSet = base + committed + interim;
      field.value = lastSet;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };

    rec.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantListening = false;
        toast("Microphone access is blocked. Allow it in the browser settings.", 4000);
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        toast("Voice input: " + e.error);
      }
    };

    rec.onend = () => {
      active = false;
      if (wantListening) {
        setTimeout(() => { if (wantListening) startSessionSafe(); }, 200);
      } else {
        setUI(false);
        if (onEnd) onEnd();
      }
    };

    rec.start();
    active = true;
  }

  function startSessionSafe() {
    try { startSession(); }
    catch {
      wantListening = false;
      setUI(false);
      toast("Could not start the microphone.");
    }
  }

  const stopMe = () => {
    if (!wantListening) return;
    wantListening = false;
    if (active) rec.stop();
    setUI(false);
  };

  btn.addEventListener("click", () => {
    if (wantListening) { stopMe(); return; }
    // Only one microphone runs at a time: stop whichever one is on.
    if (activeMicStop && activeMicStop !== stopMe) activeMicStop();
    activeMicStop = stopMe;
    // Start writing into this box right away, with the caret at the end.
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    wantListening = true;
    setUI(true);
    startSessionSafe();
  });

  return {
    reset() { base = ""; committed = ""; lastSet = ""; },
    stop: stopMe
  };
}

taskSpeech = attachSpeech($('[data-speech="task"]'), els.taskInput);
// Stopping the mic adds what was said as an entry (tidied up first).
attachSpeech($('[data-speech="gratitude"]'), els.entryInput.gratitude, () => addEntryFromInput("gratitude"));
attachSpeech($('[data-speech="release"]'), els.entryInput.release, () => addEntryFromInput("release"));

/* ==========================================================================
   Rating (medal names, original names underneath)
   ========================================================================== */

// Press feedback for the rating cards. Tracked in script, because phone browsers do not always
// apply the :active style to a touch. The class is removed when the finger lifts or the touch is cancelled.
els.ratings.addEventListener("pointerdown", e => {
  const card = e.target.closest(".rating");
  if (card) card.classList.add("is-pressed");
});
const releasePressed = () => { els.ratings.querySelectorAll(".is-pressed").forEach(c => c.classList.remove("is-pressed")); };
window.addEventListener("pointerup", releasePressed);
window.addEventListener("pointercancel", releasePressed);

function renderRatings() {
  // Build the medal cards once. Later renders only update their state, so the medals
  // are not recreated on every save (which restarted their animations and made the screen blink).
  if (!els.ratings.children.length) {
    for (const r of RATINGS) {
      const toggle = () => setRating(dayData.rating === r.key ? null : r.key);
      els.ratings.append(el("div", {
        class: "rating", "data-key": r.key, style: { "--c": r.color },
        role: "button", tabindex: "0",
        onclick: toggle,
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }
      },
        badgeIcon(r),
        el("span", { class: "r-name", text: r.metal }),
        el("span", { class: "r-sub", text: r.title }),
        el("span", { class: "r-desc", text: r.desc })
      ));
    }
  }
  for (const card of els.ratings.children) {
    const r = RATINGS.find(x => x.key === card.dataset.key);
    const selected = dayData.rating === r.key;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
    card.setAttribute("aria-label", `${r.metal}, ${r.title}. ${selected ? "Selected. Tap to clear." : "Tap to select."}`);
  }
}

// A past day with no star yet: only its star is open, so it can be rated. Once rated, the day locks again.
const starOpen = () => viewKey < today && !dayData.rating;

async function setRating(key) {
  if (!user || (isLockedDay() && !starOpen())) return;
  try {
    await setDoc(dayRef(user.uid, viewKey), { rating: key, updatedAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    toast("Could not save rating: " + err.message);
  }
}

/* ==========================================================================
   Submit / reopen the page
   ========================================================================== */

function renderSubmitState() {
  const submitted = !!dayData.submitted;
  const locked = isLockedDay();
  // Keeps the star open on an unrated past day; re-checked on every save, so it locks again once rated.
  els.page.classList.toggle("star-open", starOpen());
  els.submittedBadge.hidden = !submitted;
  // Only today's page can be submitted or reopened. Earlier days are records; later days are not open yet.
  els.submitBtn.hidden = locked;
  els.submitBtn.textContent = submitted ? "Reopen this page" : "Submit today's page";
  if (viewKey > today) {
    els.submitNote.textContent = "This day has not arrived yet. Tasks you add for it are saved straight away and show on this day.";
  } else if (locked) {
    els.submitNote.textContent = submitted
      ? "This page was submitted. It is a record and cannot be changed."
      : "This page was not submitted. It is a record and cannot be changed.";
  } else {
    els.submitNote.textContent = submitted
      ? "This page is submitted. You can still edit it, and reopen to change its status."
      : "Submit when the day is done. Your page is saved as you type either way.";
  }
}

els.submitBtn.addEventListener("click", async () => {
  if (!user || isLockedDay()) return;
  await flushSave();
  const submitted = !!dayData.submitted;
  try {
    await setDoc(dayRef(user.uid, viewKey), {
      submitted: !submitted,
      submittedAt: submitted ? null : serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    if (!submitted) {
      toast(dayData.rating ? "Page submitted. Rest well." : "Page submitted. Tip: rate the day too.", 3200);
    }
  } catch (err) {
    toast("Could not submit: " + err.message);
  }
});

/* ==========================================================================
   Blueprint views: dump -> prioritise -> buckets
   ========================================================================== */

function showView(name) {
  view = name;
  // Going back to the prioritise step (even after a trip to the dump) shows the tasks from this round too.
  // Showing the buckets (Done) ends the round.
  if (name === "prioritize") dumpTasks().forEach(t => prepSession.add(t.id));
  if (name === "buckets") prepSession = new Set();
  preparing = name === "prioritize" ? new Set(prepSession) : new Set();
  els.viewDump.hidden = name !== "dump";
  els.viewPrioritize.hidden = name !== "prioritize";
  els.viewBuckets.hidden = name !== "buckets";
  renderBlueprint();
}

// When the user moves between steps, bring the blueprint card to the top of the screen. On a phone the
// page can be scrolled down to the rating card, and a step change would otherwise happen off screen.
function goView(name) {
  showView(name);
  const card = els.blueprintCard;
  const bar = document.querySelector(".topbar");
  const offset = (bar ? bar.offsetHeight : 0) + 12;
  window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
}

els.goPrioritize.addEventListener("click", () => goView("prioritize"));
els.backDump.addEventListener("click", () => goView("dump"));
els.showBuckets.addEventListener("click", () => goView("buckets"));
els.addMore.addEventListener("click", () => goView("dump"));
els.backBuckets.addEventListener("click", () => goView("buckets"));
// The "N tasks are not prioritised yet" note opens the prioritise step with those tasks.
els.unsortedNote.addEventListener("click", () => goView("prioritize"));

// "Show all buckets" switches between one bucket at a time and all four at once.
// "Lock buckets" freezes that choice; it is saved, so it holds on every device.
function applyBucketMode(on) {
  showAllBuckets = on;
  els.blueprintCard.classList.toggle("show-all-buckets", on);
  els.toggleBuckets.setAttribute("aria-pressed", String(on));
  renderToggleLabel();
  renderBucketNav();
}

// View button icons: 1C (one bucket with task lines) and 2B (four buckets in a grid).
const BUCKET_SHAPE = '<path d="M4 10h16l-1.8 9.4a1.6 1.6 0 0 1-1.6 1.3H7.4a1.6 1.6 0 0 1-1.6-1.3L4 10z"/><path d="M7.5 10a4.5 4.5 0 0 1 9 0"/>';
const VIEW_ICON_ONE = BUCKET_SHAPE + '<path d="M8.5 13.5h7M8.5 16.5h5"/>';
const VIEW_ICON_ALL = [[0, 0], [12.5, 0], [0, 12.5], [12.5, 12.5]]
  .map(([x, y]) => `<g transform="translate(${x} ${y}) scale(0.4583)">${BUCKET_SHAPE}</g>`).join("");

// Updates both buttons: the view button and the lock button.
function renderToggleLabel() {
  // Each label names the view the button switches to.
  els.toggleBuckets.querySelector(".btn-text").textContent = showAllBuckets ? "One" : "All";
  // Icon 1C (one bucket with task lines) or 2B (four buckets), placed after the text.
  els.toggleBuckets.querySelector(".btn-icon").innerHTML = showAllBuckets ? VIEW_ICON_ONE : VIEW_ICON_ALL;
  els.lockBuckets.querySelector(".btn-text").textContent = bucketLock ? "Unlock" : "Lock";
  els.lockBuckets.querySelector(".btn-icon").innerHTML = bucketLock
    ? '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'
    : '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.8-1.2"/>';
  els.lockBuckets.setAttribute("aria-pressed", String(bucketLock));
  els.lockBuckets.classList.toggle("is-locked", bucketLock);
}

function saveBucketPrefs() {
  if (!user) return;
  setDoc(prefsRef(user.uid), { showAll: showAllBuckets, locked: bucketLock, updatedAt: serverTimestamp() }, { merge: true })
    .catch(err => toast("Could not save the view: " + err.message));
}

els.toggleBuckets.addEventListener("click", () => {
  if (bucketLock) { toast("Buckets are locked. Press Unlock buckets first.", 2400); return; }
  applyBucketMode(!showAllBuckets);
  saveBucketPrefs();
});

els.lockBuckets.addEventListener("click", () => {
  bucketLock = !bucketLock;
  renderToggleLabel();
  saveBucketPrefs();
  toast(bucketLock ? "Buckets locked on all your devices." : "Buckets unlocked.", 2000);
});

function renderBlueprint() {
  // Only earlier days are read only. Future days show the same blueprint as today, for their own tasks.
  const past = isReadOnlyDay();
  // Always shown, so a past day keeps its priority buckets even when no tasks were pending.
  els.blueprintCard.hidden = false;
  els.openManager.hidden = past;
  els.pastNote.hidden = !past;
  els.pastNote.textContent = "Read only. These are the tasks added on this day.";
  els.addMore.hidden = past;
  if (past) {
    els.viewDump.hidden = true;
    els.viewPrioritize.hidden = true;
    els.viewBuckets.hidden = false;
  } else if (view) {
    els.viewDump.hidden = view !== "dump";
    els.viewPrioritize.hidden = view !== "prioritize";
    els.viewBuckets.hidden = view !== "buckets";
    renderDump();
    renderPrioritize();
  }
  renderBoard();
  renderCompleted();
}

// A single tap on a task's text opens it for editing. This is handled on the list itself (which is
// never redrawn), so a redraw that lands between press and release cannot swallow the tap.
// Anywhere on a row (except the delete button and an open editor) starts editing that row's text.
// Mouse and pen open on press, straight away. Touch waits for the finger to lift, so a scroll does not open it.
let dumpPress = null;
function openDumpEdit(li) {
  const t = tasks.find(x => x.id === li?.dataset.id);
  const span = li?.querySelector(".dump-text");
  if (t && span) editTaskText(span, t);
}
els.dumpList.addEventListener("pointerdown", e => {
  dumpPress = null;
  if (e.button > 0 || e.target.closest(".m-del, input")) return;
  const li = e.target.closest(".dump-item");
  if (!li) return;
  if (e.pointerType === "touch") {
    dumpPress = { id: e.pointerId, x: e.clientX, y: e.clientY, li };
  } else {
    e.preventDefault();   // keep focus from bouncing off the new box straight away
    openDumpEdit(li);
  }
});
els.dumpList.addEventListener("pointerup", e => {
  const press = dumpPress;
  dumpPress = null;
  if (!press || e.pointerId !== press.id || e.button > 0) return;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) return;   // a scroll or a drag, not a tap
  if (e.target.closest(".m-del, input")) return;
  openDumpEdit(press.li);
});

function renderDump() {
  const dump = dumpTasks();
  els.dumpList.innerHTML = "";
  for (const t of dump) {
    const del = el("button", {
      type: "button", class: "m-del", "aria-label": "Delete task", title: "Delete",
      onclick: () => deleteTask(t)
    });
    del.innerHTML = TRASH_SVG;
    const text = el("span", { class: "dump-text", text: t.text, title: "Tap to edit" });
    els.dumpList.append(el("li", { class: "dump-item", "data-id": t.id }, text, del));
  }
  els.dumpEmpty.hidden = dump.length > 0;
  els.dumpCount.textContent = dump.length ? `${dump.length} to prioritise` : "";
  // Always available, so the prioritise step can be reopened even when the dump is empty.
  els.goPrioritize.disabled = false;
}

// Tasks shown on the prioritise step: the ones in this step, plus any task added since it opened
// (such as from the manager) that has no colour yet.
const prioritizeTargets = () => dayScopeTasks().filter(t => preparing.has(t.id) || !t.priority);

function renderPrioritize() {
  if (view !== "prioritize" || isEditingTaskText()) return;
  const list = prioritizeTargets();
  els.prioritizeList.innerHTML = "";
  list.forEach(t => els.prioritizeList.append(managerItem(t)));
  setQuickSortEnabled(els.prioQuickSort, list.length);
}

function renderBoard() {
  renderBucketNav();
  const sorted = boardTasks();
  const readOnly = isReadOnlyDay();
  els.buckets.innerHTML = "";
  els.buckets.classList.toggle("is-readonly", readOnly);
  els.bucketsEmpty.hidden = sorted.length > 0 || readOnly;

  // Quiet reminder: tasks still waiting to be put in a priority bucket.
  const unsorted = dumpTasks().length;
  els.unsortedNote.hidden = isReadOnlyDay() || unsorted === 0;
  els.unsortedNote.textContent = `${unsorted} Task${unsorted === 1 ? " Is" : "s Are"} Not Prioritised Yet`;

  for (const p of PRIORITIES) {
    const items = sorted.filter(t => t.priority === p.key);
    const hidden = PRIORITIES.indexOf(p) !== bucketIndex;
    els.buckets.append(el("section", { class: "bucket bucket-" + p.key + (hidden ? " is-hidden" : ""), style: { "--c": p.color }, "aria-label": p.label },
      el("div", { class: "bucket-head" },
        el("span", { class: "bucket-title", text: p.label }),
        el("span", { class: "bucket-count", text: String(items.length) })
      ),
      el("p", { class: "bucket-hint", text: p.hint }),
      el("ul", { class: "bucket-list", "data-priority": p.key },
        items.length ? items.map(t => taskItem(t, readOnly)) : [el("li", { class: "bucket-empty", text: "Nothing here" })]
      )
    ));
  }
  renderBucketSummary(sorted);
}

// One line above "Completed": how many tasks sit in each bucket on the day shown.
function renderBucketSummary(sorted) {
  els.bucketSummary.innerHTML = "";
  for (const p of PRIORITIES) {
    const n = sorted.filter(t => t.priority === p.key).length;
    els.bucketSummary.append(el("span", { class: "bs-item" + (n ? " has-tasks" : ""), style: { "--c": p.color }, title: p.label },
      el("i", { class: "bs-dot", "aria-hidden": "true" }),
      el("span", { class: "bs-name", text: SHORT_LABEL[p.key] }),
      el("b", { class: "bs-count", text: String(n) })
    ));
  }
}

function taskItem(t, readOnly = false) {
  const color = (PRIORITY_BY_KEY[t.priority] || UNSORTED).color;
  // A task for a future day cannot be ticked off before that day arrives. Everything else is the same as today.
  const check = (readOnly || isFutureView()) ? null : el("button", {
    type: "button", class: "check", "aria-label": "Mark as done", title: "Done",
    onclick: e => completeTask(t.id, e.currentTarget.closest("li"))
  }, checkSvg());
  const label = carriedLabel(t, viewKey);
  // Tapping the task (not the tick) edits its text in place. Not on a past day, which is read only.
  const onTap = readOnly ? null : e => {
    if (e.target.closest(".check, input") || Date.now() - dragEndedAt < 400) return;
    const holder = e.currentTarget.querySelector(".task-text");
    if (holder) editTaskText(holder, t);
  };
  return el("li", { class: "task", "data-id": t.id, style: { "--c": color }, onclick: onTap },
    check,
    el("div", { class: "task-text" },
      t.text,
      el("span", { class: "task-meta" }, el("span", { class: t.createdOn < viewKey ? "carry" : "", text: label }))
    )
  );
}

// Edits a task's text where it is shown. Enter or leaving the box saves; Escape cancels.
function editTaskText(holder, t) {
  if (!user || isReadOnlyDay() || !holder.isConnected) return;
  const input = el("input", { type: "text", class: "m-text task-edit", value: t.text, maxlength: 300, "aria-label": "Task text" });
  let cancelled = false, finished = false;
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { cancelled = true; input.blur(); }
  });
  input.addEventListener("blur", () => {
    if (finished) return;
    finished = true;
    const v = capitalizeWords(input.value);
    if (!cancelled && v && v !== t.text) {
      t.text = v;   // optimistic, so the new text shows at once
      updateDoc(taskRef(user.uid, t.id), { text: v }).catch(() => toast("Could not save text"));
    }
    // Put the same element back with the saved text. The list is not redrawn here, so a tap on
    // another task at this moment still lands on the first try (a redraw would swallow it).
    holder.firstChild.nodeValue = t.text;
    input.replaceWith(holder);
  });
  holder.replaceWith(input);
  // Focus straight away with the cursor at the end of the text, so typing continues from there.
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

// Carried tasks say how long ago they were added, relative to the page being shown.
// Tasks added on that same day show no label.
function carriedLabel(t, refKey = today) {
  const days = t.createdOn ? daysBetween(t.createdOn, refKey) : 0;
  const plural = n => (n === 1 ? "" : "s");
  if (days <= 0) return "";
  if (days === 1) return "From yesterday";
  if (days === 2) return "From the day before yesterday";
  if (days < 7) return `From ${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return `From ${w} week${plural(w)} ago`; }
  if (days < 365) { const m = Math.floor(days / 30); return `From ${m} month${plural(m)} ago`; }
  const y = Math.floor(days / 365);
  return `From ${y} year${plural(y)} ago`;
}

async function completeTask(id, li) {
  if (!user || viewKey !== today) return;   // ticking off is only for today's tasks
  li?.classList.add("leaving");
  await sleep(230);
  try {
    await updateDoc(taskRef(user.uid, id), { status: "done", doneOn: today, completedAt: serverTimestamp() });
    toast("Task completed. Nice.", 1800);
  } catch (err) {
    li?.classList.remove("leaving");
    toast("Could not complete task: " + err.message);
  }
}

function renderCompleted() {
  // Newest first: the task completed most recently sits at the top.
  // A task just completed has no server time yet, so it counts as now.
  const doneAt = t => t.completedAt?.toMillis?.() ?? Date.now();
  const done = tasks
    .filter(t => t.status === "done" && t.doneOn === viewKey)
    .sort((a, b) => doneAt(b) - doneAt(a));
  els.completed.hidden = done.length === 0;
  els.completedCount.textContent = String(done.length);
  els.completedList.innerHTML = "";
  for (const t of done) {
    // An earlier day is a record: its completed tasks cannot be restored from it.
    els.completedList.append(el("li", {},
      el("span", { text: t.text }),
      isReadOnlyDay() ? null : el("button", { type: "button", class: "link-btn", onclick: () => restoreTask(t.id) }, "Restore")
    ));
  }
}

async function restoreTask(id) {
  if (!user) return;
  try {
    await updateDoc(taskRef(user.uid, id), { status: "open", doneOn: null, order: nextOrder() });
  } catch (err) { toast("Could not restore: " + err.message); }
}

/* ==========================================================================
   Adding, editing and deleting tasks
   ========================================================================== */

async function addTask(text) {
  if (!user || !text.trim() || isReadOnlyDay()) return;
  try {
    await addDoc(tasksCol(user.uid), {
      text: capitalizeWords(text).slice(0, 300),
      priority: null,            // starts in the dump, colour comes later
      order: nextOrder(),
      status: "open",
      createdOn: viewKey,        // the day on screen: today, or a future day
      doneOn: null,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    toast("Could not add task: " + err.message);
    throw err;
  }
}

// Enter saves the task. The mic keeps listening for the next one.
els.taskForm.addEventListener("submit", async e => {
  e.preventDefault();
  const text = els.taskInput.value.trim();
  if (!text) return;
  els.taskInput.value = "";
  taskSpeech.reset();
  els.taskInput.focus();
  try { await addTask(text); }
  catch { els.taskInput.value = text; }
});

async function setTaskPriority(id, key) {
  if (!user) return;
  const t = tasks.find(x => x.id === id);
  if (t) t.priority = key;   // optimistic
  refreshTasksUI();
  try { await updateDoc(taskRef(user.uid, id), { priority: key }); }
  catch (err) { toast("Could not set priority: " + err.message); }
}

async function deleteTask(t) {
  if (!user) return;
  try { await deleteDoc(taskRef(user.uid, t.id)); toast("Task deleted", 1800); }
  catch (err) { toast("Could not delete: " + err.message); }
}

/* Shared task row: check, text, colours, delete. Used by prioritise and manager. */
function renderMiniColors(container, task) {
  container.innerHTML = "";
  for (const p of PRIORITIES) {
    const selected = (task.priority ?? null) === p.key;
    container.append(el("button", {
      type: "button", class: "m-color",
      role: "radio", "aria-checked": String(selected),
      "aria-label": p.label, title: `${p.label}: ${p.hint}`,
      style: { "--c": p.color },
      onclick: () => setTaskPriority(task.id, p.key)
    }));
  }
}

function managerItem(t) {
  const item = el("div", { class: "m-item", "data-id": t.id });

  const check = el("button", {
    type: "button", class: "check", "aria-label": "Mark as done", title: "Done",
    style: { "--c": (PRIORITY_BY_KEY[t.priority] || UNSORTED).color },
    onclick: () => completeTask(t.id, null)
  }, checkSvg());

  const text = el("input", { type: "text", class: "m-text", value: t.text, maxlength: 300, "aria-label": "Task text" });
  text.addEventListener("keydown", e => { if (e.key === "Enter") text.blur(); });
  text.addEventListener("change", () => {
    const v = capitalizeWords(text.value);
    if (!v) { text.value = t.text; return; }
    updateDoc(taskRef(user.uid, t.id), { text: v }).catch(() => toast("Could not save text"));
  });

  const colors = el("div", { class: "m-colors", role: "radiogroup", "aria-label": "Priority" });
  renderMiniColors(colors, t);

  const del = el("button", {
    type: "button", class: "m-del", "aria-label": "Delete task", title: "Delete",
    onclick: () => deleteTask(t)
  });
  del.innerHTML = TRASH_SVG;

  item.append(check, el("div", { class: "m-item-main" }, text, colors), del);
  return item;
}

/* Re-render after data changes, but never while the user is typing in a task. */
function refreshTasksUI() {
  if (isEditingTaskText() || dragging) { pendingRender = true; return; }
  pendingRender = false;
  renderBlueprint();
  if (!els.manager.hidden) renderManager();
}

function isEditingTaskText() {
  const a = document.activeElement;
  return !!a && a.classList.contains("m-text");
}

document.addEventListener("focusout", () => {
  setTimeout(() => { if (pendingRender && !dragging) refreshTasksUI(); }, 0);
});

function renderManager() {
  const open = dayScopeTasks();
  els.managerList.innerHTML = "";
  open.forEach(t => els.managerList.append(managerItem(t)));
  els.managerEmpty.hidden = open.length > 0;
  els.managerCount.textContent = `${open.length} open task${open.length === 1 ? "" : "s"}`;
  setQuickSortEnabled(els.managerQuickSort, open.length);
}

/* "All High / All Medium / All Low / All Whenever" buttons: put every task in the list into one priority.
   Prioritise step: the tasks shown there. Manage all tasks: only the tasks that still have no priority,
   so tasks already sorted are never changed by accident. */
// Even shorter names for the one-row buttons on phones.
const PHONE_SHORT = { urgent: "High", normal: "Mid", okay: "Low", whenever: "Whenever" };
function buildQuickSort(container, label, targets) {
  container.append(el("span", { class: "qs-label", text: label }));
  for (const p of PRIORITIES) {
    container.append(el("button", {
      type: "button", class: "btn btn-ghost btn-sm qs-btn", style: { "--c": p.color },
      title: `${p.label}: ${p.hint}`, "aria-label": `All tasks to ${p.label}`,
      onclick: () => setPriorityForAll(targets(), p.key)
    }, el("i", { class: "qs-dot", "aria-hidden": "true" }), el("span", { class: "qs-all", text: "All " }),
       el("span", { class: "qs-full", text: SHORT_LABEL[p.key] }), el("span", { class: "qs-short", text: PHONE_SHORT[p.key] })));
  }
}

function setQuickSortEnabled(container, count) {
  container.querySelectorAll("button").forEach(b => { b.disabled = count === 0; });
}

async function setPriorityForAll(list, key) {
  if (!user || !list.length) return;
  for (const t of list) t.priority = key;   // optimistic
  refreshTasksUI();
  const batch = writeBatch(db);
  list.forEach(t => batch.update(taskRef(user.uid, t.id), { priority: key }));
  try {
    await batch.commit();
    toast(`${list.length} task${list.length === 1 ? "" : "s"} set to ${PRIORITY_BY_KEY[key].label}`, 2200);
  } catch (err) {
    toast("Could not set priority: " + err.message);
  }
}

/* Drag a task by its row (no handle): mouse press and move, or on touch press and hold.
   Text fields, the tick and the colour dots keep their normal behaviour. */
function enableDragReorder(container, onDrop) {
  const HOLD_MS = 220;

  container.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    const item = e.target.closest(".m-item");
    if (!item || !container.contains(item)) return;
    if (e.target.closest("button, input, .m-colors")) return;

    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;
    const touch = e.pointerType === "touch";
    let timer = null;
    let drag = null;

    const stopListening = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    const start = () => {
      clearTimeout(timer);
      if (!drag) drag = beginRowDrag(container, item, sx, sy, onDrop);
    };
    const onMove = ev => {
      if (ev.pointerId !== pid) return;
      if (drag) { drag.move(ev); return; }
      const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (touch) { if (d > 8) stopListening(); }   // finger moved before the hold: a scroll
      else if (d > 4) start();
    };
    const onUp = ev => {
      if (ev.pointerId !== pid) return;
      stopListening();
      if (drag) { drag.end(); drag = null; }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    if (touch) timer = setTimeout(start, HOLD_MS);
  });
}

function beginRowDrag(container, item, sx, sy, onDrop) {
  const rect = item.getBoundingClientRect();
  const offsetX = sx - rect.left;
  const offsetY = sy - rect.top;
  const placeholder = el("div", { class: "drag-placeholder" });
  placeholder.style.height = rect.height + "px";
  item.after(placeholder);

  Object.assign(item.style, {
    position: "fixed", top: rect.top + "px", left: rect.left + "px",
    width: rect.width + "px", zIndex: "200"
  });
  item.classList.add("dragging");
  dragging = true;
  document.body.style.userSelect = "none";

  const preventScroll = ev => { if (ev.cancelable) ev.preventDefault(); };
  const preventMenu = ev => ev.preventDefault();
  document.addEventListener("touchmove", preventScroll, { passive: false });
  window.addEventListener("contextmenu", preventMenu);

  return {
    move(ev) {
      item.style.left = (ev.clientX - offsetX) + "px";
      item.style.top = (ev.clientY - offsetY) + "px";
      const siblings = [...container.querySelectorAll(".m-item:not(.dragging)")];
      const target = siblings.find(s => {
        const r = s.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      if (target) {
        if (placeholder.nextElementSibling !== target) container.insertBefore(placeholder, target);
      } else if (container.lastElementChild !== placeholder) {
        container.appendChild(placeholder);
      }
    },
    end() {
      document.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("contextmenu", preventMenu);
      placeholder.replaceWith(item);
      item.classList.remove("dragging");
      item.removeAttribute("style");
      document.body.style.userSelect = "";
      dragging = false;
      onDrop([...container.querySelectorAll(".m-item")].map(n => n.dataset.id));
    }
  };
}

// Reorders a list of tasks by reusing the slots they already occupy, so the
// global order of other tasks is not disturbed.
async function reorderTasks(ids) {
  if (!user) return;
  const moved = ids.map(id => tasks.find(t => t.id === id)).filter(Boolean);
  const slots = moved.map(t => t.order ?? 0).sort((a, b) => a - b);
  const updates = [];
  moved.forEach((t, i) => {
    if (t.order !== slots[i]) { t.order = slots[i]; updates.push([t.id, slots[i]]); }
  });
  refreshTasksUI();
  if (!updates.length) return;
  const batch = writeBatch(db);
  updates.forEach(([id, order]) => batch.update(taskRef(user.uid, id), { order }));
  try { await batch.commit(); }
  catch (err) { toast("Could not save new order: " + err.message); }
}

enableDragReorder(els.managerList, reorderTasks);
enableDragReorder(els.prioritizeList, reorderTasks);

/* Drag tasks freely by the row itself (no handle):
   mouse: press and move. Touch: press and hold, then drag; a normal swipe still scrolls. */
function enableBucketDrag() {
  const board = els.buckets;
  const HOLD_MS = 220;

  board.addEventListener("pointerdown", e => {
    if (e.button > 0 || isReadOnlyDay()) return;
    const item = e.target.closest("li.task");
    if (!item || e.target.closest(".check, input")) return;

    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;
    const touch = e.pointerType === "touch";
    let timer = null;
    let drag = null;

    const stopListening = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    const start = () => {
      clearTimeout(timer);
      if (!drag) drag = beginBucketDrag(item, sx, sy);
    };
    const onMove = ev => {
      if (ev.pointerId !== pid) return;
      if (drag) { drag.move(ev); return; }
      const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (touch) { if (d > 8) stopListening(); }   // finger moved before the hold: a scroll
      else if (d > 4) start();
    };
    const onUp = ev => {
      if (ev.pointerId !== pid) return;
      stopListening();
      if (drag) { drag.end(); drag = null; }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    if (touch) timer = setTimeout(start, HOLD_MS);
  });
}

function beginBucketDrag(item, sx, sy) {
  const rect = item.getBoundingClientRect();
  const offsetX = sx - rect.left;
  const offsetY = sy - rect.top;
  const originalStyle = item.getAttribute("style");
  const placeholder = el("li", { class: "drag-placeholder" });
  placeholder.style.height = rect.height + "px";
  let currentList = item.parentElement;
  item.after(placeholder);

  Object.assign(item.style, {
    position: "fixed", top: rect.top + "px", left: rect.left + "px",
    width: rect.width + "px", zIndex: "200"
  });
  item.classList.add("dragging");
  dragging = true;
  document.body.style.userSelect = "none";

  els.buckets.classList.add("dragging-all");   // show every bucket while dragging

  // Stop the page scrolling and the long-press menu while a task is being dragged.
  const preventScroll = ev => { if (ev.cancelable) ev.preventDefault(); };
  const preventMenu = ev => ev.preventDefault();
  document.addEventListener("touchmove", preventScroll, { passive: false });
  window.addEventListener("contextmenu", preventMenu);

  // The bucket column under the pointer (or the nearest one).
  const listAt = x => {
    let best = null, bestDist = Infinity;
    for (const list of els.buckets.querySelectorAll(".bucket-list")) {
      const r = list.closest(".bucket").getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < bestDist) { bestDist = d; best = list; }
      if (d === 0) break;
    }
    return best;
  };

  return {
    move(ev) {
      item.style.left = (ev.clientX - offsetX) + "px";
      item.style.top = (ev.clientY - offsetY) + "px";
      const list = listAt(ev.clientX);
      if (!list) return;
      if (list !== currentList) {
        list.querySelectorAll(".bucket-empty").forEach(n => n.remove());
        currentList = list;
      }
      const siblings = [...list.querySelectorAll("li.task:not(.dragging)")];
      const target = siblings.find(s => {
        const r = s.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      if (target) {
        if (placeholder.nextElementSibling !== target) list.insertBefore(placeholder, target);
      } else if (list.lastElementChild !== placeholder) {
        list.appendChild(placeholder);
      }
    },
    end() {
      document.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("contextmenu", preventMenu);
      placeholder.replaceWith(item);
      item.classList.remove("dragging");
      if (originalStyle === null) item.removeAttribute("style");
      else item.setAttribute("style", originalStyle);
      document.body.style.userSelect = "";
      dragging = false;
      els.buckets.classList.remove("dragging-all");
      dragEndedAt = Date.now();
      saveBucketOrder();
    }
  };
}

/* One priority bucket at a time: arrows (laptop) and sideways swipes (phone). */
function renderBucketNav() {
  const p = PRIORITIES[bucketIndex];
  els.bucketCurrent.textContent = "";
  els.bucketCurrent.style.setProperty("--c", p.color);
  els.bucketCurrent.append(p.label, el("small", { text: `${bucketIndex + 1} of ${PRIORITIES.length}` }));
  els.bucketPrev.disabled = bucketIndex === 0;
  els.bucketNext.disabled = bucketIndex === PRIORITIES.length - 1;
}

function shiftBucket(step) {
  if (showAllBuckets) return;   // all buckets are visible, so there is nothing to move between
  const next = Math.min(PRIORITIES.length - 1, Math.max(0, bucketIndex + step));
  if (next === bucketIndex) return;
  bucketIndex = next;
  showBucketPanel();
}

// Swiping only changes which bucket is visible. The tasks are not rebuilt.
function showBucketPanel() {
  renderBucketNav();
  els.buckets.querySelectorAll(":scope > .bucket").forEach((b, i) => b.classList.toggle("is-hidden", i !== bucketIndex));
}

els.bucketPrev.addEventListener("click", () => shiftBucket(-1));
els.bucketNext.addEventListener("click", () => shiftBucket(1));

// Sideways swipe on a phone or tablet. Vertical swipes still scroll the page.
function enableBucketSwipe() {
  let pid = null, sx = 0, sy = 0;
  els.buckets.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY;
  });
  window.addEventListener("pointerup", e => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    if (dragging) return;   // a task drag, not a swipe
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftBucket(dx < 0 ? 1 : -1);
  });
}

// Writes the new order and priorities from what is now on the board.
async function saveBucketOrder() {
  if (!user) return;
  const updates = [];
  let index = 0;
  for (const list of els.buckets.querySelectorAll(".bucket-list")) {
    const priority = list.dataset.priority;
    for (const li of list.querySelectorAll("li.task")) {
      const t = tasks.find(x => x.id === li.dataset.id);
      if (!t) continue;
      const change = {};
      if (t.order !== index) change.order = index;
      if ((t.priority ?? null) !== priority) change.priority = priority;
      t.order = index;
      t.priority = priority;
      if (Object.keys(change).length) updates.push([t.id, change]);
      index++;
    }
  }
  refreshTasksUI();
  if (!updates.length) return;
  const batch = writeBatch(db);
  updates.forEach(([id, change]) => batch.update(taskRef(user.uid, id), change));
  try { await batch.commit(); }
  catch (err) { toast("Could not save the new order: " + err.message); }
}

enableBucketDrag();
enableBucketSwipe();

/* Manager add row: text or voice, Enter saves, mic stays on until closed. */
function buildManagerAddRow() {
  const input = el("input", { type: "text", class: "input", placeholder: "Add a task, by text or voice...", maxlength: 300, "aria-label": "New task" });
  const mic = el("button", { type: "button", class: "mic-btn", "aria-label": "Voice input for a new task", title: "Speak tasks" });
  mic.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  const addBtn = el("button", { type: "button", class: "btn btn-primary", disabled: true }, "Add");

  const refresh = () => { addBtn.disabled = !input.value.trim(); };
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    managerSpeech?.reset();
    refresh();
    input.focus();
    try { await addTask(text); } catch { input.value = text; refresh(); }
  };

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  addBtn.addEventListener("click", submit);
  managerSpeech = attachSpeech(mic, input);
  return el("div", { class: "m-add-wrap" }, el("div", { class: "m-add" }, input, mic, addBtn));
}

function openManager() {
  els.manager.hidden = false;
  document.body.style.overflow = "hidden";
  renderManager();
  $(".m-add-wrap", els.manager)?.remove();
  els.manager.querySelector(".modal-foot").before(buildManagerAddRow());
  setTimeout(() => $(".m-add input", els.manager)?.focus(), 50);
}

function closeManager() {
  managerSpeech?.stop();
  els.manager.hidden = true;
  document.body.style.overflow = "";
}

els.openManager.addEventListener("click", openManager);
els.manager.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeManager));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !els.manager.hidden) closeManager(); });

/* ==========================================================================
   My stars: the medal for every rated day, and how many tasks are done
   ========================================================================== */

// Rated days as "yyyy-mm-dd" -> rating key, and the month the calendar is showing ({y, m}, m from 0).
let starRatings = new Map();
let starsMonth = null;

function openStars() {
  if (!user) return;
  els.userMenuPop.hidden = true;
  els.userMenuBtn.setAttribute("aria-expanded", "false");
  els.stars.hidden = false;
  document.body.style.overflow = "hidden";
  // Completed tasks are counted from the task list, which already holds every task since the start.
  els.starsDone.textContent = String(tasks.filter(t => t.status === "done").length);
  els.starsRated.textContent = "…";
  const now = parseKey(today);
  starsMonth = { y: now.getFullYear(), m: now.getMonth() };
  renderStarCalendar();
  loadStars();
}

async function loadStars() {
  try {
    const snap = await getDocs(collection(db, "users", user.uid, "days"));
    starRatings = new Map(snap.docs
      .map(d => [d.id, d.data().rating])
      .filter(([key, rating]) => key >= START_KEY && key <= today && RATINGS.some(r => r.key === rating)));
    els.starsRated.textContent = String(starRatings.size);
    renderStarCalendar();
  } catch (err) {
    els.starsRated.textContent = "0";
    toast("Could not load your stars: " + err.message, 4000);
  }
}

// Names shown for each medal on the calendar and its legend.
const STAR_NAME = { gold: "Diamond", best: "Gold", average: "Silver", wasted: "Rusty Iron" };

// One month as a calendar: each day shows its medal, if a rating was given on it.
function renderStarCalendar() {
  if (!starsMonth) return;
  const { y, m } = starsMonth;
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startMonth = START_KEY.slice(0, 7), todayMonth = today.slice(0, 7);
  const thisMonth = `${y}-${pad(m + 1)}`;

  els.calTitle.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  els.calPrev.disabled = thisMonth <= startMonth;
  els.calNext.disabled = thisMonth >= todayMonth;

  els.calGrid.innerHTML = "";
  // Weeks start on Monday.
  for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    els.calGrid.append(el("div", { class: "cal-wd", "aria-hidden": "true", text: name }));
  }
  const offset = (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) els.calGrid.append(el("div", { class: "cal-cell is-blank", "aria-hidden": "true" }));
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${thisMonth}-${pad(d)}`;
    const inRange = key >= START_KEY && key <= today;
    const r = RATINGS.find(item => item.key === starRatings.get(key));
    const cell = el("div", {
      class: "cal-cell" + (inRange ? "" : " is-off") + (key === today ? " is-today" : ""),
      title: r ? `${longDate(key)}: ${STAR_NAME[r.key]}` : longDate(key)
    }, el("span", { class: "cal-day", text: String(d) }));
    if (r) {
      const icon = badgeIcon(r);
      icon.classList.add("cal-badge");
      cell.append(icon);
    }
    els.calGrid.append(cell);
  }

  els.calLegend.innerHTML = "";
  for (const r of RATINGS) {
    const icon = badgeIcon(r);
    icon.classList.add("cal-badge");
    els.calLegend.append(el("li", {}, icon, el("span", { text: STAR_NAME[r.key] })));
  }
}

els.calPrev.addEventListener("click", () => {
  starsMonth = starsMonth.m === 0 ? { y: starsMonth.y - 1, m: 11 } : { y: starsMonth.y, m: starsMonth.m - 1 };
  renderStarCalendar();
});
els.calNext.addEventListener("click", () => {
  starsMonth = starsMonth.m === 11 ? { y: starsMonth.y + 1, m: 0 } : { y: starsMonth.y, m: starsMonth.m + 1 };
  renderStarCalendar();
});

function closeStars() {
  els.stars.hidden = true;
  document.body.style.overflow = "";
}

// Clears every completed task, on every day, so the count starts again at 0. Only tasks are removed:
// diary entries, ratings and submitted pages are kept.
async function clearCompletedTasks() {
  if (!user) return;
  const done = tasks.filter(t => t.status === "done");
  if (!done.length) { toast("No completed tasks to clear.", 2200); return; }
  try {
    // Firestore batches hold at most 500 writes, so delete in chunks.
    for (let i = 0; i < done.length; i += 450) {
      const batch = writeBatch(db);
      done.slice(i, i + 450).forEach(t => batch.delete(taskRef(user.uid, t.id)));
      await batch.commit();
    }
    els.starsDone.textContent = "0";
    toast(`Cleared ${done.length} completed task${done.length === 1 ? "" : "s"}.`, 2600);
  } catch (err) {
    toast("Could not clear completed tasks: " + err.message, 4000);
  }
}

els.openStars.addEventListener("click", openStars);
$("#clear-completed").addEventListener("click", clearCompletedTasks);
els.stars.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeStars));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !els.stars.hidden) closeStars(); });

/* ==========================================================================
   Boot (runs after every function and constant above is defined)
   ========================================================================== */

/* Phones: hide the top bar while scrolling down, show it again on the way up or at the top. */
(() => {
  const topbar = document.querySelector(".topbar");
  let lastY = window.scrollY;
  let ticking = false;

  const update = () => {
    ticking = false;
    const y = Math.max(0, window.scrollY);
    const delta = y - lastY;
    if (y <= 40) topbar.classList.remove("is-hidden");
    else if (delta > 6) topbar.classList.add("is-hidden");
    else if (delta < -6) topbar.classList.remove("is-hidden");
    if (Math.abs(delta) > 6) lastY = y;
  };

  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
})();

/* Bioluminescent abyss: small rising spores drifting behind the page. */
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const abyss = document.querySelector(".abyss");
  const palette = ["0,245,212", "241,91,181", "0,187,249"];

  if (abyss && !reduceMotion.matches) {
    for (let i = 0; i < 70; i++) {
      const spore = document.createElement("span");
      spore.className = "abyss-spore";
      spore.style.cssText =
        `--x:${(Math.random() * 100).toFixed(1)}%;` +
        `--s:${(4 + Math.random() * 8).toFixed(1)}px;` +
        `--c:${palette[i % palette.length]};` +
        `--dur:${(12 + Math.random() * 14).toFixed(1)}s;` +
        `--delay:${(-Math.random() * 26).toFixed(1)}s;` +
        `--drift:${((Math.random() * 2 - 1) * 80).toFixed(0)}px;` +
        `--o:${(0.7 + Math.random() * 0.3).toFixed(2)}`;
      abyss.appendChild(spore);
    }
  }

})();

buildQuickSort(els.prioQuickSort, "Put all of these in:", prioritizeTargets);
buildQuickSort(els.managerQuickSort, "All open tasks:", dayScopeTasks);

renderDate();
renderQuote();
renderRatings();
renderSubmitState();
renderAllEntries();
renderBlueprint();
renderToggleLabel();
