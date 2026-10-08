const $ = id => document.getElementById(id);
let stream = null, currentImage = null, records = [];
const DB_NAME = "smart_document_scanner", STORE = "records";

function setStatus(msg){ $("status").textContent = msg; }
function maskAadhaar(v){ const d=(v||"").replace(/\D/g,""); return d.length===12 ? "XXXX XXXX "+d.slice(-4) : v; }
function maskPan(v){ const x=(v||"").trim().toUpperCase(); return x.length===10 ? x.slice(0,2)+"XXXXX"+x.slice(-3) : v; }

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=e=>e.target.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true});
    req.onsuccess=e=>resolve(e.target.result); req.onerror=e=>reject(e);
  });
}
async function loadRecords(){
  const db=await openDB(); records=await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readonly"), req=tx.objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
  renderRecords();
}
async function addRecord(rec){
  const db=await openDB(); await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).add(rec);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  }); await loadRecords();
}
async function deleteRecord(id){
  const db=await openDB(); await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).delete(id);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  }); await loadRecords();
}
async function clearRecords(){
  const db=await openDB(); await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).clear();
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  }); await loadRecords();
}

function renderRecords(){
  $("recordCount").textContent=records.length;
  const body=$("recordsBody");
  if(!records.length){body.innerHTML='<tr><td colspan="9" class="empty">No records yet.</td></tr>';return;}
  body.innerHTML=records.slice().reverse().map((r,i)=>`<tr>
    <td>${records.length-i}</td><td>${esc(r.documentType)}</td><td>${esc(r.name)}</td><td>${esc(r.dob)}</td>
    <td>${esc(r.mobile)}</td><td>${esc(r.pan)}</td><td>${esc(r.aadhaar)}</td><td>${new Date(r.savedAt).toLocaleString()}</td>
    <td><button class="danger-btn" onclick="removeRecord(${r.id})">Delete</button></td></tr>`).join("");
}
window.removeRecord=async id=>{if(confirm("Delete this record?")) await deleteRecord(id)};

function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

async function startCamera(){
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}},audio:false});
    $("video").srcObject=stream;$("video").style.display="block";$("placeholder").style.display="none";
    $("captureBtn").disabled=false;$("stopCamera").disabled=false;setStatus("Camera active. Place the document inside the frame.");
  }catch(e){setStatus("Camera access failed. Use Upload Image, or check browser camera permission and HTTPS.");}
}
function stopCamera(){
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  $("video").style.display="none";$("placeholder").style.display="block";$("captureBtn").disabled=true;$("stopCamera").disabled=true;
}
function capture(){
  const v=$("video"), c=$("canvas"); c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);
  c.toBlob(blob=>processImage(blob),"image/jpeg",.92);
}
$("startCamera").onclick=startCamera;$("stopCamera").onclick=stopCamera;$("captureBtn").onclick=capture;
$("fileInput").onchange=e=>{const f=e.target.files[0];if(f)processImage(f)};

async function processImage(blob){
  currentImage=blob;$("progressWrap").hidden=false;$("progress").style.width="2%";
  setStatus("Preparing image for OCR…");
  try{
    const worker=await Tesseract.createWorker("eng",1,{logger:m=>{
      if(m.status==="recognizing text") $("progress").style.width=Math.round((m.progress||0)*100)+"%";
      else if(m.status) setStatus("OCR: "+m.status);
    }});
    const result=await worker.recognize(blob); await worker.terminate();
    $("progress").style.width="100%"; setStatus("OCR complete. Extracting fields…");
    const text=result.data.text||"";
    const data=parseFields(text,$("docType").value);
    fillFields(data,text);
    $("confidenceBadge").textContent="OCR extracted";
    $("confidenceBadge").style.background="rgba(42,201,151,.12)";
    $("confidenceBadge").style.color="#67e0bb";
    $("saveBtn").disabled=false;$("saveExcelBtn").disabled=false;
    setStatus("Review the extracted values. Correct any OCR mistakes, then save.");
  }catch(e){console.error(e);setStatus("OCR failed: "+e.message)}
}

