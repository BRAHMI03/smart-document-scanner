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
        setProgress(Math.min(90, 5 + pct * 0.82), `OCR reading… ${pct}%`);
      }
    }
  });
  await worker.setParameters({ preserve_interword_spaces: "1" });
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

async function recognizeBlob(blob, psm="6") {
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1" });
  const result = await w.recognize(blob);
  return {text: result?.data?.text || "", confidence: Number(result?.data?.confidence || 0), score: scoreOCR(result?.data?.text || "")};
}

async function recognizeRegion(img, x,y,w,h, psm="6") {
  const c=document.createElement("canvas");
  c.width=Math.max(300,Math.round(img.naturalWidth*w));
  c.height=Math.max(120,Math.round(img.naturalHeight*h));
  const ctx=c.getContext("2d");
  ctx.imageSmoothingEnabled=true;
  ctx.drawImage(img, Math.round(img.naturalWidth*x), Math.round(img.naturalHeight*y), Math.round(img.naturalWidth*w), Math.round(img.naturalHeight*h), 0,0,c.width,c.height);
  const b=await canvasToBlob(c);
  return recognizeBlob(b,psm);
}

async function documentAwareOCR(blob, type) {
  const img=await loadImage(blob);
  const results=[];
  const variants=await prepareVariants(blob);
  for(let i=0;i<variants.length;i++){
    setProgress(7+i*10,`OCR image pass ${i+1} of ${variants.length}…`);
    try { results.push(await recognizeBlob(variants[i].blob, i===3 ? "11" : "6")); } catch(e){ console.warn(e); }
  }

  // PAN cards have stable labelled regions. Run focused OCR so a bad full-page line
  // cannot win over the clearly labelled Name / Date of Birth / PAN areas.
  if(type === "pan" || type === "auto") {
    const regions=[
      ["pan",0.20,0.28,0.58,0.24],
      ["name",0.02,0.50,0.72,0.19],
      ["father",0.02,0.61,0.76,0.17],
      ["dob",0.02,0.72,0.45,0.20]
    ];
    for(const [label,x,y,w,h] of regions){
      try{
        const r=await recognizeRegion(img,x,y,w,h,"6");
        results.push({...r,region:label});
      }catch(e){console.warn("Region OCR",label,e);}
    }
  }
  return results;
}

function mergeOCR(results) {
  const sorted=results.slice().sort((a,b)=>(b.score+b.confidence*.15)-(a.score+a.confidence*.15));
  const lines=[]; const seen=new Set();
  for(const r of sorted){
    for(const line of String(r.text||"").split(/\r?\n/)){
      const x=clean(line); if(!x) continue;
      const key=x.toLowerCase().replace(/[^a-z0-9]/g,"");
      if(key.length>=2&&!seen.has(key)){seen.add(key);lines.push(x);}
    }
  }
  return {text:lines.join("\n"), best:sorted[0]?.text||"", quality:sorted[0]?.confidence||0, results:sorted};
}

async function runOCR(blob) {
  $("saveBtn").disabled=true; $("saveExcelBtn").disabled=true;
  $("confidenceBadge").textContent="Scanning…"; $("progressWrap").hidden=false; setProgress(2,"Preparing image…");
  try{
    const q=await qualityEstimate(blob);
    $("scanQuality").textContent=`Image quality: ${q.label}`; $("qualityTips").textContent=q.tip;
    const selected=$("docType").value;
    const results=await documentAwareOCR(blob,selected);
    if(!results.length) throw new Error("OCR could not process this image.");
    const merged=mergeOCR(results); lastOCRText=merged.text;
    if(!clean(lastOCRText)) throw new Error("No readable text found. Retake the document with brighter light and sharper focus.");
    setProgress(94,"Extracting fields using document layout…");
    const fields=parseFields(lastOCRText,selected,merged.results);
    fillFields(fields);
    $("confidenceBadge").textContent=`OCR confidence ${Math.round(merged.quality)}%`;
    $("saveBtn").disabled=false; $("saveExcelBtn").disabled=false;
    setProgress(100,"Scan complete. Verify every field before saving.");
  }catch(err){
    console.error(err); $("confidenceBadge").textContent="Scan failed"; setStatus(err.message||"Scanning failed.");
  }finally{setTimeout(()=>$("progressWrap").hidden=true,900);}
}

/* -------------------------- Field extraction ----------------------- */
function normalizeOCR(text){return String(text||"").replace(/\u00a0/g," ").replace(/[|¦]/g,"I").replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[‐‑–—]/g,"-");}
function digitRepair(s){return String(s||"").replace(/[OoQ]/g,"0").replace(/[IlL|]/g,"1").replace(/Z/g,"2").replace(/[Ss]/g,"5").replace(/G/g,"6").replace(/B/g,"8");}

function findMobile(text,lines){
  const out=[]; const source=normalizeOCR(text); const repaired=digitRepair(source);
  // Only accept an Indian mobile when it is explicitly present as a 10-digit number.
  for(const re of [/\b([6-9]\d{2})[\s.-]*(\d{3})[\s.-]*(\d{4})\b/g,/\b([6-9]\d{9})\b/g]){
    let m; while((m=re.exec(repaired))){const d=digits(`${m[1]}${m[2]||""}${m[3]||""}`).slice(-10);if(/^[6-9]\d{9}$/.test(d))out.push(d);}
  }
  for(let i=0;i<lines.length;i++){
    if(/\b(mobile|mob|phone|contact|telephone|tel)\b/i.test(lines[i])){
      const d=digits(digitRepair(lines.slice(i,i+3).join(" ")));
      const m=d.match(/[6-9]\d{9}/); if(m) out.unshift(m[0]);
    }
  }
  return [...new Set(out)][0]||"";
}

