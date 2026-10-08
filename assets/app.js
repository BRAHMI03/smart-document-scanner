(() => {
"use strict";
const $=id=>document.getElementById(id);let stream=null,records=[];
const msg=x=>$("status").textContent=x, esc=x=>String(x??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const maskA=x=>{let d=(x||"").replace(/\D/g,"");return d.length===12?"XXXX XXXX "+d.slice(-4):x||""};
const maskP=x=>{let p=(x||"").replace(/\s/g,"").toUpperCase();return p.length===10?p.slice(0,2)+"XXXXX"+p.slice(-3):p};
function db(){return new Promise((a,b)=>{let r=indexedDB.open("SmartDocScanner",1);r.onupgradeneeded=e=>e.target.result.createObjectStore("r",{keyPath:"id",autoIncrement:true});r.onsuccess=e=>a(e.target.result);r.onerror=()=>b(r.error)})}
async function load(){let d=await db();records=await new Promise((a,b)=>{let r=d.transaction("r","readonly").objectStore("r").getAll();r.onsuccess=()=>a(r.result);r.onerror=()=>b(r.error)});render()}
async function add(x){let d=await db();await new Promise((a,b)=>{let t=d.transaction("r","readwrite");t.objectStore("r").add(x);t.oncomplete=a;t.onerror=()=>b(t.error)});load()}
async function remove(id){let d=await db();await new Promise((a,b)=>{let t=d.transaction("r","readwrite");t.objectStore("r").delete(id);t.oncomplete=a;t.onerror=()=>b(t.error)});load()}
function render(){ $("recordCount").textContent=records.length;let b=$("recordsBody");if(!records.length){b.innerHTML='<tr><td colspan="9" class="empty">No records yet.</td></tr>';return}b.innerHTML=records.slice().reverse().map((r,i)=>`<tr><td>${records.length-i}</td><td>${esc(r.documentType)}</td><td>${esc(r.name)}</td><td>${esc(r.dob)}</td><td>${esc(r.mobile)}</td><td>${esc(r.pan)}</td><td>${esc(r.aadhaar)}</td><td>${esc(new Date(r.savedAt).toLocaleString())}</td><td><button class="danger-btn" data-id="${r.id}">Delete</button></td></tr>`).join("")}
$("recordsBody").onclick=e=>{let b=e.target.closest("[data-id]");if(b&&confirm("Delete this record?"))remove(+b.dataset.id)};

async function openCamera(){
 if(!window.isSecureContext){msg("Camera blocked. Open the HTTPS GitHub Pages URL.");return}
 if(!navigator.mediaDevices?.getUserMedia){msg("Camera API is unavailable. Use Upload Image instead.");return}
 try{stopCamera(false);stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}},audio:false});$("video").srcObject=stream;$("video").style.display="block";$("placeholder").style.display="none";$("captureBtn").disabled=false;$("stopCamera").disabled=false;await $("video").play();msg("Camera ready. Place the full document inside the frame.");}
 catch(e){let s=e.name==="NotAllowedError"?"Camera permission denied. Use the browser camera icon → Allow → reload.":e.name==="NotFoundError"?"No camera found. Use Upload Image.":e.name==="NotReadableError"?"Camera is busy in another app. Close other camera/video apps.":"Camera failed. Use Upload Image or reload the HTTPS page.";msg(s)}}
function stopCamera(show=true){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}$("video").srcObject=null;$("video").style.display="none";$("placeholder").style.display="grid";$("captureBtn").disabled=true;$("stopCamera").disabled=true;if(show)msg("Camera stopped.")}
function capture(){let v=$("video"),c=$("canvas");if(!v.videoWidth){msg("Camera is not ready yet.");return}c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);c.toBlob(b=>b&&scan(b),"image/jpeg",.95)}
$("startCamera").onclick=openCamera;$("stopCamera").onclick=()=>stopCamera();$("captureBtn").onclick=capture;$("fileInput").onchange=e=>{let f=e.target.files?.[0];if(f)scan(f)};

