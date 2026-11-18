// Gym Pass keeps everything on the phone. It gets there in one of two ways:
// - a link from reception (usually a QR code shown in GymDesk): <this app>/#import=<data>
// - logging in with card number + last name: GymDesk uploads an encrypted pass per member to
//   passes/ on this site, and the phone downloads and unlocks only its own (see "login" below).
// The data holds the gym name, the member's name, card number and expiry date, and optionally their
// training program. The app never talks to the gym's PC and works offline once the pass is saved.
const PASS_KEY = "gympass:pass";
const PROGRAM_KEY = "gympass:program";
const CODE_KEY = "gympass:code";
const LOGIN_KEY = "gympass:login";

const $ = sel => document.querySelector(sel);
const DAY_MS = 86400000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
const fmt = d => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------- import ----------
async function decodeImport(b64) {
  const compressed = b64[0] === "z";
  const s = (compressed ? b64.slice(1) : b64).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  let bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  if (compressed) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return checkPayload(JSON.parse(new TextDecoder().decode(bytes)));
}
function checkPayload(raw) {
  // older links carried only a program
  const payload = Array.isArray(raw.days) ? { program: raw } : raw;
  const out = {};
  const m = payload.member;
  if (m) {
    if (typeof m.name !== "string" || typeof m.code !== "string" || !m.code || !(m.expiresOn === null || isDate(m.expiresOn)))
      throw new Error("bad member");
    out.pass = { name: m.name, code: m.code, expiresOn: m.expiresOn,
      gym: payload.gym && typeof payload.gym.name === "string" ? { name: payload.gym.name, club: payload.gym.club || "" } : null,
      issued: isDate(payload.issued) ? payload.issued : null };
  }
  if (payload.program) {
    const p = payload.program;
    const ok = typeof p.name === "string" && Array.isArray(p.days) && p.days.length &&
      p.days.every(d => typeof d.day === "string" && typeof d.title === "string" &&
        Array.isArray(d.exercises) && d.exercises.every(e => typeof e.name === "string"));
    if (!ok) throw new Error("bad program");
    out.program = p;
  }
  if (!out.pass && !out.program) throw new Error("empty");
  // a card sent without a program means the gym removed it
  if (out.pass && !payload.program) out.program = null;
  return out;
}

function showOffer(data) {
  const box = $("#import-offer");
  const cur = store.get(PASS_KEY);
  const what = [data.pass && "your membership card", data.program && `the program “${data.program.name}”`].filter(Boolean).join(" and ");
  box.innerHTML = `<div class="label">From ${data.pass && data.pass.gym ? "" : "your gym"}<span class="offer-gym"></span></div>
    <div class="offer-title"></div><p class="offer-note"></p>
    <div class="offer-actions"><button class="primary">Save</button><button class="ghost">Not now</button></div>`;
  box.querySelector(".offer-gym").textContent = data.pass && data.pass.gym ? data.pass.gym.name : "";
  box.querySelector(".offer-title").textContent = data.pass ? data.pass.name : "New program";
  box.querySelector(".offer-note").textContent =
    `This adds ${what || "an update"} to this phone.` +
    (cur && data.pass && cur.code !== data.pass.code ? " It replaces the card that's on this phone now." : "");
  const [save, dismiss] = box.querySelectorAll("button");
  save.onclick = () => {
    if (data.pass) store.set(PASS_KEY, Object.assign({ receivedOn: isoToday() }, data.pass));
    if (data.program) store.set(PROGRAM_KEY, data.program);
    else if (data.program === null) store.del(PROGRAM_KEY);
    // a different member's card on this phone: the old login no longer belongs here
    const login = store.get(LOGIN_KEY);
    if (login && data.pass && cur && cur.code !== data.pass.code) store.del(LOGIN_KEY);
    box.hidden = true;
    selectedDay = undefined;
    renderAll();
    show(data.pass ? "card" : "program");
  };
  dismiss.onclick = () => { box.hidden = true; };
  box.hidden = false;
}
const isoToday = () => { const d = today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

async function handleImportLink() {
  const m = location.hash.match(/^#import=([A-Za-z0-9_\-+/=]+)/);
  if (!m) return false;
  try {
    showOffer(await decodeImport(m[1]));
  } catch {
    const box = $("#import-offer");
    box.innerHTML = `<div class="offer-title">This link doesn't work</div><p class="offer-note">Ask reception to show you the code again.</p>`;
    box.hidden = false;
  }
  return true;
}

// ---------- login ----------
// The card number (username) and last name (password) make (PBKDF2) the key that unlocks this member's pass
// and the name of its file in passes/. Same rules as GymDesk's preparePasses (desk.js); keep both in step.
// The phone keeps the key, not the last name, so it can fetch updates after a renewal by itself.
// Greek letters that look like Latin ones count as Latin: a Greek keyboard types "Μ1003" for M1003
const LOOKALIKE = { Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X" };
const normCard = s => String(s || "").replace(/\s+/g, "").toUpperCase().replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, c => LOOKALIKE[c]);
// letters and digits only, no accents, capitals: "Τσιρακίδης" = "ΤΣΙΡΑΚΙΔΗΣ"
const normLast = s => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
const b64u = bytes => { let bin = ""; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

async function getIndex() {
  const res = await fetch("passes/index.json", { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 ? "no-logins" : "offline");
  return res.json();
}
async function makeLogin(card, last, index) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(card + "|" + last), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(index.salt), iterations: index.iter }, base, 640));
  return { id: hex(bits.slice(32, 48)), key: b64u(bits.slice(0, 32)), salt: index.salt, v: index.v };
}
// null when the gym has no pass for this login (wrong details, or no longer a member)
async function fetchPass(login) {
  const res = await fetch(`passes/${login.id}.txt`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("offline");
  const both = unb64u((await res.text()).trim());
  const key = await crypto.subtle.importKey("raw", unb64u(login.key), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: both.slice(0, 12) }, key, both.slice(12));
  return checkPayload(JSON.parse(new TextDecoder().decode(plain)));
}
function savePass(data) {
  const cur = store.get(PASS_KEY);
  // keep the day the card first arrived unless the membership changed (the ring counts down from it)
  const receivedOn = cur && data.pass && cur.code === data.pass.code && cur.expiresOn === data.pass.expiresOn && cur.receivedOn ? cur.receivedOn : isoToday();
  if (data.pass) store.set(PASS_KEY, Object.assign({ receivedOn }, data.pass));
  if (data.program) store.set(PROGRAM_KEY, data.program);
  else if (data.program === null) store.del(PROGRAM_KEY);
}

