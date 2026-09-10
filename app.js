"use strict";

/* ---------- small utilities ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- settings (localStorage) ---------- */

const Settings = {
  getApiKey() { return localStorage.getItem("cardscanner_api_key") || ""; },
  setApiKey(v) { localStorage.setItem("cardscanner_api_key", v || ""); },
  getModel() { return localStorage.getItem("cardscanner_model") || "claude-haiku-4-5-20251001"; },
  setModel(v) { localStorage.setItem("cardscanner_model", v || "claude-haiku-4-5-20251001"); }
};

/* ---------- view routing ---------- */

function showView(id) {
  if (id !== "view-scan" && typeof stopActiveStream === "function") stopActiveStream();
  $$(".view").forEach((v) => v.classList.remove("active"));
  $("#" + id).classList.add("active");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  const titles = {
    "view-list": "Card Scanner",
    "view-scan": "Scan a card",
    "view-detail": "Card",
    "view-settings": "Settings"
  };
  $("#topbarTitle").textContent = titles[id] || "Card Scanner";
  if (id === "view-list") renderCardList();
  if (id === "view-scan") resetScanView();
}

$$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));

/* ---------- image helpers ---------- */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Downscale + re-encode as JPEG to keep API payload and IndexedDB storage small.
function compressImage(dataUrl, maxDim = 1400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.split(",")[1];
}

/* ---------- groups / categories ---------- */

// Starter categories offered before you've scanned anything yet. Once you have cards,
// whatever groups you've actually used take priority (the AI is told to reuse them).
const DEFAULT_GROUPS = [
  "Client", "Vendor / Supplier", "Shipyard", "Classification Society",
  "Recruiter / Candidate", "Government / Regulatory", "Event Contact", "Other"
];

async function getGroupOptions() {
  const cards = await CardDB.getAll();
  const used = cards.map((c) => (c.group || "").trim()).filter(Boolean);
  const combined = [...new Set([...used, ...DEFAULT_GROUPS])];
  combined.sort((a, b) => a.localeCompare(b));
  return combined;
}

/* ---------- Claude API call ---------- */

function buildExtractionPrompt(existingGroups, hasBack) {
  const groupsList = existingGroups.length ? existingGroups.join(", ") : "(none yet)";
  const sideNote = hasBack
    ? "You are given two photos of the same business card: the front, then the back. Combine information from both sides into one set of fields — if a phone, email, address, or other detail appears only on the back, still include it."
    : "You are reading a photo of one side of a business card.";
  return `${sideNote} Extract the information into strict JSON only — no markdown fences, no commentary, just a JSON object with exactly these keys:

{
  "name": "",
  "title": "",
  "company": "",
  "phones": [],
  "emails": [],
  "website": "",
  "address": "",
  "notes": "",
  "raw_text": "",
  "suggested_group": ""
}

Rules:
- "phones" and "emails" are arrays of strings (can be empty).
- "notes" is for anything else useful on the card (tagline, secondary role, social handles) that doesn't fit other fields.
- "raw_text" is every line of text visible on the card (both sides, if two photos were given), newline separated, exactly as printed.
- "suggested_group" is a short category for organizing this contact (e.g. "Shipyard", "Vendor / Supplier",
  "Client", "Classification Society"). Categories already in use: ${groupsList}. Reuse one of those if it
  clearly fits the company/title/notes on this card. Only propose a new short category name (2-3 words,
  title case) if none of the existing ones fit.
- If a field is not present on the card, use "" (or [] for arrays). Never invent information.
- Output only the JSON object, nothing else.`;
}