async function scan(blob){
 $("progressWrap").hidden=false;$("progress").style.width="5%";msg("Starting OCR…");
 try{
  if(!window.Tesseract)throw Error("OCR library failed to load. Check internet and reload.");
  let u=URL.createObjectURL(blob);if($("preview")){$("preview").src=u;$("preview").style.display="block"}
  let w=await Tesseract.createWorker("eng",1,{logger:m=>{if(m.status==="recognizing text"){$("progress").style.width=(20+Math.round((m.progress||0)*75))+"%";msg("Reading document… "+Math.round((m.progress||0)*100)+"%")}}});
  let r=await w.recognize(blob);await w.terminate();let t=r.data.text||"";if(!t.trim())throw Error("No readable text found. Retake with bright light, less glare, and the whole document visible.");
  let d=parse(t,$("docType").value);fill(d);$("confidenceBadge").textContent="OCR complete";$("saveBtn").disabled=false;$("saveExcelBtn").disabled=false;$("progress").style.width="100%";msg("OCR complete. Review every field before saving.");
 }catch(e){console.error(e);$("confidenceBadge").textContent="Scan failed";msg(e.message||"Scanning failed.")}
 finally{setTimeout(()=>$("progressWrap").hidden=true,700)}
}
function parse(t,type){
 let l=t.split(/\r?\n/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean),a=l.join(" ");
 let pan=(a.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/i)||[""])[0].toUpperCase(),aad=(a.match(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/)||[""])[0].replace(/\D/g,"");
 let doc=type==="auto"?(pan?"pan":(aad||/aadhaar|unique identification/i.test(a)?"aadhaar":"general")):type;
 let mobile=(a.match(/(?:\+91[\s-]?)?[6-9]\d{9}\b/)||[""])[0].replace(/\D/g,"").slice(-10);
 let dob=(a.match(/\b(?:0?[1-9]|[12]\d|3[01])[\/.-](?:0?[1-9]|1[0-2])[\/.-](?:19|20)\d{2}\b/)||[""])[0];
 let gender=(a.match(/\b(MALE|FEMALE|OTHER)\b/i)||["",""])[1]||"",name="";
 let m=a.match(/Name\s*(?:of (?:the )?(?:card )?holder)?\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,70})/i);if(m)name=m[1].trim();
 if(!name){let i=l.findIndex(x=>/permanent account number|income tax|aadhaar|government of india|unique identification/i.test(x));for(let x of l.slice(Math.max(0,i+1),i+8))if(/^[A-Za-z][A-Za-z .'-]{2,65}$/.test(x)&&!/government|income tax|permanent|aadhaar|unique|address|male|female|date|birth|year/i.test(x)){name=x;break}}
 let address="",i=l.findIndex(x=>/^address\s*[:\-]?/i.test(x));if(i>=0)address=l.slice(i+1,i+7).join(", ");else{let x=l.find(x=>x.length>20&&/\b\d{6}\b/.test(x));if(x)address=x}
 return{documentType:doc,name,dob,gender,mobile,pan,aadhaar:aad,address,other:l.slice(0,25).join("\n")};
}
function fill(d){$("f_docType").value=d.documentType==="aadhaar"?"Aadhaar":d.documentType==="pan"?"PAN":"General document";$("f_name").value=d.name;$("f_dob").value=d.dob;$("f_gender").value=d.gender;$("f_mobile").value=d.mobile;$("f_pan").value=d.pan;$("f_aadhaar").value=d.aadhaar;$("f_address").value=d.address;$("f_other").value=d.other}
function data(){let full=$("storeSensitive").checked,p=$("f_pan").value.trim().toUpperCase(),a=$("f_aadhaar").value.trim();return{documentType:$("f_docType").value,name:$("f_name").value.trim(),dob:$("f_dob").value.trim(),gender:$("f_gender").value.trim(),mobile:$("f_mobile").value.trim(),pan:full?p:maskP(p),aadhaar:full?a:maskA(a),address:$("f_address").value.trim(),other:$("f_other").value.trim(),savedAt:new Date().toISOString()}}
async function save(excel=false){let r=data();if(!r.name&&!r.pan&&!r.aadhaar&&!r.address){alert("Scan a document or enter at least one field.");return}await add(r);msg("Record saved successfully.");$("saveBtn").disabled=$("saveExcelBtn").disabled=true;if(excel)excel([r],"document_record.xlsx")}
$("saveBtn").onclick=()=>save(false);$("saveExcelBtn").onclick=()=>save(true);
$("clearBtn").onclick=()=>{["f_docType","f_name","f_dob","f_gender","f_mobile","f_pan","f_aadhaar","f_address","f_other"].forEach(id=>$(id).value="");$("confidenceBadge").textContent="Not scanned";$("saveBtn").disabled=$("saveExcelBtn").disabled=true;msg("Ready for another document.")};
function excel(rows,name){if(!window.XLSX){alert("Excel library failed to load. Reload the page.");return}let a=[["Document Type","Full Name","Date of Birth","Gender","Mobile Number","PAN Number","Aadhaar Number","Address","Other Information","Saved At"],...rows.map(r=>[r.documentType,r.name,r.dob,r.gender,r.mobile,r.pan,r.aadhaar,r.address,r.other,r.savedAt])],ws=XLSX.utils.aoa_to_sheet(a),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Records");XLSX.writeFile(wb,name)}
$("exportBtn").onclick=()=>records.length?excel(records,"document_records.xlsx"):alert("No records yet.");
$("deleteAllBtn").onclick=async()=>{if(confirm("Delete all saved records?")){let d=await db();await new Promise((a,b)=>{let t=d.transaction("r","readwrite");t.objectStore("r").clear();t.oncomplete=a;t.onerror=()=>b(t.error)});load()}};
$("recordsBtn").onclick=()=>$("recordsPanel").scrollIntoView({behavior:"smooth"});$("themeBtn").onclick=()=>{document.body.classList.toggle("light");localStorage.setItem("sds-theme",document.body.classList.contains("light")?"light":"dark")};if(localStorage.getItem("sds-theme")==="light")document.body.classList.add("light");$("year").textContent=new Date().getFullYear();load().catch(e=>msg("Browser storage error: "+e.message));
})();