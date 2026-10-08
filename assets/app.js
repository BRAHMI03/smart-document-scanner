(() => {
"use strict";

/* Smart Document Scanner Pro
   Strategy:
   1) Capture/upload a real image.
   2) Create several OCR-friendly image variants.
   3) OCR each variant with Tesseract.
   4) Merge text from the strongest passes.
   5) Extract fields with label-aware + context-aware rules.
*/

const $ = id => document.getElementById(id);
let stream = null;
let facing = "environment";
let worker = null;
let records = [];
let lastOCRText = "";

const setStatus = text => $("status").textContent = text;
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[ch]));
const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const digits = s => String(s || "").replace(/\D/g, "");
const maskAadhaar = s => { const d = digits(s); return d.length === 12 ? `XXXX XXXX ${d.slice(-4)}` : s || ""; };
const maskPan = s => { const p = clean(s).replace(/\s/g,"").toUpperCase(); return p.length === 10 ? `${p.slice(0,2)}XXXXX${p.slice(-3)}` : p; };

function setProgress(value, message) {
  $("progress").style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (message) setStatus(message);
}

/* ----------------------------- Camera ----------------------------- */
async function startCamera() {
  if (!window.isSecureContext) {
    setStatus("Camera requires HTTPS. Open the GitHub Pages HTTPS address.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("This browser cannot access the camera. Use Upload Image.");
    return;
  }

  try {
    stopCamera(false);
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 }
      }
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    $("video").srcObject = stream;
    $("video").style.display = "block";
    $("placeholder").style.display = "none";
    $("captureBtn").disabled = false;
    $("stopCamera").disabled = false;
    $("flipCamera").disabled = false;
    await $("video").play();
    setStatus("Camera ready. Fit the entire document inside the guide.");
  } catch (err) {
    console.error(err);
    const messages = {
      NotAllowedError: "Camera permission denied. Click the camera icon in Chrome → Allow camera → reload.",
      NotFoundError: "No camera was found. Connect a camera or use Upload Image.",
      NotReadableError: "The camera is busy. Close Windows Camera/Teams/Zoom and try again.",
      OverconstrainedError: "Camera settings were not supported. Try again or use Upload Image."
    };
    setStatus(messages[err.name] || `Camera error: ${err.message || "unknown error"}`);
  }
}

function stopCamera(showMessage = true) {
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  $("video").srcObject = null;
  $("video").style.display = "none";
  $("placeholder").style.display = "grid";
  $("captureBtn").disabled = true;
  $("stopCamera").disabled = true;
  $("flipCamera").disabled = true;
  if (showMessage) setStatus("Camera stopped.");
}

async function switchCamera() {
  if (!stream) return;
  facing = facing === "environment" ? "user" : "environment";
  await startCamera();
}

function captureCameraFrame() {
  const video = $("video");
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("Camera is still starting. Wait one second and try again.");
    return;
  }
  const canvas = $("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => blob && runOCR(blob), "image/jpeg", 0.96);
}

/* -------------------------- Image pipeline ------------------------- */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function makeVariant(img, mode) {
  const maxSide = 2200;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    let r = p[i], g = p[i+1], b = p[i+2];
    let y = 0.299*r + 0.587*g + 0.114*b;
    if (mode === "gray") {
      p[i] = p[i+1] = p[i+2] = y;
    } else if (mode === "contrast") {
      y = Math.max(0, Math.min(255, (y - 128) * 1.55 + 128));
      p[i] = p[i+1] = p[i+2] = y;
    } else if (mode === "threshold") {
      const v = y > 150 ? 255 : 0;
      p[i] = p[i+1] = p[i+2] = v;
    } else if (mode === "bright") {
      y = Math.max(0, Math.min(255, y * 1.15 + 8));
      p[i] = p[i+1] = p[i+2] = y;
    }
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.96));
}

async function prepareVariants(blob) {
  const img = await loadImage(blob);
  $("preview").src = URL.createObjectURL(blob);
  $("preview").style.display = "block";

  const variants = [
    {name:"original", canvas:null},
    {name:"gray", canvas:makeVariant(img,"gray")},
    {name:"contrast", canvas:makeVariant(img,"contrast")},
    {name:"threshold", canvas:makeVariant(img,"threshold")},
    {name:"bright", canvas:makeVariant(img,"bright")}
  ];
  variants[0].canvas = makeVariant(img,"gray"); // safe normalized source
  const out = [];
  for (const v of variants) {
    if (v.name === "original") out.push({name:v.name, blob});
    else out.push({name:v.name, blob:await canvasToBlob(v.canvas)});
  }
  return out;
}