async function extractCardFields(frontBase64Jpeg, backBase64Jpeg) {
  const apiKey = Settings.getApiKey();
  if (!apiKey) throw new Error("NO_API_KEY");

  const existingGroups = await getGroupOptions();
  const prompt = buildExtractionPrompt(existingGroups, !!backBase64Jpeg);

  const content = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontBase64Jpeg } }
  ];
  if (backBase64Jpeg) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: backBase64Jpeg } });
  }
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: Settings.getModel(),
      max_tokens: 1024,
      messages: [{ role: "user", content }]
    })
  });

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (_) {}
    if (res.status === 401) throw new Error("BAD_API_KEY");
    throw new Error(detail || `Request failed (${res.status})`);
  }

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const jsonStr = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { throw new Error("Could not read the model's response. Try rescanning with better lighting."); }

  return {
    name: parsed.name || "",
    title: parsed.title || "",
    company: parsed.company || "",
    phones: Array.isArray(parsed.phones) ? parsed.phones : [],
    emails: Array.isArray(parsed.emails) ? parsed.emails : [],
    website: parsed.website || "",
    address: parsed.address || "",
    notes: parsed.notes || "",
    rawText: parsed.raw_text || "",
    suggestedGroup: (parsed.suggested_group || "").trim()
  };
}

/* ---------- SCAN VIEW ---------- */

let captureStage = null; // "front" | "back" — which photo we're currently capturing
let pendingFrontPhotoDataUrl = null;
let pendingBackPhotoDataUrl = null;
let pendingFields = null;
let activeStream = null;
let currentFacingMode = "environment";

function resetScanView() {
  captureStage = null;
  pendingFrontPhotoDataUrl = null;
  pendingBackPhotoDataUrl = null;
  pendingFields = null;
  currentFacingMode = "environment";
  stopActiveStream();
  $("#scanContent").innerHTML = `
    <div class="status-msg">
      <div style="font-size:40px; margin-bottom:10px;">📇</div>
      <div>Tap below to photograph a business card.</div>
    </div>
    <button class="btn btn-primary" id="takePhotoBtn">Take photo</button>
  `;
  $("#takePhotoBtn").addEventListener("click", () => {
    if (!Settings.getApiKey()) {
      toast("Add your API key in Settings first");
      showView("view-settings");
      return;
    }
    captureStage = "front";
    openCameraView("Position the FRONT of the card in frame");
  });
}

function stopActiveStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
}

/* ---- live camera view (defaults to back camera; flip + gallery fallback) ---- */

async function openCameraView(promptLabel) {
  $("#scanContent").innerHTML = `
    <div class="camera-wrap"><video id="cameraVideo" autoplay playsinline muted></video></div>
    <div class="camera-controls">
      <button class="btn-icon" id="galleryBtn" title="Choose from gallery">🖼</button>
      <button class="shutter-btn" id="shutterBtn" aria-label="Capture"></button>
      <button class="btn-icon" id="flipCameraBtn" title="Flip camera">🔄</button>
    </div>
    <div class="hint" style="text-align:center; margin-top:0;">${escapeHtml(promptLabel)}</div>
  `;
  $("#galleryBtn").addEventListener("click", () => { stopActiveStream(); $("#galleryInput").click(); });

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: currentFacingMode } },
      audio: false
    });
  } catch (err) {
    $("#scanContent").innerHTML = `
      <div class="status-msg error">⚠ Couldn't open the camera (${escapeHtml(err.message || err.name || "permission denied")}).</div>
      <button class="btn btn-primary" id="galleryFallbackBtn">Choose photo from gallery instead</button>
      <button class="btn btn-secondary" id="retryCameraBtn" style="margin-top:10px;">Try camera again</button>
    `;
    $("#galleryFallbackBtn").addEventListener("click", () => $("#galleryInput").click());
    $("#retryCameraBtn").addEventListener("click", () => openCameraView(promptLabel));
    return;
  }

  const video = $("#cameraVideo");
  if (!video) { stopActiveStream(); return; } // user navigated away while permission prompt was open
  video.srcObject = activeStream;

  $("#flipCameraBtn").addEventListener("click", () => {
    currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    stopActiveStream();
    openCameraView(promptLabel);
  });
  $("#shutterBtn").addEventListener("click", () => {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stopActiveStream();
    showCropStep(canvas.toDataURL("image/jpeg", 0.92), promptLabel);
  });
}