function findPAN(text){
  const t=normalizeOCR(text).toUpperCase();
  const candidates=[];
  for(const line of t.split(/\n/)){
    const compact=line.replace(/[^A-Z0-9]/g,"");
    const m=compact.match(/[A-Z]{5}\d{4}[A-Z]/);
    if(m)candidates.push(m[0]);
  }
  const all=t.match(/[A-Z]{5}[\s-]?\d{4}[\s-]?[A-Z]/g)||[];
  for(const x of all)candidates.push(x.replace(/[\s-]/g,""));
  return candidates[0]||"";
}

function findAadhaar(text){
  const repaired=digitRepair(normalizeOCR(text));
  const m=repaired.match(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/); return m?digits(m[0]):"";
}

function findDOB(text,lines){
  const source=normalizeOCR(text);
  const p=[/\b(0?[1-9]|[12]\d|3[01])[\/.-](0?[1-9]|1[0-2])[\/.-]((?:19|20)\d{2})\b/g,/\b((?:19|20)\d{2})[\/.-](0?[1-9]|1[0-2])[\/.-](0?[1-9]|[12]\d|3[01])\b/g];
  for(const r of p){const m=r.exec(source);if(m)return m[0];}
  for(const line of lines){if(/(date of birth|dob|birth|born)/i.test(line)){const m=line.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/);if(m)return m[1];}}
  return "";
}

function findGender(text,lines){
  for(const line of lines){
    if(/\b(gender|sex)\b/i.test(line)){
      const m=line.match(/\b(MALE|FEMALE|OTHER)\b/i); if(m)return m[1];
      const next=lines[lines.indexOf(line)+1]||""; const n=next.match(/\b(MALE|FEMALE|OTHER)\b/i); if(n)return n[1];
    }
  }
  const direct=normalizeOCR(text).match(/\b(MALE|FEMALE|OTHER)\b/i); return direct?direct[1]:"";
}

function candidateName(x){
  x=clean(x).replace(/^[^A-Za-z]+|[^A-Za-z .'-]+$/g,"").trim();
  if(x.length<4||x.length>55||/\d/.test(x))return "";
  const words=x.split(/\s+/); if(words.length<2||words.length>7)return "";
  const bad=/^(government|income|tax|department|authority|identification|unique|aadhaar|aadhar|permanent|account|number|card|holder|father|date|birth|male|female|signature|name)$/i;
  if(words.some(w=>bad.test(w)))return "";
  if(/(income tax|government of india|permanent account|unique identification|date of birth)/i.test(x))return "";
  const letters=(x.match(/[A-Za-z]/g)||[]).length; if(letters/x.length<.65)return "";
  return x;
}

function findLabelledValue(lines,labelRegex){
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const m=line.match(labelRegex);
    if(!m)continue;
    const inline=clean(line.slice(m.index+m[0].length).replace(/^[:\-\/]+/," "));
    const v=candidateName(inline); if(v)return v;
    for(let j=i+1;j<=Math.min(i+3,lines.length-1);j++){const n=candidateName(lines[j]);if(n)return n;}
  }
  return "";
}

function findName(text,lines,dob,pan,docType,ocrResults){
  // PAN-specific: the line following the visible "Name" label is authoritative.
  if(docType==="pan"||docType==="auto"){
    const labelled=findLabelledValue(lines,/\bname\b/i);
    if(labelled && !/father/i.test(labelled))return labelled;
    // Focused region OCR is tagged as region:name. Prefer it over full-page noise.
    const region=ocrResults?.filter(r=>r.region==="name").map(r=>String(r.text||"")).join("\n")||"";
    const rl=region.split(/\r?\n/).map(clean).filter(Boolean);
    for(const l of rl){const n=candidateName(l);if(n)return n;}
  }
  // General labelled name extraction.
  const labelled=findLabelledValue(lines,/\b(full\s*name|card\s*holder|applicant|customer)\b/i); if(labelled)return labelled;
  const marker=lines.findIndex(x=>/(date of birth|dob|gender|male|female|father)/i.test(x));
  const nearby=lines.slice(Math.max(0,marker-5),Math.min(lines.length,marker+3));
  for(const l of nearby){const n=candidateName(l);if(n)return n;}
  return "";
}

function findAddress(lines){
  // NEVER invent an address from arbitrary OCR lines. Address requires an address label
  // or a clearly address-like block with a postal code and location words.
  for(let i=0;i<lines.length;i++){
    if(/^(?:address|residential address|permanent address|communication address)\s*[:\-]?/i.test(lines[i])){
      const parts=[]; const first=lines[i].replace(/^(?:address|residential address|permanent address|communication address)\s*[:\-]?\s*/i,""); if(first)parts.push(first);
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){if(/^(name|mobile|phone|dob|date of birth|gender|pan|aadhaar|signature)/i.test(lines[j]))break;parts.push(lines[j]);}
      const a=clean(parts.join(", ")); if(a.length>=8)return a;
    }
  }
  return "";
}

function parseFields(raw,selectedType,ocrResults=[]){
  const text=normalizeOCR(raw); const lines=text.split(/\r?\n/).map(clean).filter(Boolean);
  const pan=findPAN(text), aadhaar=findAadhaar(text), mobile=findMobile(text,lines), dob=findDOB(text,lines), gender=findGender(text,lines);
  let documentType=selectedType; if(documentType==="auto")documentType=pan?"pan":(aadhaar?"aadhaar":"general");
  const name=findName(text,lines,dob,pan,documentType,ocrResults);
  const address=findAddress(lines);
  return {documentType:documentType==="pan"?"PAN":documentType==="aadhaar"?"Aadhaar":"General document",name,dob,gender,mobile,pan,aadhaar,address,other:lines.slice(0,100).join("\n")};
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