function qualityEstimate(blob) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const pixels = img.naturalWidth * img.naturalHeight;
      if (pixels >= 1800000) resolve({label:"Good", tip:"High-resolution image. OCR should have enough pixels."});
      else if (pixels >= 900000) resolve({label:"Acceptable", tip:"Usable resolution. Retake closer if small text is missed."});
      else resolve({label:"Low", tip:"Retake closer to the document. Small text may be missed."});
    };
    img.onerror = () => resolve({label:"Unknown", tip:"Could not measure image quality."});
    img.src = url;
  });
}

/* ------------------------------ OCR -------------------------------- */
async function getWorker() {
  if (!window.Tesseract) throw new Error("OCR library did not load. Check internet and reload.");
  if (worker) return worker;

  $("engineStatus").textContent = "OCR engine: loading language data…";
  worker = await Tesseract.createWorker("eng", 1, {
    logger: info => {
      if (info.status === "recognizing text") {
        const pct = Math.round((info.progress || 0) * 100);
        setProgress(Math.min(94, 8 + pct * 0.78), `OCR reading… ${pct}%`);
      }
    }
  });
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1"
  });
  $("engineStatus").textContent = "OCR engine: ready";
  return worker;
}

function scoreOCR(text) {
  const t = clean(text);
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const nums = (t.match(/\d/g) || []).length;
  const lines = t.split(/\n/).filter(x => clean(x)).length;
  return Math.min(100, Math.round((letters * 0.15) + (nums * 0.12) + (lines * 1.8)));
}

async function recognizeVariant(blob, index, total) {
  const w = await getWorker();
  const result = await w.recognize(blob);
  const text = result?.data?.text || "";
  const confidence = Number(result?.data?.confidence || 0);
  return {text, confidence, score: scoreOCR(text), index, total};
}

function mergeOCR(results) {
  const sorted = results.slice().sort((a,b) => (b.score + b.confidence*0.15) - (a.score + a.confidence*0.15));
  const best = sorted[0]?.text || "";
  const lines = [];
  const seen = new Set();
  for (const r of sorted) {
    for (const line of String(r.text || "").split(/\r?\n/)) {
      const x = clean(line);
      if (!x) continue;
      const key = x.toLowerCase().replace(/[^a-z0-9]/g,"");
      if (key.length >= 2 && !seen.has(key)) {
        seen.add(key);
        lines.push(x);
      }
    }
  }
  return {text: lines.join("\n"), best, quality: sorted[0]?.confidence || 0};
}

async function runOCR(blob) {
  $("saveBtn").disabled = true;
  $("saveExcelBtn").disabled = true;
  $("confidenceBadge").textContent = "Scanning…";
  $("progressWrap").hidden = false;
  setProgress(3, "Preparing image…");

  try {
    const q = await qualityEstimate(blob);
    $("scanQuality").textContent = `Image quality: ${q.label}`;
    $("qualityTips").textContent = q.tip;

    const variants = await prepareVariants(blob);
    const results = [];
    for (let i = 0; i < variants.length; i++) {
      setProgress(7 + i*16, `OCR pass ${i+1} of ${variants.length}…`);
      try {
        results.push(await recognizeVariant(variants[i].blob, i+1, variants.length));
      } catch (err) {
        console.warn("OCR pass failed", i, err);
      }
    }
    if (!results.length) throw new Error("OCR could not process this image.");

    const merged = mergeOCR(results);
    lastOCRText = merged.text;
    if (!clean(lastOCRText)) throw new Error("No readable text found. Retake the document with brighter light and sharper focus.");

    setProgress(92, "Extracting name, mobile number and document fields…");
    const fields = parseFields(lastOCRText, $("docType").value);
    fillFields(fields);

    $("confidenceBadge").textContent = `OCR confidence ${Math.round(merged.quality)}%`;
    $("saveBtn").disabled = false;
    $("saveExcelBtn").disabled = false;
    setProgress(100, "Scan complete. Verify the extracted fields before saving.");
  } catch (err) {
    console.error(err);
    $("confidenceBadge").textContent = "Scan failed";
    setStatus(err.message || "Scanning failed.");
  } finally {
    setTimeout(() => $("progressWrap").hidden = true, 900);
  }
}

/* -------------------------- Field extraction ----------------------- */
function normalizeOCR(text) {
  return String(text || "")
    .replace(/\u00a0/g," ")
    .replace(/[|¦]/g,"I")
    .replace(/[“”]/g,'"')
    .replace(/[‘’]/g,"'")
    .replace(/[‐‑–—]/g,"-");
}