function cleanLine(x){return (x||"").replace(/\s+/g," ").trim()}
function parseFields(text,type){
  const lines=text.split(/\r?\n/).map(cleanLine).filter(Boolean), all=lines.join(" ");
  let doc=type;
  if(doc==="auto"){
    if(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/i.test(all)) doc="pan";
    else if(/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(all)||/aadhaar|unique identification/i.test(all)) doc="aadhaar";
    else doc="general";
  }
  const pan=(all.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/i)||[""])[0].toUpperCase();
  const aad=(all.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/)||[""])[0].replace(/\s/g,"");
  const mobile=(all.match(/(?:\+91[\s-]?)?[6-9]\d{9}\b/)||[""])[0].replace(/[^\d]/g,"").slice(-10);
  const date=(all.match(/\b(?:0?[1-9]|[12]\d|3[01])[\/.-](?:0?[1-9]|1[0-2])[\/.-](?:19|20)\d{2}\b/)||[""])[0];
  let gender=(all.match(/\b(MALE|FEMALE|OTHER)\b/i)||["",""])[1].toLowerCase();
  gender=gender?gender[0].toUpperCase()+gender.slice(1):"";
  let name="";
  const namePatterns=[/Name\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,60})/i,/Name of (?:the )?(?:card )?holder\s*[:\-]?\s*([A-Za-z][A-Za-z .'-]{2,60})/i];
  for(const p of namePatterns){const m=all.match(p);if(m){name=cleanLine(m[1]).replace(/\b(?:DOB|Date of Birth|Gender|Father|S\/O|D\/O|C\/O)\b.*$/i,"").trim();break}}
  if(!name && doc==="pan"){
    const idx=lines.findIndex(x=>/income tax|permanent account number|govt/i.test(x));
    if(idx>=0){for(const l of lines.slice(idx+1,idx+5)){if(/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(l)&&!/\d/.test(l)&&l.length<70){name=l;break}}}
  }
  if(!name && doc==="aadhaar"){
    const idx=lines.findIndex(x=>/aadhaar|government of india|unique identification/i.test(x));
    if(idx>=0){for(const l of lines.slice(idx+1,idx+6)){if(/^[A-Za-z][A-Za-z .'-]{2,60}$/.test(l)&&!/address|male|female|dob|year|government/i.test(l)){name=l;break}}}
  }
  let address="";
  const ai=lines.findIndex(x=>/^address\s*:?/i.test(x));
  if(ai>=0) address=lines.slice(ai+1,Math.min(ai+6,lines.length)).filter(x=>!/^(dob|date of birth|gender|mobile|phone|pan)\b/i.test(x)).join(", ");
  else {
    const candidates=lines.filter(x=>/\b\d{6}\b/.test(x)&&x.length>20);
    if(candidates.length) address=candidates[0];
  }
  const other=lines.filter(x=>![name,address].includes(x)).slice(0,18).join("\n");
  return {documentType:doc,name,dob:date,gender,mobile,pan,aadhaar:aad,address,other};
}
function fillFields(d,text){
  $("f_docType").value=d.documentType==="aadhaar"?"Aadhaar":d.documentType==="pan"?"PAN":"General document";
  $("f_name").value=d.name;$("f_dob").value=d.dob;$("f_gender").value=d.gender;$("f_mobile").value=d.mobile;
  $("f_pan").value=d.pan;$("f_aadhaar").value=d.aadhaar;$("f_address").value=d.address;$("f_other").value=d.other;
}
function getFormData(){
  const sensitive=$("storeSensitive").checked;
  const aad=$("f_aadhaar").value.trim(), pan=$("f_pan").value.trim().toUpperCase();
  return {documentType:$("f_docType").value,name:$("f_name").value.trim(),dob:$("f_dob").value.trim(),gender:$("f_gender").value.trim(),
    mobile:$("f_mobile").value.trim(),pan:sensitive?pan:maskPan(pan),aadhaar:sensitive?aad:maskAadhaar(aad),
    address:$("f_address").value.trim(),other:$("f_other").value.trim(),savedAt:new Date().toISOString()};
}
async function saveRecord(downloadExcel=false){
  const rec=getFormData(); if(!rec.name && !rec.pan && !rec.aadhaar){alert("Please scan a document or enter at least one identifying field.");return}
  await addRecord(rec); setStatus("Record saved locally.");
  if(downloadExcel) exportRows([rec],"document_record.xlsx");
  $("saveBtn").disabled=true;$("saveExcelBtn").disabled=true;
}
$("saveBtn").onclick=()=>saveRecord(false);$("saveExcelBtn").onclick=()=>saveRecord(true);
$("clearBtn").onclick=()=>{["f_name","f_dob","f_gender","f_mobile","f_pan","f_aadhaar","f_address","f_other"].forEach(id=>$(id).value="");$("f_docType").value="";$("confidenceBadge").textContent="Not scanned";$("saveBtn").disabled=true;$("saveExcelBtn").disabled=true;setStatus("Cleared.")};

function exportRows(rows,filename){
  if(!window.XLSX){alert("Excel library not loaded. Check your internet connection.");return}
  const cols=["Document Type","Full Name","Date of Birth","Gender","Mobile Number","PAN Number","Aadhaar Number","Address","Other Information","Saved At"];
  const data=rows.map(r=>[r.documentType,r.name,r.dob,r.gender,r.mobile,r.pan,r.aadhaar,r.address,r.other,r.savedAt]);
  const ws=XLSX.utils.aoa_to_sheet([cols,...data]); ws["!cols"]=[16,24,16,12,16,18,20,55,50,24].map(w=>({wch:w}));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Records");XLSX.writeFile(wb,filename);
}
$("exportBtn").onclick=()=>{if(!records.length){alert("No saved records.");return}exportRows(records,"document_records.xlsx")};
$("deleteAllBtn").onclick=async()=>{if(records.length&&confirm("Delete ALL locally saved records? This cannot be undone.")){await clearRecords();setStatus("All local records deleted.")}};
$("recordsBtn").onclick=()=>{ $("recordsPanel").scrollIntoView({behavior:"smooth"}) };
$("themeBtn").onclick=()=>{document.body.classList.toggle("light");localStorage.setItem("theme",document.body.classList.contains("light")?"light":"dark")};
if(localStorage.getItem("theme")==="light")document.body.classList.add("light");
$("year").textContent=new Date().getFullYear();loadRecords();