$("#galleryInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const promptLabel = captureStage === "back" ? "Position the BACK of the card in frame" : "Position the FRONT of the card in frame";
  try {
    const rawDataUrl = await readFileAsDataUrl(file);
    showCropStep(rawDataUrl, promptLabel);
  } catch (err) {
    toast("Couldn't read that photo — try again");
  }
});

/* ---- optional crop step ---- */

function showCropStep(rawDataUrl, promptLabel) {
  $("#scanContent").innerHTML = `
    <div class="crop-wrap"><img id="cropImage" src="${rawDataUrl}"></div>
    <div class="hint">Drag the corners to trim to just the card, or skip to keep the full photo.</div>
    <button class="btn btn-primary" id="useCropBtn">Use this crop</button>
    <div class="btn-row" style="margin-top:10px;">
      <button class="btn btn-secondary" id="skipCropBtn">Skip — use full photo</button>
      <button class="btn btn-secondary" id="retakeBtn">Retake</button>
    </div>
  `;
  const imgEl = $("#cropImage");
  let cropper = new Cropper(imgEl, { viewMode: 1, autoCropArea: 0.85, background: false, movable: false, zoomable: false, dragMode: "crop" });

  const finish = async (dataUrl) => {
    cropper.destroy();
    cropper = null;
    const finalDataUrl = await compressImage(dataUrl);
    if (captureStage === "back") {
      pendingBackPhotoDataUrl = finalDataUrl;
      await runExtractionAndShowReview();
    } else {
      pendingFrontPhotoDataUrl = finalDataUrl;
      showBackPrompt();
    }
  };

  $("#useCropBtn").addEventListener("click", () => {
    const canvas = cropper.getCroppedCanvas();
    finish(canvas.toDataURL("image/jpeg", 0.9));
  });
  $("#skipCropBtn").addEventListener("click", () => finish(rawDataUrl));
  $("#retakeBtn").addEventListener("click", () => {
    cropper.destroy();
    cropper = null;
    openCameraView(promptLabel);
  });
}

function showBackPrompt() {
  $("#scanContent").innerHTML = `
    <img class="card-photo-preview" src="${pendingFrontPhotoDataUrl}">
    <div class="hint">Front captured. Does this card have anything useful on the back (extra numbers, a second language, a QR code)?</div>
    <button class="btn btn-primary" id="addBackBtn">Scan the back too</button>
    <button class="btn btn-secondary" id="skipBackBtn" style="margin-top:10px;">Continue with just the front</button>
  `;
  $("#addBackBtn").addEventListener("click", () => {
    captureStage = "back";
    openCameraView("Position the BACK of the card in frame");
  });
  $("#skipBackBtn").addEventListener("click", () => runExtractionAndShowReview());
}

async function runExtractionAndShowReview() {
  $("#scanContent").innerHTML = `<div class="status-msg"><div class="spinner"></div>Reading the card…</div>`;
  try {
    const fields = await extractCardFields(
      dataUrlToBase64(pendingFrontPhotoDataUrl),
      pendingBackPhotoDataUrl ? dataUrlToBase64(pendingBackPhotoDataUrl) : null
    );
    pendingFields = fields;
    await renderReviewForm();
  } catch (err) {
    let msg = err.message;
    if (msg === "NO_API_KEY") msg = "No API key set. Add one in Settings.";
    if (msg === "BAD_API_KEY") msg = "That API key was rejected. Check it in Settings.";
    $("#scanContent").innerHTML = `
      <div class="status-msg error">⚠ ${escapeHtml(msg)}</div>
      <button class="btn btn-secondary" id="retryBtn">Try again</button>
    `;
    $("#retryBtn").addEventListener("click", resetScanView);
  }
}