function digitRepair(s) {
  return String(s || "")
    .replace(/[OoQ]/g,"0")
    .replace(/[IlL|]/g,"1")
    .replace(/Z/g,"2")
    .replace(/[Ss]/g,"5")
    .replace(/G/g,"6")
    .replace(/B/g,"8");
}

function findMobile(text, lines) {
  const candidates = [];
  const source = normalizeOCR(text);
  const normalized = digitRepair(source);
  const regexes = [
    /(?:\+91|0091)?[\s().-]*([6-9]\d{2})[\s.-]*(\d{3})[\s.-]*(\d{4})/g,
    /\b([6-9]\d{9})\b/g
  ];
  for (const re of regexes) {
    let m;
    while ((m = re.exec(normalized))) {
      const d = `${m[1]}${m[2]||""}${m[3]||""}`.replace(/\D/g,"");
      const ten = d.slice(-10);
      if (/^[6-9]\d{9}$/.test(ten)) candidates.push(ten);
    }
  }
  for (let i=0;i<lines.length;i++) {
    if (/(mobile|mob|phone|contact|tel|telephone|cell)/i.test(lines[i])) {
      const local = digitRepair(lines.slice(i,i+2).join(" "));
      const m = local.match(/([6-9]\D*\d){9,}/);
      if (m) {
        const d = digits(m[0]).slice(-10);
        if (/^[6-9]\d{9}$/.test(d)) candidates.unshift(d);
      }
    }
  }
  return candidates[0] || "";
}

function findPAN(text) {
  const normalized = normalizeOCR(text).toUpperCase().replace(/\s+/g," ");
  const repaired = normalized.replace(/(?<=\b[A-Z]{2,4})0(?=\d)/g,"O");
  const patterns = [
    /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    /\b[A-Z]{5}[\s-]?\d{4}[\s-]?[A-Z]\b/g
  ];
  for (const p of patterns) {
    const m = repaired.match(p);
    if (m) return m[0].replace(/[\s-]/g,"");
  }
  return "";
}

function findAadhaar(text) {
  const repaired = digitRepair(normalizeOCR(text));
  const m = repaired.match(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/);
  return m ? digits(m[0]) : "";
}

function findDOB(text, lines) {
  const source = normalizeOCR(text);
  const patterns = [
    /\b(0?[1-9]|[12]\d|3[01])[\/.-](0?[1-9]|1[0-2])[\/.-]((?:19|20)\d{2})\b/g,
    /\b((?:19|20)\d{2})[\/.-](0?[1-9]|1[0-2])[\/.-](0?[1-9]|[12]\d|3[01])\b/g
  ];
  for (const p of patterns) {
    const m = p.exec(source);
    if (m) return m[0];
  }
  for (const line of lines) {
    if (/(date of birth|dob|birth|born)/i.test(line)) {
      const m = line.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/);
      if (m) return m[1];
    }
  }
  return "";
}

function findGender(text) {
  const m = normalizeOCR(text).match(/\b(MALE|FEMALE|OTHER|पुरुष|महिला)\b/i);
  return m ? m[1] : "";
}

const stopWords = new Set([
  "government","india","income","tax","department","authority","identification",
  "unique","aadhaar","aadhar","permanent","account","number","card","holder",
  "name","father","father's","mother","address","date","birth","year","male",
  "female","other","dob","mobile","phone","contact","signature","valid","until",
  "dob","enrollment","enrolment","uidai","www","com","gov","in","of","the"
]);