async function logIn(e) {
  e.preventDefault();
  const form = e.target, msg = $("#login-msg"), btn = form.querySelector("button");
  const card = normCard(form.card.value), last = normLast(form.last.value);
  if (!card || !last) { msg.textContent = "Enter your card number and your last name."; return; }
  btn.disabled = true; msg.textContent = "Checking…";
  try {
    const login = await makeLogin(card, last, await getIndex());
    const data = await fetchPass(login);
    if (!data) { msg.textContent = "No card matches this card number and last name. Write your last name in Greek letters, or ask reception."; return; }
    savePass(data);
    store.set(LOGIN_KEY, Object.assign({ checked: Date.now() }, login));
    form.reset(); msg.textContent = "";
    selectedDay = undefined;
    renderAll(); show("card");
  } catch (err) {
    msg.textContent = err.message === "no-logins" ? "Your gym hasn't switched on logins yet. Ask reception for your code."
      : "Couldn't reach your gym's Gym Pass. Check your internet connection and try again.";
  } finally { btn.disabled = false; }
}
// a logged-in phone picks up renewals and program changes by itself: when the app is opened or comes back
// to the front, and every minute while it's on screen (at most every 30 seconds; the files are tiny)
async function refreshPass(force) {
  const login = store.get(LOGIN_KEY);
  if (!login || (!force && Date.now() - (login.checked || 0) < 30000)) return;
  try {
    const index = await getIndex();
    // the gym started over, or changed how members log in: log in again
    if (index.salt !== login.salt || (index.v || 1) !== (login.v || 1)) { store.del(LOGIN_KEY); renderAll(); return; }
    const data = await fetchPass(login);
    login.checked = Date.now(); login.missing = !data;
    store.set(LOGIN_KEY, login);
    if (data) {
      const before = JSON.stringify([store.get(PASS_KEY), store.get(PROGRAM_KEY)]);
      savePass(data);
      if (JSON.stringify([store.get(PASS_KEY), store.get(PROGRAM_KEY)]) !== before) renderAll();
    }
  } catch {}   // offline: keep what's on the phone
}

// ---------- card ----------
let codeType = store.get(CODE_KEY) || "qr";