async function renderReviewForm(existing) {
  const f = existing || pendingFields || {};
  const photo = existing ? existing.imageDataUrl : pendingFrontPhotoDataUrl;
  const backPhoto = existing ? (existing.backImageDataUrl || null) : pendingBackPhotoDataUrl;
  const groupValue = existing ? (existing.group || "") : (pendingFields && pendingFields.suggestedGroup) || "";
  const groupOptions = await getGroupOptions();
  const groupHint = !existing && groupValue
    ? `Suggested based on this card — accept it, pick another below, or type a new one.`
    : `Pick an existing group below or type a new one to create it.`;

  $("#scanContent").innerHTML = `
    ${photo ? `<img class="card-photo-preview" src="${photo}">` : ""}
    ${backPhoto ? `<img class="card-photo-preview" src="${backPhoto}" style="margin-top:-8px;">` : ""}
    <div class="hint">Check the details below — fix anything the scan got wrong, then save.</div>
    <div class="field"><label>Name</label><input id="f_name" value="${escapeHtml(f.name)}"></div>
    <div class="field"><label>Title</label><input id="f_title" value="${escapeHtml(f.title)}"></div>
    <div class="field"><label>Company</label><input id="f_company" value="${escapeHtml(f.company)}"></div>
    <div class="field">
      <label>Group / category</label>
      <input id="f_group" list="groupOptionsList" value="${escapeHtml(groupValue)}" placeholder="e.g. Shipyard, Vendor, Client">
      <datalist id="groupOptionsList">${groupOptions.map((g) => `<option value="${escapeHtml(g)}">`).join("")}</datalist>
    </div>
    <div class="hint" style="margin-top:-10px;">${groupHint}</div>
    <div class="field"><label>Phone(s) — comma separated</label><input id="f_phones" value="${escapeHtml((f.phones || []).join(", "))}"></div>
    <div class="field"><label>Email(s) — comma separated</label><input id="f_emails" value="${escapeHtml((f.emails || []).join(", "))}"></div>
    <div class="field"><label>Website</label><input id="f_website" value="${escapeHtml(f.website)}"></div>
    <div class="field"><label>Address</label><textarea id="f_address">${escapeHtml(f.address)}</textarea></div>
    <div class="field"><label>Notes</label><textarea id="f_notes">${escapeHtml(f.notes)}</textarea></div>
    <button class="btn btn-primary" id="saveCardBtn">Save card</button>
    <button class="btn btn-secondary" id="discardBtn" style="margin-top:10px;">Discard &amp; rescan</button>
  `;
  $("#saveCardBtn").addEventListener("click", () => saveReviewedCard(existing ? existing.id : null, photo, backPhoto));
  $("#discardBtn").addEventListener("click", resetScanView);
}

function readReviewForm() {
  return {
    name: $("#f_name").value.trim(),
    title: $("#f_title").value.trim(),
    company: $("#f_company").value.trim(),
    group: $("#f_group").value.trim(),
    phones: $("#f_phones").value.split(",").map((s) => s.trim()).filter(Boolean),
    emails: $("#f_emails").value.split(",").map((s) => s.trim()).filter(Boolean),
    website: $("#f_website").value.trim(),
    address: $("#f_address").value.trim(),
    notes: $("#f_notes").value.trim()
  };
}

async function saveReviewedCard(existingId, photoDataUrl, backPhotoDataUrl) {
  const fields = readReviewForm();
  const card = {
    id: existingId || uid(),
    createdAt: existingId ? (await CardDB.get(existingId))?.createdAt || new Date().toISOString() : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    imageDataUrl: photoDataUrl || null,
    backImageDataUrl: backPhotoDataUrl || null,
    rawText: (pendingFields && pendingFields.rawText) || "",
    ...fields
  };
  await CardDB.put(card);
  toast(existingId ? "Card updated" : "Card saved");
  showView("view-list");
}