function isNameCandidate(line) {
  const x = clean(line).replace(/^[^A-Za-z]+|[^A-Za-z .'-]+$/g,"").trim();
  if (x.length < 3 || x.length > 55) return false;
  if (/\d/.test(x)) return false;
  const words = x.split(/\s+/);
  if (words.length < 2 || words.length > 6) return false;
  const low = words.map(w => w.toLowerCase());
  if (low.some(w => stopWords.has(w))) return false;
  if (/(address|government|income tax|permanent account|unique identification|date of birth)/i.test(x)) return false;
  const letters = (x.match(/[A-Za-z]/g)||[]).length;
  return letters / x.length > 0.65;
}

function findName(text, lines, dob, pan) {
  const cleanLines = lines.map(clean).filter(Boolean);

  // 1. Explicit labels have the highest priority.
  for (let i=0;i<cleanLines.length;i++) {
    const line = cleanLines[i];
    const inline = line.match(/^(?:name|full name|card holder|cardholder|applicant|customer)\s*(?:name)?\s*[:\-]?\s*(.+)$/i);
    if (inline && isNameCandidate(inline[1])) return inline[1].trim();
    if (/^(?:name|full name|card holder|cardholder|applicant|customer)\s*[:\-]?$/i.test(line)) {
      for (let j=i+1;j<=i+3 && j<cleanLines.length;j++) if (isNameCandidate(cleanLines[j])) return cleanLines[j];
    }
  }

  // 2. Aadhaar-style layout: candidate close to DOB/gender/ID markers.
  const markerIndexes = [];
  cleanLines.forEach((line,i) => {
    if (/(date of birth|dob|male|female|year of birth|unique identification|aadhaar|aadhar|government of india)/i.test(line)) markerIndexes.push(i);
  });
  const candidates = [];
  cleanLines.forEach((line,i) => {
    if (!isNameCandidate(line)) return;
    let score = 0;
    if (markerIndexes.some(m => Math.abs(i-m)<=3)) score += 25;
    if (dob && Math.abs(i-cleanLines.findIndex(x=>x.includes(dob)))<=4) score += 20;
    if (pan && Math.abs(i-cleanLines.findIndex(x=>x.replace(/\s/g,"").toUpperCase().includes(pan)))<=5) score += 18;
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5}$/.test(line)) score += 15;
    if (line.length >= 8 && line.length <= 40) score += 8;
    candidates.push({line,score});
  });
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]?.line || "";
}

function findAddress(lines) {
  const idx = lines.findIndex(x => /^(?:address|residential address|permanent address)\s*[:\-]?/i.test(x));
  if (idx >= 0) {
    const parts = [];
    const first = lines[idx].replace(/^(?:address|residential address|permanent address)\s*[:\-]?\s*/i,"");
    if (first) parts.push(first);
    for (let i=idx+1;i<Math.min(lines.length,idx+7);i++) {
      if (/(name|dob|date of birth|mobile|phone|gender|signature|aadhaar|pan)/i.test(lines[i])) break;
      parts.push(lines[i]);
    }
    return clean(parts.join(", "));
  }
  const postal = lines.find(x => /\b\d{6}\b/.test(x) && x.length > 18);
  return postal || "";
}

function parseFields(raw, selectedType) {
  const text = normalizeOCR(raw);
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const pan = findPAN(text);
  const aadhaar = findAadhaar(text);
  const mobile = findMobile(text, lines);
  const dob = findDOB(text, lines);
  const gender = findGender(text);
  let documentType = selectedType;
  if (documentType === "auto") {
    documentType = pan ? "pan" : (aadhaar ? "aadhaar" : "general");
  }
  const name = findName(text, lines, dob, pan);
  const address = findAddress(lines);

  return {
    documentType: documentType === "pan" ? "PAN" : documentType === "aadhaar" ? "Aadhaar" : "General document",
    name, dob, gender, mobile, pan, aadhaar, address,
    other: lines.slice(0, 80).join("\n")
  };
}

function fillFields(data) {
  $("f_docType").value = data.documentType || "";
  $("f_name").value = data.name || "";
  $("f_dob").value = data.dob || "";
  $("f_gender").value = data.gender || "";
  $("f_mobile").value = data.mobile || "";
  $("f_pan").value = data.pan || "";
  $("f_aadhaar").value = data.aadhaar || "";
  $("f_address").value = data.address || "";
  $("f_other").value = data.other || "";
}