function renderCode(id) {
  const el = $("#code");
  el.className = codeType;
  if (codeType === "qr" && window.qrcode) {
    const qr = qrcode(0, "M");
    qr.addData(id);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  } else {
    el.className = "barcode";
    el.innerHTML = Code128.toSVG(id);
  }
  document.querySelectorAll(".seg").forEach(b =>
    b.classList.toggle("active", b.dataset.code === el.className));
}

function status(p) {
  if (!p.expiresOn) return { days: -1, cls: "bad", text: "No membership" };
  const days = Math.round((parseDate(p.expiresOn) - today()) / DAY_MS);
  if (days < 0) return { days, cls: "bad", text: "Expired" };
  if (days <= 14) return { days, cls: "warn", text: "Expiring soon" };
  return { days, cls: "ok", text: "Active" };
}

function renderCard() {
  const p = store.get(PASS_KEY);
  $("#card-empty").hidden = !!p;
  $("#card-body").hidden = !p;
  $("#membership-empty").hidden = !!p;
  $("#membership-body").hidden = !p;
  $("#gym-name").textContent = p && p.gym ? p.gym.name : "Gym Pass";
  if (!p) return;
  const st = status(p);
  $("#member-name").textContent = p.name;
  $("#member-id").textContent = p.code;
  $("#card-gym").textContent = p.gym ? [p.gym.name, p.gym.club].filter(Boolean).join(" · ") : "—";
  $("#card-expiry").textContent = p.expiresOn ? fmt(parseDate(p.expiresOn)) : "—";
  const pill = $("#status-pill");
  pill.textContent = st.text;
  pill.className = "status " + st.cls;
  $("#code-wrap").classList.toggle("expired", st.days < 0);
  renderCode(p.code);

  // membership tab: the ring counts down from the day the card was received
  const end = p.expiresOn ? parseDate(p.expiresOn) : today();
  const from = p.receivedOn ? parseDate(p.receivedOn) : today();
  const total = Math.max(1, (end - from) / DAY_MS);
  const frac = Math.min(1, Math.max(0, st.days / total));
  const C = 2 * Math.PI * 52;
  const ring = $("#ring-fg");
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - frac);
  ring.style.stroke = `var(--${st.cls === "ok" ? "accent" : st.cls})`;
  $("#days-left").textContent = Math.max(0, st.days);
  $("#days-label").textContent = st.days === 1 ? "day left" : "days left";
  $("#expiry-date").textContent = p.expiresOn ? fmt(end) : "—";
  $("#expiry-note").textContent =
    !p.expiresOn ? "Ask reception about a membership."
    : st.days < 0 ? `Expired ${-st.days} day${st.days === -1 ? "" : "s"} ago. Renew at reception.`
    : st.days <= 14 ? "Renew at reception to keep your access."
    : "";
  $("#m-name").textContent = p.name;
  $("#m-id").textContent = p.code;
  $("#m-gym").textContent = p.gym ? [p.gym.name, p.gym.club].filter(Boolean).join(" · ") : "—";
  $("#m-updated").textContent = p.issued ? fmt(parseDate(p.issued)) : "—";
  const login = store.get(LOGIN_KEY);
  $("#update-note").textContent = !login ? "After you renew, scan the new code at reception to update this phone."
    : login.missing ? "Your gym no longer has a card for this login. Ask reception."
    : "Renewals and program changes arrive by themselves when you're online.";
}

// ---------- program ----------
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let selectedDay;

function doneKey(day) {
  // ticks reset each week: the key includes the Monday of the current week
  const t = today();
  const monday = new Date(t - ((t.getDay() + 6) % 7) * DAY_MS);
  return `gympass:done:${monday.toISOString().slice(0, 10)}:${day}`;
}