/* ---------- LIST VIEW + SEARCH + GROUP FILTER ---------- */

let allCards = [];
let activeGroupFilter = null; // null = "All"; otherwise a group name, or "Uncategorized"

async function renderCardList() {
  allCards = await CardDB.getAll();
  renderGroupChips();
  filterAndRenderList($("#searchInput").value);
}

function groupKeyOf(card) {
  return (card.group || "").trim() || "Uncategorized";
}

function computeGroupCounts() {
  const counts = new Map();
  for (const c of allCards) {
    const key = groupKeyOf(c);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function renderGroupChips() {
  const el = $("#groupChips");
  const counts = computeGroupCounts();

  if (activeGroupFilter && !counts.has(activeGroupFilter)) activeGroupFilter = null;

  if (counts.size <= 1 && allCards.length === 0) { el.innerHTML = ""; return; }

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chips = [{ label: "All", count: allCards.length, value: "" }, ...entries.map(([k, v]) => ({ label: k, count: v, value: k }))];

  el.innerHTML = chips.map((c) => `
    <button class="chip${(activeGroupFilter || "") === c.value ? " active" : ""}" data-value="${escapeHtml(c.value)}">${escapeHtml(c.label)} (${c.count})</button>
  `).join("");

  $$(".chip", el).forEach((btn) => btn.addEventListener("click", () => {
    activeGroupFilter = btn.dataset.value || null;
    renderGroupChips();
    filterAndRenderList($("#searchInput").value);
  }));
}

function cardMatches(card, q) {
  if (!q) return true;
  const hay = [
    card.name, card.title, card.company, card.group, card.website, card.address, card.notes, card.rawText,
    (card.phones || []).join(" "), (card.emails || []).join(" ")
  ].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filterAndRenderList(query) {
  const container = $("#cardListContainer");
  const filtered = allCards.filter((c) => cardMatches(c, query) && (!activeGroupFilter || groupKeyOf(c) === activeGroupFilter));

  if (allCards.length === 0) {
    container.innerHTML = `<div class="empty-state">No cards yet.<br>Tap Scan below to add your first one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    const groupPart = activeGroupFilter ? ` in "${escapeHtml(activeGroupFilter)}"` : "";
    container.innerHTML = query
      ? `<div class="empty-state">No cards match "${escapeHtml(query)}"${groupPart}.</div>`
      : `<div class="empty-state">No cards${groupPart} yet.</div>`;
    return;
  }

  container.innerHTML = `<div class="card-list">${filtered.map((c) => `
    <div class="card-item" data-id="${c.id}">
      ${c.imageDataUrl ? `<img src="${c.imageDataUrl}">` : `<div class="card-item-noimg" style="width:64px;height:64px;border-radius:8px;background:#e5e9ef;flex-shrink:0;"></div>`}
      <div class="info">
        <div class="name">${escapeHtml(c.name || "(no name)")}</div>
        <div class="sub">${escapeHtml([c.title, c.company].filter(Boolean).join(" · "))}</div>
        <div class="sub">${escapeHtml((c.phones || [])[0] || (c.emails || [])[0] || "")}</div>
        ${c.group ? `<div class="group-pill">${escapeHtml(c.group)}</div>` : ""}
      </div>
    </div>
  `).join("")}</div>`;

  $$(".card-item", container).forEach((el) => {
    el.addEventListener("click", () => openCardDetail(el.dataset.id));
  });
}

$("#searchInput").addEventListener("input", (e) => filterAndRenderList(e.target.value));
$("#searchInput").addEventListener("keyup", (e) => { if (e.key === "Escape") { e.target.value = ""; filterAndRenderList(""); } });

/* ---------- voice search ---------- */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
if (SpeechRecognition) {
  recognizer = new SpeechRecognition();
  recognizer.lang = "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    $("#searchInput").value = transcript;
    filterAndRenderList(transcript);
  };
  recognizer.onend = () => $("#micBtn").classList.remove("listening");
  recognizer.onerror = () => { $("#micBtn").classList.remove("listening"); toast("Didn't catch that — try again"); };

  $("#micBtn").addEventListener("click", () => {
    if ($("#micBtn").classList.contains("listening")) { recognizer.stop(); return; }
    $("#micBtn").classList.add("listening");
    try { recognizer.start(); } catch (_) {}
  });
} else {
  $("#micBtn").addEventListener("click", () => toast("Voice search isn't supported in this browser"));
}

/* ---------- CARD DETAIL VIEW ---------- */

async function openCardDetail(id) {
  const card = await CardDB.get(id);
  if (!card) { toast("Card not found"); showView("view-list"); return; }
  showView("view-detail");

  const rows = [
    ["Group", card.group], ["Title", card.title], ["Company", card.company],
    ["Phone", (card.phones || []).join(", ")], ["Email", (card.emails || []).join(", ")],
    ["Website", card.website], ["Address", card.address], ["Notes", card.notes]
  ].filter(([, v]) => v);

  $("#detailContent").innerHTML = `
    ${card.imageDataUrl ? `<img class="card-photo-preview" src="${card.imageDataUrl}">` : ""}
    ${card.backImageDataUrl ? `<img class="card-photo-preview" src="${card.backImageDataUrl}" style="margin-top:-8px;">` : ""}
    <h2 style="margin:0 0 4px;">${escapeHtml(card.name || "(no name)")}</h2>
    ${rows.map(([label, val]) => `
      <div class="field"><label>${label}</label><div style="padding:6px 0; white-space:pre-wrap;">${escapeHtml(val)}</div></div>
    `).join("")}
    <div class="btn-row">
      <button class="btn btn-secondary" id="editCardBtn">Edit</button>
      <button class="btn btn-danger" id="deleteCardBtn">Delete</button>
    </div>
  `;

  $("#editCardBtn").addEventListener("click", async () => {
    showView("view-scan");
    $("#topbarTitle").textContent = "Edit card";
    pendingFrontPhotoDataUrl = card.imageDataUrl;
    pendingBackPhotoDataUrl = card.backImageDataUrl || null;
    pendingFields = card;
    await renderReviewForm(card);
  });

  $("#deleteCardBtn").addEventListener("click", async () => {
    if (!confirm(`Delete the card for "${card.name || "this contact"}"? This can't be undone.`)) return;
    await CardDB.delete(id);
    toast("Card deleted");
    showView("view-list");
  });
}

/* ---------- SETTINGS VIEW ---------- */

function loadSettingsForm() {
  $("#apiKeyInput").value = Settings.getApiKey();
  $("#modelSelect").value = Settings.getModel();
}

$("#saveSettingsBtn").addEventListener("click", () => {
  Settings.setApiKey($("#apiKeyInput").value.trim());
  Settings.setModel($("#modelSelect").value);
  toast("Settings saved");
});

/* ---------- export / import ---------- */

$("#exportBtn").addEventListener("click", async () => {
  const cards = await CardDB.getAll();
  if (cards.length === 0) { toast("No cards to export yet"); return; }
  const payload = { app: "cardscanner", version: 1, exportedAt: new Date().toISOString(), cards };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `cardscanner-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${cards.length} card(s)`);
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const cards = Array.isArray(payload.cards) ? payload.cards : Array.isArray(payload) ? payload : null;
    if (!cards) throw new Error("This doesn't look like a Card Scanner backup file.");
    const { added, skipped } = await CardDB.importMany(cards);
    toast(`Imported ${added} card(s)${skipped ? `, skipped ${skipped} already here` : ""}`);
    renderCardList();
  } catch (err) {
    toast("Import failed: " + err.message);
  }
});

/* ---------- boot ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

loadSettingsForm();
renderCardList();