/* ----------------------------- Storage ----------------------------- */
function openDB() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open("SmartDocumentScannerPro",1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("records",{keyPath:"id",autoIncrement:true});
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadRecords() {
  const db = await openDB();
  records = await new Promise((resolve,reject) => {
    const req = db.transaction("records","readonly").objectStore("records").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  renderRecords();
}
async function addRecord(record) {
  const db = await openDB();
  await new Promise((resolve,reject) => {
    const tx = db.transaction("records","readwrite");
    tx.objectStore("records").add(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await loadRecords();
}
async function deleteRecord(id) {
  const db = await openDB();
  await new Promise((resolve,reject) => {
    const tx = db.transaction("records","readwrite");
    tx.objectStore("records").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await loadRecords();
}
function renderRecords() {
  $("recordCount").textContent = records.length;
  const body = $("recordsBody");
  if (!records.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">No records yet.</td></tr>';
    return;
  }
  body.innerHTML = records.slice().reverse().map((r,i) => `<tr>
    <td>${records.length-i}</td><td>${esc(r.documentType)}</td><td>${esc(r.name)}</td>
    <td>${esc(r.dob)}</td><td>${esc(r.mobile)}</td><td>${esc(r.pan)}</td><td>${esc(r.aadhaar)}</td>
    <td>${esc(new Date(r.savedAt).toLocaleString())}</td>
    <td><button class="danger-btn" data-id="${r.id}">Delete</button></td>
  </tr>`).join("");
}

function collectRecord() {
  const full = $("storeSensitive").checked;
  const pan = clean($("f_pan").value).toUpperCase();
  const aadhaar = digits($("f_aadhaar").value);
  return {
    documentType: clean($("f_docType").value),
    name: clean($("f_name").value),
    dob: clean($("f_dob").value),
    gender: clean($("f_gender").value),
    mobile: digits($("f_mobile").value),
    pan: full ? pan : maskPan(pan),
    aadhaar: full ? aadhaar : maskAadhaar(aadhaar),
    address: clean($("f_address").value),
    other: clean($("f_other").value),
    savedAt: new Date().toISOString()
  };
}

async function saveRecord(andExcel=false) {
  const record = collectRecord();
  if (!record.name && !record.mobile && !record.pan && !record.aadhaar && !record.address) {
    alert("No useful data was extracted. Scan a clearer image first.");
    return;
  }
  await addRecord(record);
  setStatus("Record saved successfully.");
  $("saveBtn").disabled = true;
  $("saveExcelBtn").disabled = true;
  if (andExcel) exportExcel([record], "document_record.xlsx");
}

function exportExcel(rows, filename) {
  if (!window.XLSX) { alert("Excel library did not load. Reload the page."); return; }
  const header = ["Document Type","Full Name","Date of Birth","Gender","Mobile Number","PAN Number","Aadhaar Number","Address","Other Extracted Text","Saved At"];
  const data = [header, ...rows.map(r => [r.documentType,r.name,r.dob,r.gender,r.mobile,r.pan,r.aadhaar,r.address,r.other,r.savedAt])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Records");
  XLSX.writeFile(wb,filename);
}

function clearForm() {
  ["f_docType","f_name","f_dob","f_gender","f_mobile","f_pan","f_aadhaar","f_address","f_other"].forEach(id => $(id).value = "");
  $("preview").removeAttribute("src");
  $("preview").style.display = "none";
  $("confidenceBadge").textContent = "Not scanned";
  $("qualityTips").textContent = "";
  $("scanQuality").textContent = "Image quality: not checked";
  $("saveBtn").disabled = true;
  $("saveExcelBtn").disabled = true;
  lastOCRText = "";
  setStatus("Ready for another document.");
}

/* ----------------------------- Events ------------------------------ */
$("startCamera").onclick = startCamera;
$("flipCamera").onclick = switchCamera;
$("stopCamera").onclick = () => stopCamera();
$("captureBtn").onclick = captureCameraFrame;
$("fileInput").onchange = e => {
  const file = e.target.files?.[0];
  if (file) runOCR(file);
  e.target.value = "";
};
$("saveBtn").onclick = () => saveRecord(false);
$("saveExcelBtn").onclick = () => saveRecord(true);
$("clearBtn").onclick = clearForm;
$("recordsBody").onclick = e => {
  const btn = e.target.closest("[data-id]");
  if (btn && confirm("Delete this record?")) deleteRecord(Number(btn.dataset.id));
};
$("exportBtn").onclick = () => records.length ? exportExcel(records,"document_records.xlsx") : alert("No records yet.");
$("deleteAllBtn").onclick = async () => {
  if (!confirm("Delete all saved records from this browser?")) return;
  const db = await openDB();
  await new Promise((resolve,reject) => {
    const tx = db.transaction("records","readwrite");
    tx.objectStore("records").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  loadRecords();
};
$("recordsBtn").onclick = () => $("recordsPanel").scrollIntoView({behavior:"smooth"});
$("themeBtn").onclick = () => {
  document.body.classList.toggle("light");
  localStorage.setItem("sds-theme", document.body.classList.contains("light") ? "light" : "dark");
};
if (localStorage.getItem("sds-theme") === "light") document.body.classList.add("light");
$("year").textContent = new Date().getFullYear();

window.addEventListener("beforeunload", () => {
  if (worker) worker.terminate();
  stopCamera(false);
});

loadRecords().catch(err => {
  console.error(err);
  setStatus(`Browser storage error: ${err.message}`);
});
})();