function renderProgram() {
  const p = store.get(PROGRAM_KEY), pass = store.get(PASS_KEY);
  // the program is only shown while the membership is valid; it stays saved for after a renewal
  const st = pass ? status(pass) : null;
  const locked = !!p && (!st || st.days < 0);
  $("#program-empty").hidden = !!p;
  $("#program-locked").hidden = !locked;
  $("#program-body").hidden = !p || locked;
  if (locked) {
    $("#locked-note").textContent = !pass ? "Ask reception for your Gym Pass card to see your program."
      : pass.expiresOn ? `Your membership ended on ${fmt(parseDate(pass.expiresOn))}. Renew at reception, then scan your new code to see your program again.`
      : "Ask reception about a membership to see your program.";
    return;
  }
  if (!p) return;
  $("#program-title").textContent = p.name;
  $("#program-meta").textContent = [p.weeks, p.coach].filter(Boolean).join(" · ");
  const todayName = WEEKDAYS[new Date().getDay()];
  if (!p.days.some(d => d.day === selectedDay))
    selectedDay = p.days.some(d => d.day === todayName) ? todayName : p.days[0].day;

  const chips = $("#day-chips");
  chips.innerHTML = "";
  for (const d of p.days) {
    const b = document.createElement("button");
    b.className = "day-chip" + (d.day === todayName ? " today" : "") + (d.day === selectedDay ? " active" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", d.day === selectedDay);
    b.innerHTML = `<div class="d"></div><div class="t"></div>`;
    b.querySelector(".d").textContent = d.day + (d.day === todayName ? " · today" : "");
    b.querySelector(".t").textContent = d.title;
    b.onclick = () => { selectedDay = d.day; renderProgram(); };
    chips.appendChild(b);
  }

  const day = p.days.find(d => d.day === selectedDay);
  const detail = $("#day-detail");
  detail.innerHTML = "";
  if (!day.exercises.length || /^rest$/i.test(day.title)) {
    detail.innerHTML = `<div class="rest">Rest day — recover well.</div>`;
    return;
  }
  if (day.note) {
    const n = document.createElement("p");
    n.className = "coach-note";
    n.textContent = day.note;
    detail.appendChild(n);
  }
  const done = new Set(store.get(doneKey(day.day)) || []);
  const ul = document.createElement("ul");
  ul.className = "ex-list";
  day.exercises.forEach((ex, i) => {
    const li = document.createElement("li");
    li.className = "ex" + (done.has(i) ? " done" : "");
    li.innerHTML = `<input type="checkbox" aria-label="Mark done"><div><div class="name"></div><div class="meta"></div></div>`;
    li.querySelector(".name").textContent = ex.name;
    li.querySelector(".meta").textContent =
      [ex.sets && ex.reps ? `${ex.sets} × ${ex.reps}` : ex.sets ? `${ex.sets} sets` : ex.reps, ex.load].filter(Boolean).join(" · ");
    const cb = li.querySelector("input");
    cb.checked = done.has(i);
    cb.onchange = () => {
      cb.checked ? done.add(i) : done.delete(i);
      li.classList.toggle("done", cb.checked);
      store.set(doneKey(day.day), [...done]);
    };
    ul.appendChild(li);
  });
  detail.appendChild(ul);
}

function renderAll() { renderCard(); renderProgram(); }

// ---------- navigation ----------
let wakeLock = null;
async function setWakeLock(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {}
}

function show(view) {
  document.querySelectorAll(".view").forEach(v => {
    const active = v.id === "view-" + view;
    v.hidden = !active;
    v.classList.toggle("active", active);
  });
  document.querySelectorAll(".tabbar button").forEach(b => {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active);
  });
  // keep the screen on while a card is shown at the reader
  setWakeLock(view === "card" && !!store.get(PASS_KEY));
  history.replaceState(null, "", "#" + view);
}

document.querySelectorAll(".tabbar button").forEach(b => b.onclick = () => show(b.dataset.view));
document.querySelectorAll(".seg").forEach(b => b.onclick = () => {
  codeType = b.dataset.code;
  store.set(CODE_KEY, codeType);
  const p = store.get(PASS_KEY);
  if (p) renderCode(p.code);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  renderAll();   // the date may have moved on (expiry, program lock) while the app was in the background
  if (!$("#view-card").hidden) setWakeLock(!!store.get(PASS_KEY));
  refreshPass();
});
setInterval(() => { if (document.visibilityState === "visible") refreshPass(); }, 60000);
$("#login-form").onsubmit = logIn;
$("#remove-card").onclick = () => {
  if (!confirm("Remove your membership card and program from this phone?")) return;
  store.del(PASS_KEY); store.del(PROGRAM_KEY); store.del(LOGIN_KEY);
  renderAll(); show("card");
};

// ---------- install prompt ----------
let deferredPrompt;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  $("#install-btn").hidden = false;
});
$("#install-btn").onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("#install-btn").hidden = true;
};

// ---------- boot ----------
window.addEventListener("hashchange", async () => { if (await handleImportLink()) show(store.get(PASS_KEY) ? "card" : "program"); });
(async function init() {
  renderAll();
  const start = location.hash.slice(1);
  if (await handleImportLink()) show("card");
  else show(["card", "membership", "program"].includes(start) ? start : "card");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  refreshPass(true);
})();
