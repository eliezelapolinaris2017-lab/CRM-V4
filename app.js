const HUB_URL = "https://eliezelapolinaris2017-lab.github.io/oasis-hub/";
const LEGACY_KEY = "oasis_crm_pro_v2";
const PIN_KEY = "oasis_crm_pin_v1";
const SESSION_UNLOCK_KEY = "oasis_crm_pin_session_v1";
const IDB_NAME = "oasis_crm_pro_v3"; // se mantiene para no romper data existente
const IDB_VERSION = 1;
const DB_STORES = ["clients", "visits"];

const firebaseConfig = {
  apiKey: "AIzaSyBm67RjL0QzMRLfo6zUYCI0bak1eGJAR-U",
  authDomain: "oasis-facturacion.firebaseapp.com",
  projectId: "oasis-facturacion",
  storageBucket: "oasis-facturacion.firebasestorage.app",
  messagingSenderId: "84422038905",
  appId: "1:84422038905:web:b0eef65217d2bfc3298ba8"
};

const OWNER_EMAIL = "nexustoolspr@gmail.com";
const AUTO_SYNC_ENABLED = true;
const AUTO_SYNC_INTERVAL_MS = 3 * 60 * 1000;
const AUTO_SYNC_DEBOUNCE_MS = 1200;
const FOLLOWUP_DAYS = 90;
const APP_VERSION = "V4.5.2";
const DELETED_KEY = "oasis_crm_deleted_v1";
const DIRTY_KEY = "oasis_crm_dirty_v1";
const VISIT_CATALOG_KEY = "oasis_crm_visit_catalog_v1";

let fbApp = null, fbAuth = null, fbDB = null;
let _syncTimer = null, _syncDebounce = null, _syncRunning = false, _syncPending = false;

const state = {
  activeView: "dashboard",
  activeClientId: null,
  editingVisitId: null,
  pinBuffer: "",
  pinMode: "unlock",
  timelineLimit: 100,
  db: { clients: [], visits: [] },
  indexes: null,
  visitCatalog: null
};

const $ = (id) => document.getElementById(id);
const money = (n) => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const uid = (p = "id") => `${p}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoNow = () => new Date().toISOString();
const daysBetween = (a, b = todayISO()) => Math.floor((new Date(b) - new Date(a)) / 86400000);
const addDaysISO = (date, days) => { const d = new Date(date || todayISO()); d.setDate(d.getDate() + days); return d.toISOString().slice(0,10); };

function stampToMillis(v){
  if(!v) return 0;
  if(typeof v === "number") return v;
  if(typeof v === "string"){
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  if(typeof v?.toDate === "function"){
    const t = v.toDate().getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  if(typeof v?.seconds === "number") return (v.seconds * 1000) + Math.floor((v.nanoseconds || 0) / 1000000);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}
function stampToISO(v){
  const ms = stampToMillis(v);
  return ms ? new Date(ms).toISOString() : isoNow();
}
function isRemoteNewer(remote, local){
  const rt = stampToMillis(remote?.updatedAt || remote?.createdAt);
  const lt = stampToMillis(local?.updatedAt || local?.createdAt);
  return rt > lt;
}

function escapeHtml(s){return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}

function getDeletedMap(){try{return JSON.parse(localStorage.getItem(DELETED_KEY)||"{}");}catch(e){return {};}}
function saveDeletedMap(map){localStorage.setItem(DELETED_KEY, JSON.stringify(map||{}));}
function markDeleted(store,id){if(!id)return; const map=getDeletedMap(); if(!map[store])map[store]={}; map[store][id]=isoNow(); saveDeletedMap(map);}
function isDeleted(store,id){const map=getDeletedMap(); return !!(map?.[store]?.[id]);}
function markClientDeletedWithVisits(clientId){markDeleted("clients",clientId); state.db.visits.filter(v=>v.clientId===clientId).forEach(v=>markDeleted("visits",v.id));}
function getDirtyMap(){try{return JSON.parse(localStorage.getItem(DIRTY_KEY)||"{}");}catch(e){return {};}}
function saveDirtyMap(map){localStorage.setItem(DIRTY_KEY, JSON.stringify(map||{}));}
function markDirty(store,id,stamp=isoNow()){if(!id)return; const map=getDirtyMap(); if(!map[store])map[store]={}; map[store][id]=stamp; saveDirtyMap(map);}
function clearDirty(store,id){const map=getDirtyMap(); if(map?.[store]?.[id]){delete map[store][id]; saveDirtyMap(map);}}
function isDirty(store,id){const map=getDirtyMap(); return !!(map?.[store]?.[id]);}
function hasDirtyRecords(){const map=getDirtyMap(); return !!(Object.keys(map.clients||{}).length || Object.keys(map.visits||{}).length);}
function setText(id,text){const el=$(id); if(el) el.textContent=text;}
function safeVal(id){return $(id)?.value || "";}

function defaultVisitCatalog(){
  return {
    services:[
      "Mantenimiento preventivo",
      "Mantenimiento profundo",
      "Diagnóstico técnico",
      "Reparación",
      "Instalación",
      "Cotización",
      "Lavado de evaporador",
      "Limpieza de drenaje",
      "Reemplazo de capacitor",
      "Carga / verificación de refrigerante"
    ],
    equipment:["Midea","AirMax","Gree","TGM","Fujitsu","Daikin","Carrier","LG","Samsung","York","Mini split","PTAC","Aire de ventana","Manejadora de ductos"],
    models:["9K BTU","12K BTU","18K BTU","24K BTU","30K BTU","36K BTU","42K BTU","48K BTU","60K BTU","Inverter","R32","R410A"],
    technicians:["Eliezel","Oasis Técnico","Técnico 1","Técnico 2"]
  };
}
function cleanList(arr){
  const seen=new Set();
  return (Array.isArray(arr)?arr:String(arr||"").split("\n"))
    .map(x=>String(x||"").trim())
    .filter(Boolean)
    .filter(x=>{const k=x.toLowerCase(); if(seen.has(k))return false; seen.add(k); return true;});
}
function normalizeVisitCatalog(cat){
  const base=defaultVisitCatalog();
  return {
    services:cleanList(cat?.services?.length?cat.services:base.services),
    equipment:cleanList(cat?.equipment?.length?cat.equipment:base.equipment),
    models:cleanList(cat?.models?.length?cat.models:base.models),
    technicians:cleanList(cat?.technicians?.length?cat.technicians:base.technicians)
  };
}
function loadVisitCatalog(){
  try{state.visitCatalog=normalizeVisitCatalog(JSON.parse(localStorage.getItem(VISIT_CATALOG_KEY)||"{}"));}
  catch(e){state.visitCatalog=normalizeVisitCatalog(defaultVisitCatalog());}
}
function saveVisitCatalogLocal(cat=state.visitCatalog){
  state.visitCatalog=normalizeVisitCatalog(cat);
  localStorage.setItem(VISIT_CATALOG_KEY, JSON.stringify(state.visitCatalog));
}
function optionHtml(list, placeholder="Seleccionar"){
  return `<option value="">${escapeHtml(placeholder)}</option>` + cleanList(list).map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}
function ensureSelectValue(selectId, value){
  const el=$(selectId); if(!el)return;
  const val=String(value||"").trim();
  if(val && ![...el.options].some(o=>o.value===val)){
    const opt=document.createElement("option"); opt.value=val; opt.textContent=val; el.appendChild(opt);
  }
  el.value=val;
}
function populateVisitDropdowns(){
  const cat=normalizeVisitCatalog(state.visitCatalog||defaultVisitCatalog());
  if($("vService")) $("vService").innerHTML=optionHtml(cat.services,"Servicio");
  if($("vEquipment")) $("vEquipment").innerHTML=optionHtml(cat.equipment,"Equipo / Marca");
  if($("vModel")) $("vModel").innerHTML=optionHtml(cat.models,"BTU / Modelo");
  if($("vTechnician")) $("vTechnician").innerHTML=optionHtml(cat.technicians,"Técnico");
}
function renderVisitCatalogSettings(){
  const cat=normalizeVisitCatalog(state.visitCatalog||defaultVisitCatalog());
  if($("catServices")) $("catServices").value=cat.services.join("\n");
  if($("catEquipment")) $("catEquipment").value=cat.equipment.join("\n");
  if($("catModels")) $("catModels").value=cat.models.join("\n");
  if($("catTechnicians")) $("catTechnicians").value=cat.technicians.join("\n");
}
function readVisitCatalogSettings(){
  return normalizeVisitCatalog({
    services: ($("catServices")?.value||"").split("\n"),
    equipment: ($("catEquipment")?.value||"").split("\n"),
    models: ($("catModels")?.value||"").split("\n"),
    technicians: ($("catTechnicians")?.value||"").split("\n")
  });
}
async function saveVisitCatalogFromSettings(){
  saveVisitCatalogLocal(readVisitCatalogSettings());
  populateVisitDropdowns();
  renderVisitCatalogSettings();
  if(canAutoSync()) await pushVisitCatalogToFirebase().catch(console.error);
  alert("Categorías guardadas ✅");
}
async function pullVisitCatalogFromFirebase(uidVal){
  if(!fbDB||!uidVal)return;
  try{
    const snap=await metaRef(uidVal).get();
    const remote=snap.exists ? snap.data()?.visitCatalog : null;
    if(remote){saveVisitCatalogLocal(remote); populateVisitDropdowns(); renderVisitCatalogSettings();}
  }catch(e){console.error("catalog pull", e);}
}
async function pushVisitCatalogToFirebase(){
  const user=fbUser(); if(!user||!requireOwner(user))return;
  await metaRef(user.uid).set({visitCatalog: normalizeVisitCatalog(state.visitCatalog||defaultVisitCatalog()), visitCatalogUpdatedAt: isoNow()},{merge:true});
}

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(IDB_NAME,IDB_VERSION);r.onupgradeneeded=()=>{const db=r.result;DB_STORES.forEach(s=>{if(!db.objectStoreNames.contains(s))db.createObjectStore(s,{keyPath:"id"});});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function idbGetAll(storeName){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(storeName,"readonly");const req=tx.objectStore(storeName).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});}
async function idbPutMany(storeName,items){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(storeName,"readwrite");const store=tx.objectStore(storeName);items.forEach(item=>store.put(item));tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);});}
async function idbDelete(storeName,id){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(storeName,"readwrite");tx.objectStore(storeName).delete(id);tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);});}
async function idbClearAll(){const db=await openDB();await Promise.all(DB_STORES.map(storeName=>new Promise((resolve,reject)=>{const tx=db.transaction(storeName,"readwrite");tx.objectStore(storeName).clear();tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);})));}

function normalizeDB(db){
  db = db && typeof db === "object" ? db : {clients:[], visits:[]};
  db.clients = Array.isArray(db.clients) ? db.clients : [];
  db.visits = Array.isArray(db.visits) ? db.visits : [];
  const now = isoNow();
  db.clients = db.clients.map(c=>({
    id: c.id || uid("c"),
    name: String(c.name || "Cliente").trim() || "Cliente",
    contact: String(c.contact || "").trim(),
    addr: String(c.addr || "").trim(),
    status: ["Prospecto","Activo","VIP","Pausado"].includes(c.status) ? c.status : "Prospecto",
    tags: Array.isArray(c.tags) ? c.tags.map(x=>String(x).trim()).filter(Boolean) : String(c.tags||"").split(",").map(x=>x.trim()).filter(Boolean),
    note: String(c.note || "").trim(),
    createdAt: stampToISO(c.createdAt || now),
    updatedAt: stampToISO(c.updatedAt || c.createdAt || now)
  }));
  const clientIds = new Set(db.clients.map(c=>c.id));
  db.visits = db.visits.map(v=>({
    id: v.id || uid("v"),
    clientId: String(v.clientId || ""),
    date: v.date || todayISO(),
    amount: Number(v.amount || 0),
    service: String(v.service || "Servicio").trim() || "Servicio",
    type: normalizeVisitType(v.type || guessType(v.service)),
    paymentStatus: String(v.paymentStatus || (Number(v.amount||0)>0 ? "Pagado" : "No aplica")),
    equipment: String(v.equipment || "").trim(),
    model: String(v.model || "").trim(),
    technician: String(v.technician || "").trim(),
    outcome: String(v.outcome || "Completado"),
    nextDate: isValidISODate(v.nextDate) ? v.nextDate : inferNextDate({ ...v, type: normalizeVisitType(v.type || guessType(v.service)) }),
    followedUp: v.followedUp === true || v.followedUp === "yes" ? "yes" : "no",
    note: String(v.note || "").trim(),
    createdAt: stampToISO(v.createdAt || now),
    updatedAt: stampToISO(v.updatedAt || v.createdAt || now)
  })).filter(v=>clientIds.has(v.clientId));
  return db;
}
function normalizeVisitType(type=""){
  const t=String(type||"").trim().toLowerCase();
  if(t.includes("diag")||t.includes("evalu"))return"Diagnóstico";
  if(t.includes("cot")||t.includes("estim"))return"Cotización";
  if(t.includes("instal"))return"Instalación";
  if(t.includes("repar"))return"Reparación";
  if(t.includes("cobro"))return"Cobro";
  if(t.includes("mant")||t.includes("limpieza")||t.includes("preventivo")||t.includes("profundo"))return"Mantenimiento";
  return "Servicio";
}
function guessType(service=""){
  const s=String(service||"").toLowerCase();
  if(s.includes("diagn")||s.includes("diag")||s.includes("evalu"))return"Diagnóstico";
  if(s.includes("cot")||s.includes("estim"))return"Cotización";
  if(s.includes("instal"))return"Instalación";
  if(s.includes("repar"))return"Reparación";
  if(s.includes("cobro"))return"Cobro";
  if(s.includes("mant")||s.includes("limpieza")||s.includes("preventivo")||s.includes("profundo"))return"Mantenimiento";
  return"Servicio";
}
function inferNextDate(v){
  const type = normalizeVisitType(v.type || guessType(v.service));
  if(type==="Mantenimiento") return addDaysISO(v.date || todayISO(), FOLLOWUP_DAYS);
  if(type==="Instalación") return addDaysISO(v.date || todayISO(), 30);
  return "";
}
function isValidISODate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||"")) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());}
function visitSortValue(v){return String(v?.date || v?.updatedAt || v?.createdAt || "");}
function sortVisitsNewestFirst(items=[]){
  return [...items].sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")) || String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")));
}
function getLatestVisitByType(clientId,type){
  return sortVisitsNewestFirst(state.db.visits.filter(v=>v.clientId===clientId && String(v.outcome||"")!=="Cancelado" && normalizeVisitType(v.type)===type))[0] || null;
}
function getLatestMaintenance(clientId){return getLatestVisitByType(clientId,"Mantenimiento");}
function getMaintenanceNextDate(clientId){
  const latest = getLatestMaintenance(clientId);
  if(!latest) return "";
  if(isValidISODate(latest.nextDate)) return latest.nextDate;
  return inferNextDate(latest);
}
function getClientNextDateFromVisits(items=[]){
  const latest = sortVisitsNewestFirst(items.filter(v=>normalizeVisitType(v.type)==="Mantenimiento"))[0];
  if(!latest) return "";
  if(isValidISODate(latest.nextDate)) return latest.nextDate;
  return inferNextDate(latest);
}
function buildIndexes(db){
  const clientsById=new Map(), visitsByClient=new Map(), totalsByClient=new Map();
  db.clients.forEach(c=>clientsById.set(c.id,c));
  db.visits.forEach(v=>{if(!visitsByClient.has(v.clientId))visitsByClient.set(v.clientId,[]);visitsByClient.get(v.clientId).push(v);});
  visitsByClient.forEach((items,cid)=>{
    items.sort((a,b)=>String(b.date).localeCompare(String(a.date))||visitSortValue(b).localeCompare(visitSortValue(a)));
    const total=items.reduce((a,v)=>a+Number(v.amount||0),0);
    const pending=items.filter(v=>["Pendiente","Parcial"].includes(v.paymentStatus)).reduce((a,v)=>a+Number(v.amount||0),0);
    const next=getClientNextDateFromVisits(items.filter(v=>normalizeVisitType(v.type)==="Mantenimiento"));
    totalsByClient.set(cid,{total,pending,count:items.length,last:items[0]?.date||"",next});
  });
  return {clientsById,visitsByClient,totalsByClient};
}
async function persistState(){state.db=normalizeDB(state.db);state.indexes=buildIndexes(state.db);await Promise.all([idbPutMany("clients",state.db.clients),idbPutMany("visits",state.db.visits)]);scheduleDebouncedSync("local-change");}
async function loadStateFromIndexedDB(){const [clients,visits]=await Promise.all([idbGetAll("clients"),idbGetAll("visits")]);state.db=normalizeDB({clients,visits});state.indexes=buildIndexes(state.db);}
async function importLegacyIfNeeded(force=false){const raw=localStorage.getItem(LEGACY_KEY); if(!raw)return false; if((state.db.clients.length||state.db.visits.length)&&!force)return false; try{state.db=normalizeDB(JSON.parse(raw)); state.indexes=buildIndexes(state.db); await persistState(); return true;}catch(e){console.error(e); return false;}}
function clientTotals(id){return state.indexes?.totalsByClient.get(id)||{total:0,pending:0,count:0,last:"",next:""};}
function badge(status){if(status==="VIP")return`<span class="badge vip">VIP</span>`;if(status==="Activo")return`<span class="badge ok">Activo</span>`;if(status==="Prospecto")return`<span class="badge warn">Prospecto</span>`;return`<span class="badge">Pausado</span>`;}
function payBadge(status){if(status==="Pagado")return`<span class="badge ok">Pagado</span>`;if(status==="Pendiente"||status==="Parcial")return`<span class="badge warn">${escapeHtml(status)}</span>`;if(status==="Cotizado")return`<span class="badge vip">Cotizado</span>`;return`<span class="badge">${escapeHtml(status||"—")}</span>`;}

function visitDateValue(v){
  return String(v?.date || v?.updatedAt || v?.createdAt || "");
}
function isActiveVisit(v){
  return String(v?.outcome || "") !== "Cancelado";
}
function isPaymentOpen(v){
  return ["Pendiente", "Parcial"].includes(String(v?.paymentStatus || "")) || String(v?.outcome || "") === "Requiere cobro";
}
function isQuoteOpen(v){
  const type = normalizeVisitType(v?.type || guessType(v?.service));
  return type === "Cotización" || String(v?.paymentStatus || "") === "Cotizado" || String(v?.outcome || "") === "Requiere cotización";
}
function isDiagnosticOpen(v){
  const type = normalizeVisitType(v?.type || guessType(v?.service));
  return type === "Diagnóstico" && v?.followedUp !== "yes" && !isQuoteOpen(v) && !isPaymentOpen(v);
}
function latestByPredicate(visits, predicate){
  return sortVisitsNewestFirst(visits.filter(predicate))[0] || null;
}
function hasNewerVisitThan(visits, baseVisit){
  if(!baseVisit) return false;
  const base = [String(baseVisit.date || ""), String(baseVisit.updatedAt || baseVisit.createdAt || "")].join("|");
  return visits.some(v => {
    if(v.id === baseVisit.id) return false;
    const cur = [String(v.date || ""), String(v.updatedAt || v.createdAt || "")].join("|");
    return cur > base;
  });
}
function getOpenBalanceRows(activeVisits){
  const open = activeVisits.filter(isPaymentOpen);
  if(!open.length) return [];
  const byClientDoc = sortVisitsNewestFirst(open).slice(0, 1);
  return byClientDoc;
}
function getClientOperationalFollowup(client, activeVisits){
  const today = todayISO();
  const latest = activeVisits[0] || null;
  const latestType = normalizeVisitType(latest?.type || guessType(latest?.service));

  if(latest && isQuoteOpen(latest)){
    return {
      kind:"quote",
      priority:daysBetween(latest.date) > 7 ? "high" : "med",
      client,
      visit:latest,
      lastDate:latest.date,
      reason:latest.service || "Cotización pendiente",
      action:"Cotización"
    };
  }

  if(latest && isDiagnosticOpen(latest)){
    return {
      kind:"diagnostic",
      priority:daysBetween(latest.date) > 3 ? "high" : "med",
      client,
      visit:latest,
      lastDate:latest.date,
      reason:`Diagnóstico pendiente · ${latest.service || "Seguimiento"}`,
      action:"Diagnóstico"
    };
  }

  const latestMaintenance = latestByPredicate(activeVisits, v => normalizeVisitType(v.type || guessType(v.service)) === "Mantenimiento");
  if(latestMaintenance && !hasNewerVisitThan(activeVisits, latestMaintenance)){
    const next = isValidISODate(latestMaintenance.nextDate) ? latestMaintenance.nextDate : inferNextDate(latestMaintenance);
    if(next && next < today){
      return {
        kind:"due",
        priority:daysBetween(latestMaintenance.date) > 150 ? "high" : "med",
        client,
        visit:latestMaintenance,
        lastDate:latestMaintenance.date || "—",
        reason:`Mantenimiento vencido: ${next}`,
        action:"Mantenimiento"
      };
    }
    if(client.status === "VIP" && next && next >= today && next <= addDaysISO(today, 14)){
      return {
        kind:"vip",
        priority:"med",
        client,
        visit:latestMaintenance,
        lastDate:latestMaintenance.date || "—",
        reason:`Próxima: ${next}`,
        action:"Coordinar"
      };
    }
  }

  if(latest && String(latest.outcome || "") === "Requiere seguimiento"){
    return {
      kind: latestType === "Diagnóstico" ? "diagnostic" : latestType === "Cotización" ? "quote" : "vip",
      priority:daysBetween(latest.date) > 7 ? "high" : "med",
      client,
      visit:latest,
      lastDate:latest.date,
      reason:latest.service || "Requiere seguimiento",
      action:"Seguimiento"
    };
  }

  return null;
}
function getFollowups(){
  const rows=[];
  state.db.clients.forEach(client=>{
    if(client.status === "Pausado") return;
    const activeVisits = sortVisitsNewestFirst((state.indexes.visitsByClient.get(client.id)||[]).filter(isActiveVisit));
    if(!activeVisits.length) return;

    getOpenBalanceRows(activeVisits).forEach(v=>rows.push({
      kind:"payment",
      priority:"high",
      client,
      visit:v,
      lastDate:v.date,
      reason:`${v.paymentStatus} · ${money(v.amount)}`,
      action:"Cobro"
    }));

    const operational = getClientOperationalFollowup(client, activeVisits);
    if(operational) rows.push(operational);
  });

  const seen=new Set();
  const rank={high:0,med:1,low:2};
  return rows
    .filter(r=>{const key=[r.kind,r.client.id].join("|"); if(seen.has(key))return false; seen.add(key); return true;})
    .sort((a,b)=>rank[a.priority]-rank[b.priority] || String(b.lastDate).localeCompare(String(a.lastDate)));
}

function priorityPill(p){return `<span class="priority ${p}">${p==="high"?"Alta":p==="med"?"Media":"Baja"}</span>`;}
function globalFilterTokens(){return (safeVal("globalSearch")||"").trim().toLowerCase();}
function passesGlobal(client, visits=[]){const q=globalFilterTokens(); if(!q)return true; const hay=[client.name,client.contact,client.addr,client.note,(client.tags||[]).join(" "),...visits.flatMap(v=>[v.service,v.note,v.type,v.paymentStatus,v.equipment,v.model,v.technician,String(v.amount),v.date])].join(" ").toLowerCase(); return hay.includes(q);}

function setView(view){state.activeView=view;document.querySelectorAll(".view").forEach(el=>el.classList.remove("is-active"));document.querySelectorAll(".navBtn").forEach(el=>el.classList.remove("is-active"));$(`view-${view}`)?.classList.add("is-active");document.querySelector(`.navBtn[data-view="${view}"]`)?.classList.add("is-active");const names={dashboard:"Dashboard",clients:"Clientes",followups:"Seguimientos",timeline:"Timeline",reporting:"Reporte",settings:"Config"};setText("pageTitle",names[view]||"Oasis CRM Pro");if(view==="settings")renderVisitCatalogSettings();refreshAll();}
function renderDashboard(){const clients=state.db.clients, visits=state.db.visits, followups=getFollowups(); const active=clients.filter(c=>c.status==="Activo"||c.status==="VIP").length; const revenue=visits.reduce((a,v)=>a+Number(v.amount||0),0); const pending=visits.filter(v=>["Pendiente","Parcial"].includes(v.paymentStatus)).reduce((a,v)=>a+Number(v.amount||0),0); setText("kpiClients",clients.length); setText("kpiActiveClients",`${active} activos`); setText("kpiRevenue",money(revenue)); setText("kpiVisits",`${visits.length} visitas`); setText("kpiDue",followups.filter(f=>f.kind==="due").length); setText("kpiPending",money(pending)); const recent=[...visits].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8); setText("recentCountChip",`${recent.length} registros`); const body=$("recentActivityBody"); body.innerHTML=recent.length?"":`<tr><td colspan="5" class="muted">Sin actividad.</td></tr>`; recent.forEach(v=>{const c=state.indexes.clientsById.get(v.clientId); const tr=document.createElement("tr"); tr.innerHTML=`<td>${escapeHtml(v.date)}</td><td><strong>${escapeHtml(c?.name||"—")}</strong></td><td>${escapeHtml(v.service)}<span class="mutedLine">${escapeHtml(v.type)}</span></td><td>${payBadge(v.paymentStatus)}</td><td><strong>${money(v.amount)}</strong></td>`; body.appendChild(tr);}); const list=$("quickActionsList"); const top=followups.slice(0,7); list.innerHTML=top.length?"":`<div class="listItem"><div><strong>Sin pendientes</strong><small>Todo al día.</small></div></div>`; top.forEach(f=>{const div=document.createElement("div"); div.className="listItem"; div.innerHTML=`<div><strong>${escapeHtml(f.client.name)}</strong><small>${escapeHtml(f.reason)}</small></div>${priorityPill(f.priority)}`; list.appendChild(div);});}
function renderClients(){const q=safeVal("clientSearch").trim().toLowerCase(), status=safeVal("clientStatusFilter")||"all", sort=safeVal("clientSort")||"updated"; let rows=state.db.clients.map(client=>({client,stats:clientTotals(client.id),visits:state.indexes.visitsByClient.get(client.id)||[]})).filter(({client,visits})=>passesGlobal(client,visits)).filter(({client})=>!q||[client.name,client.contact,client.addr,client.note,(client.tags||[]).join(" ")].join(" ").toLowerCase().includes(q)).filter(({client})=>status==="all"||client.status===status); const dueIds=new Set(getFollowups().filter(f=>f.kind==="due"||f.kind==="payment").map(f=>f.client.id)); rows.sort((a,b)=>{if(sort==="name")return a.client.name.localeCompare(b.client.name); if(sort==="revenue")return b.stats.total-a.stats.total; if(sort==="last")return String(b.stats.last||"").localeCompare(String(a.stats.last||"")); if(sort==="due")return Number(dueIds.has(b.client.id))-Number(dueIds.has(a.client.id)); return String(b.client.updatedAt).localeCompare(String(a.client.updatedAt));}); setText("clientsCountChip",`${rows.length} clientes`); const body=$("clientsBody"); body.innerHTML=rows.length?"":`<tr><td colspan="6" class="muted">No hay resultados.</td></tr>`; rows.forEach(({client,stats})=>{const tr=document.createElement("tr"); tr.innerHTML=`<td><strong>${escapeHtml(client.name)}</strong><span class="mutedLine">${escapeHtml((client.tags||[]).join(", ")||"Sin tags")}</span></td><td>${badge(client.status)}</td><td>${escapeHtml(client.contact||"—")}</td><td>${escapeHtml(stats.last||"—")}</td><td><strong>${money(stats.total)}</strong></td><td><div class="aBtns"><button class="aBtn" data-open="${client.id}" type="button">Abrir</button><button class="aBtn danger" data-del="${client.id}" type="button">Borrar</button></div></td>`; body.appendChild(tr);}); body.querySelectorAll("[data-open]").forEach(btn=>btn.addEventListener("click",()=>openProfile(btn.dataset.open))); body.querySelectorAll("[data-del]").forEach(btn=>btn.addEventListener("click",()=>deleteClient(btn.dataset.del)));}
function openProfile(clientId){const client=state.indexes.clientsById.get(clientId); if(!client)return; state.activeClientId=clientId; $("emptyProfileState")?.classList.add("hidden"); $("clientProfile")?.classList.remove("hidden"); const stats=clientTotals(clientId); setText("pName",client.name); setText("profileSub",client.contact||client.addr||"Sin contacto"); setText("pLastVisit",stats.last||"—"); setText("pTotal",money(stats.total)); setText("pNextDue",stats.next||"—"); $("pNameInput").value=client.name||""; $("pContactInput").value=client.contact||""; $("pAddrInput").value=client.addr||""; $("pStatusInput").value=client.status||"Prospecto"; $("pTagsInput").value=(client.tags||[]).join(", "); $("pNoteInput").value=client.note||""; renderWhatsappActions(client); populateVisitClientSelect(clientId); renderVisits();}
function closeProfile(){state.activeClientId=null;$("clientProfile")?.classList.add("hidden");$("emptyProfileState")?.classList.remove("hidden");}
function renderWhatsappActions(client){const box=$("whatsappActions"); if(!box)return; const phone=cleanPhone(client.contact); const actions=[['mantenimiento','Recordar mantenimiento'],['diagnostico','Seguimiento diagnóstico'],['cotizacion','Cotización pendiente'],['cobro','Cobro pendiente'],['visita','Confirmar visita']]; box.innerHTML=actions.map(([kind,label])=>`<button class="whatsBtn" data-wa="${kind}" ${phone?'':'disabled'} type="button">${label}</button>`).join(""); box.querySelectorAll("[data-wa]").forEach(btn=>btn.addEventListener("click",()=>openWhatsApp(client,btn.dataset.wa)));}
function cleanPhone(v){const d=String(v||"").replace(/\D/g,""); if(d.length===10)return `1${d}`; if(d.length===11)return d; return d.length>=8?d:"";}
function waMessage(client,kind){const name=(client.name||"").split(" ")[0]||""; const link="https://confirmafy.com/oasis-services-pr"; const msgs={mantenimiento:`Saludos ${name}, le habla Oasis Services PR. Según nuestro historial, su unidad ya está próxima para mantenimiento. Puede agendar aquí: ${link}`,diagnostico:`Saludos ${name}, le habla Oasis Services PR. Le escribo para dar seguimiento al diagnóstico realizado y confirmar si desea continuar con la reparación o próxima acción recomendada.`,cotizacion:`Saludos ${name}, estamos dando seguimiento a la cotización pendiente. Podemos revisar disponibilidad y cerrar la fecha si desea continuar.`,cobro:`Saludos ${name}, aparece un balance pendiente relacionado al servicio realizado. Favor confirmar método de pago para cerrar el expediente.`,visita:`Saludos ${name}, le escribo para confirmar o coordinar su próxima visita de servicio con Oasis Services PR.`}; return msgs[kind]||msgs.visita;}
function openWhatsApp(client,kind){const phone=cleanPhone(client.contact); if(!phone)return alert("Este cliente no tiene teléfono válido."); window.open(`https://wa.me/${phone}?text=${encodeURIComponent(waMessage(client,kind))}`,"_blank");}
function renderVisits(){
  const body=$("visitsBody"), cid=state.activeClientId;
  if(!cid){body.innerHTML=`<tr><td colspan="7" class="muted">Selecciona un cliente.</td></tr>`;return;}
  const q=safeVal("visitSearch").trim().toLowerCase();
  const visits=[...(state.indexes.visitsByClient.get(cid)||[])]
    .filter(v=>!q||[v.service,v.note,v.type,v.equipment,v.model,v.paymentStatus,String(v.amount),v.date,v.nextDate].join(" ").toLowerCase().includes(q));
  body.innerHTML=visits.length?"":`<tr><td colspan="7" class="muted">Sin visitas.</td></tr>`;
  visits.forEach(v=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`<td>${escapeHtml(v.date)}</td><td><strong>${escapeHtml(v.service)}</strong><span class="mutedLine">${escapeHtml(v.type)}</span></td><td>${escapeHtml([v.equipment,v.model].filter(Boolean).join(" · ")||"—")}</td><td>${escapeHtml(v.nextDate||"—")}</td><td>${payBadge(v.paymentStatus)}</td><td><strong>${money(v.amount)}</strong></td><td><div class="aBtns"><button class="aBtn" data-edit="${v.id}" type="button">Editar</button><button class="aBtn danger" data-delv="${v.id}" type="button">Borrar</button></div></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-edit]").forEach(btn=>btn.addEventListener("click",()=>openVisitModal(btn.dataset.edit)));
  body.querySelectorAll("[data-delv]").forEach(btn=>btn.addEventListener("click",()=>deleteVisit(btn.dataset.delv)));
}
function renderFollowups(){const all=getFollowups(); const filter=safeVal("followupFilter")||"all"; const rows=all.filter(f=>filter==="all"||f.kind===filter); setText("fuDue",all.filter(f=>f.kind==="due").length); setText("fuQuotes",all.filter(f=>f.kind==="quote"||f.kind==="diagnostic").length); setText("fuPayments",all.filter(f=>f.kind==="payment").length); const body=$("followupsBody"); body.innerHTML=rows.length?"":`<tr><td colspan="6" class="muted">Sin seguimientos pendientes.</td></tr>`; rows.forEach(f=>{const tr=document.createElement("tr"); tr.innerHTML=`<td>${priorityPill(f.priority)}</td><td><strong>${escapeHtml(f.client.name)}</strong><span class="mutedLine">${escapeHtml(f.client.contact||"")}</span></td><td>${escapeHtml(f.lastDate||"—")}</td><td>${escapeHtml(f.reason)}</td><td>${escapeHtml(f.action)}</td><td><div class="aBtns"><button class="aBtn" data-open="${f.client.id}" type="button">Abrir</button><button class="aBtn" data-waid="${f.client.id}" data-kind="${f.kind}" type="button">WhatsApp</button></div></td>`; body.appendChild(tr);}); body.querySelectorAll("[data-open]").forEach(btn=>btn.addEventListener("click",()=>{setView("clients");openProfile(btn.dataset.open);})); body.querySelectorAll("[data-waid]").forEach(btn=>btn.addEventListener("click",()=>{const c=state.indexes.clientsById.get(btn.dataset.waid); const kindMap={payment:"cobro",quote:"cotizacion",diagnostic:"diagnostico",due:"mantenimiento",vip:"visita"}; openWhatsApp(c, kindMap[btn.dataset.kind]||"visita");}));}
function timelineRows(){const q=safeVal("timelineSearch").trim().toLowerCase(), from=safeVal("timelineFrom"), to=safeVal("timelineTo"); return state.db.visits.map(visit=>({visit,client:state.indexes.clientsById.get(visit.clientId)})).filter(x=>x.client).filter(({visit,client})=>passesGlobal(client,[visit])).filter(({visit,client})=>!q||[client.name,client.contact,visit.service,visit.note,visit.type,visit.equipment,visit.model,visit.paymentStatus,visit.date,String(visit.amount)].join(" ").toLowerCase().includes(q)).filter(({visit})=>!from||String(visit.date)>=from).filter(({visit})=>!to||String(visit.date)<=to).sort((a,b)=>String(b.visit.date).localeCompare(String(a.visit.date)));}
function renderTimeline(){const rows=timelineRows(); setText("timelineCountChip",`${rows.length} filas`); const body=$("timelineBody"); const visible=rows.slice(0,state.timelineLimit); body.innerHTML=visible.length?"":`<tr><td colspan="7" class="muted">Sin resultados.</td></tr>`; visible.forEach(({visit,client})=>{const tr=document.createElement("tr"); tr.innerHTML=`<td>${escapeHtml(visit.date)}</td><td><strong>${escapeHtml(client.name)}</strong></td><td>${escapeHtml(visit.service)}</td><td>${escapeHtml(visit.type)}</td><td>${escapeHtml([visit.equipment,visit.model].filter(Boolean).join(" · ")||"—")}</td><td>${payBadge(visit.paymentStatus)}</td><td><strong>${money(visit.amount)}</strong></td>`; body.appendChild(tr);}); if($("btnMoreTimeline")) $("btnMoreTimeline").style.display=rows.length>state.timelineLimit?"inline-flex":"none";}
function renderReporting(){const clients=state.db.clients, visits=state.db.visits; const revenue=visits.reduce((a,v)=>a+Number(v.amount||0),0); setText("repPros",clients.filter(c=>c.status==="Prospecto").length); setText("repAct",clients.filter(c=>c.status==="Activo"||c.status==="VIP").length); setText("repAvg",money(visits.length?revenue/visits.length:0)); const top=[...clients].map(client=>({client,stats:clientTotals(client.id)})).sort((a,b)=>b.stats.total-a.stats.total).slice(0,10); const topBody=$("topBody"); topBody.innerHTML=top.length?"":`<tr><td colspan="3" class="muted">Sin data.</td></tr>`; top.forEach(({client,stats})=>{const tr=document.createElement("tr"); tr.innerHTML=`<td><strong>${escapeHtml(client.name)}</strong></td><td><strong>${money(stats.total)}</strong></td><td>${escapeHtml(stats.last||"—")}</td>`; topBody.appendChild(tr);}); renderSummaryList("monthSummary", groupBy(visits, v=>String(v.date||"").slice(0,7)||"Sin fecha"), "visitas"); renderSummaryList("serviceSummary", groupBy(visits, v=>v.type||"Otro"), "visitas"); renderPaymentSummary();}
function groupBy(items,keyFn){const m=new Map(); items.forEach(v=>{const k=keyFn(v); if(!m.has(k))m.set(k,{amount:0,count:0}); const r=m.get(k); r.amount+=Number(v.amount||0); r.count++;}); return [...m.entries()].sort((a,b)=>b[1].amount-a[1].amount).slice(0,8);}
function renderSummaryList(id,rows,label){const box=$(id); box.innerHTML=rows.length?"":`<div class="listItem"><div><strong>Sin data</strong><small>No hay registros.</small></div></div>`; rows.forEach(([k,d])=>{const div=document.createElement("div");div.className="listItem";div.innerHTML=`<div><strong>${escapeHtml(k)}</strong><small>${d.count} ${label}</small></div><strong>${money(d.amount)}</strong>`;box.appendChild(div);});}
function renderPaymentSummary(){const rows=groupBy(state.db.visits,v=>v.paymentStatus||"No aplica"); renderSummaryList("paymentSummary",rows,"registros");}
function refreshAll(){renderDashboard();renderClients();renderFollowups();renderTimeline();renderReporting(); if(state.activeClientId){if(state.indexes.clientsById.has(state.activeClientId))openProfile(state.activeClientId);else closeProfile();}}
function populateVisitClientSelect(selectedId=state.activeClientId){const select=$("vClient"); if(!select)return; const current=selectedId||select.value; select.innerHTML=state.db.clients.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(""); if(current&&state.indexes.clientsById.has(current))select.value=current;}
function openClientModal(){["mName","mContact","mAddr","mTags","mNote"].forEach(id=>$(id).value="");$("mStatus").value="Prospecto";$("clientModal").style.display="flex";}
function closeClientModal(){$("clientModal").style.display="none";}
function openVisitModal(visitId=null,preferredClientId=state.activeClientId){state.editingVisitId=visitId; populateVisitClientSelect(preferredClientId); populateVisitDropdowns(); $("visitModal").style.display="flex"; setText("visitModalTitle",visitId?"Editar visita":"Nueva visita"); ["vService","vAmount","vEquipment","vModel","vTechnician","vNextDate","vNote"].forEach(id=>$(id).value=""); $("vDate").value=todayISO(); $("vType").value="Mantenimiento"; $("vPaymentStatus").value="Pagado"; $("vOutcome").value="Completado"; $("vFollowedUp").value="no"; if(visitId){const v=state.db.visits.find(x=>x.id===visitId); if(!v)return; $("vClient").value=v.clientId; $("vDate").value=v.date||todayISO(); $("vType").value=v.type||"Mantenimiento"; ensureSelectValue("vService", v.service||""); $("vAmount").value=v.amount??0; $("vPaymentStatus").value=v.paymentStatus||"Pagado"; ensureSelectValue("vEquipment", v.equipment||""); ensureSelectValue("vModel", v.model||""); ensureSelectValue("vTechnician", v.technician||""); $("vOutcome").value=v.outcome||"Completado"; $("vNextDate").value=v.nextDate||""; $("vFollowedUp").value=v.followedUp||"no"; $("vNote").value=v.note||"";}}
function closeVisitModal(){$("visitModal").style.display="none";state.editingVisitId=null;}
async function createClient(){const name=safeVal("mName").trim(); if(!name)return alert("Nombre requerido."); const now=isoNow(); const client={id:uid("c"),name,contact:safeVal("mContact").trim(),addr:safeVal("mAddr").trim(),status:safeVal("mStatus")||"Prospecto",tags:safeVal("mTags").split(",").map(x=>x.trim()).filter(Boolean),note:safeVal("mNote").trim(),createdAt:now,updatedAt:now}; state.db.clients.unshift(client); await persistState(); closeClientModal(); refreshAll(); setView("clients"); openProfile(client.id);}
async function saveClientEdits(){const c=state.db.clients.find(x=>x.id===state.activeClientId); if(!c)return; const now=isoNow(); c.name=safeVal("pNameInput").trim()||c.name; c.contact=safeVal("pContactInput").trim(); c.addr=safeVal("pAddrInput").trim(); c.status=safeVal("pStatusInput")||"Prospecto"; c.tags=safeVal("pTagsInput").split(",").map(x=>x.trim()).filter(Boolean); c.note=safeVal("pNoteInput").trim(); c.updatedAt=now; markDirty("clients", c.id, now); await persistState(); refreshAll(); openProfile(c.id); safeSyncNow("save-client");}
async function deleteClient(id){if(!id||!confirm("¿Borrar cliente y su historial?"))return; markClientDeletedWithVisits(id); state.db.clients=state.db.clients.filter(c=>c.id!==id); const visitIds=state.db.visits.filter(v=>v.clientId===id).map(v=>v.id); state.db.visits=state.db.visits.filter(v=>v.clientId!==id); await idbDelete("clients",id); for(const vid of visitIds)await idbDelete("visits",vid); state.indexes=buildIndexes(state.db); await deleteRemoteTombstones().catch(console.error); scheduleDebouncedSync("delete-client"); if(state.activeClientId===id)closeProfile(); refreshAll();}
async function saveVisit(){const clientId=safeVal("vClient"); if(!clientId)return alert("Selecciona un cliente."); const amount=Number(safeVal("vAmount")||0); if(Number.isNaN(amount))return alert("Monto inválido."); const now=isoNow(); const payload={clientId,date:safeVal("vDate")||todayISO(),type:normalizeVisitType(safeVal("vType")||"Mantenimiento"),service:safeVal("vService").trim()||"Servicio",amount,paymentStatus:safeVal("vPaymentStatus")||"Pagado",equipment:safeVal("vEquipment").trim(),model:safeVal("vModel").trim(),technician:safeVal("vTechnician").trim(),outcome:safeVal("vOutcome")||"Completado",nextDate:isValidISODate(safeVal("vNextDate"))?safeVal("vNextDate"):"",followedUp:safeVal("vFollowedUp")||"no",note:safeVal("vNote").trim(),updatedAt:now}; if(!payload.nextDate)payload.nextDate=inferNextDate(payload); let visitId=state.editingVisitId; if(visitId){const v=state.db.visits.find(x=>x.id===visitId); if(!v)return; Object.assign(v,payload);}else{visitId=uid("v"); state.db.visits.unshift({id:visitId,...payload,createdAt:now});} markDirty("visits", visitId, now); const c=state.db.clients.find(x=>x.id===clientId); if(c){c.updatedAt=now; markDirty("clients", c.id, now);} await persistState(); closeVisitModal(); refreshAll(); openProfile(clientId); safeSyncNow("save-visit");}
async function deleteVisit(id){if(!id||!confirm("¿Borrar visita?"))return; markDeleted("visits",id); state.db.visits=state.db.visits.filter(v=>v.id!==id); await idbDelete("visits",id); state.indexes=buildIndexes(state.db); await deleteRemoteTombstones().catch(console.error); scheduleDebouncedSync("delete-visit"); refreshAll(); if(state.activeClientId)openProfile(state.activeClientId);}
function exportJSONBackup(){const blob=new Blob([JSON.stringify({exportedAt:isoNow(),app:"oasis_crm_pro_v4",db:state.db},null,2)],{type:"application/json"}); downloadBlob(blob,`oasis_crm_v4_backup_${todayISO()}.json`);}
function exportCSV(name, rows){const csv=rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n"); downloadBlob(new Blob([csv],{type:"text/csv;charset=utf-8"}),`${name}_${todayISO()}.csv`);}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),700);}
async function restoreBackup(file){try{const data=JSON.parse(await file.text()); state.db=normalizeDB(data?.db||data); await idbClearAll(); await persistState(); closeProfile(); refreshAll(); alert("Backup restaurado ✅");}catch(e){console.error(e);alert("No se pudo restaurar el backup.");}}
async function resetAll(){if(!confirm("¿Borrar todo local?"))return; state.db.clients.forEach(c=>markDeleted("clients",c.id)); state.db.visits.forEach(v=>markDeleted("visits",v.id)); state.db={clients:[],visits:[]}; await idbClearAll(); state.indexes=buildIndexes(state.db); await deleteRemoteTombstones().catch(console.error); closeProfile(); refreshAll(); scheduleDebouncedSync("reset");}

function getStoredPin(){return localStorage.getItem(PIN_KEY)||"";} function setStoredPin(pin){localStorage.setItem(PIN_KEY,pin);} function setSessionUnlock(){sessionStorage.setItem(SESSION_UNLOCK_KEY,"1");} function clearSessionUnlock(){sessionStorage.removeItem(SESSION_UNLOCK_KEY);} function hasSessionUnlock(){return sessionStorage.getItem(SESSION_UNLOCK_KEY)==="1";} function isValidPin(pin){return /^\d{4}$/.test(String(pin||""));} function updatePinStatus(){setText("pinStatus",getStoredPin()?"PIN activo":"PIN no configurado");} function updatePinDots(){document.querySelectorAll("#pinDots span").forEach((d,i)=>d.classList.toggle("filled",i<state.pinBuffer.length));} function clearPinBuffer(){state.pinBuffer="";updatePinDots();} function showLock(mode="unlock"){state.pinMode=mode;clearPinBuffer();$("lockScreen")?.classList.add("show");const hasPin=!!getStoredPin();setText("lockModeText",(!hasPin||mode!=="unlock")?(mode==="change"?"Cambiar PIN":"Crear PIN"):"Acceso seguro");setText("lockInfo",(!hasPin||mode!=="unlock")?"Define un PIN de 4 dígitos.":"Ingresa tu PIN de 4 dígitos.");} function hideLock(){$("lockScreen")?.classList.remove("show");clearPinBuffer();} function processPinComplete(){const pin=state.pinBuffer, saved=getStoredPin(); if(!isValidPin(pin))return clearPinBuffer(); if(!saved||state.pinMode==="create"||state.pinMode==="change"){setStoredPin(pin);setSessionUnlock();hideLock();updatePinStatus();alert("PIN actualizado ✅");return;} if(pin===saved){setSessionUnlock();hideLock();return;} clearPinBuffer();alert("PIN incorrecto.");} function appendPinDigit(d){if(state.pinBuffer.length>=4)return;state.pinBuffer+=String(d);updatePinDots();if(state.pinBuffer.length===4)setTimeout(processPinComplete,120);} function backspacePin(){state.pinBuffer=state.pinBuffer.slice(0,-1);updatePinDots();} function bindPin(){document.querySelectorAll("[data-pin]").forEach(btn=>btn.addEventListener("click",()=>appendPinDigit(btn.dataset.pin)));$("btnPinClear")?.addEventListener("click",clearPinBuffer);$("btnPinBack")?.addEventListener("click",backspacePin);window.addEventListener("keydown",e=>{if(!$("lockScreen")?.classList.contains("show"))return;if(/^\d$/.test(e.key))appendPinDigit(e.key);if(e.key==="Backspace")backspacePin();if(e.key==="Escape")clearPinBuffer();});}

function fbStatus(text){setText("fbStatus",`Estado: ${text}`);setText("syncStatus",text.startsWith("online")?"Firebase":text.startsWith("sync")?"Sync...":"Local");} function fbReady(){return !!(window.firebase&&fbApp&&fbAuth&&fbDB);} function fbUser(){return fbAuth?.currentUser||null;} function isIOS(){return /iPhone|iPad|iPod/i.test(navigator.userAgent||"");} function requireOwner(user){return !!(user?.email&&user.email.toLowerCase()===OWNER_EMAIL.toLowerCase());} function canAutoSync(){if(!AUTO_SYNC_ENABLED||!fbReady())return false;const u=fbUser();return !!(u&&requireOwner(u));} function clientCol(uidVal){return fbDB.collection("users").doc(uidVal).collection("oasis_crm_v3").doc("clients").collection("items");} function visitCol(uidVal){return fbDB.collection("users").doc(uidVal).collection("oasis_crm_v3").doc("visits").collection("items");} function metaRef(uidVal){return fbDB.collection("users").doc(uidVal).collection("oasis_crm_v3").doc("meta").collection("items").doc("state");}
async function deleteRemoteTombstones(){
  if(!canAutoSync())return;
  const user=fbUser(); if(!user||!requireOwner(user))return;
  const uidVal=user.uid;
  const del=getDeletedMap();
  const ops=[];
  Object.keys(del.clients||{}).forEach(id=>ops.push(clientCol(uidVal).doc(id)));
  Object.keys(del.visits||{}).forEach(id=>ops.push(visitCol(uidVal).doc(id)));
  for(let i=0;i<ops.length;i+=450){const batch=fbDB.batch(); ops.slice(i,i+450).forEach(ref=>batch.delete(ref)); await batch.commit();}
}
async function pullFirebaseToLocal(){const user=fbUser(); if(!user||!requireOwner(user))throw new Error("Cuenta no autorizada."); const uidVal=user.uid; await pullVisitCatalogFromFirebase(uidVal); const [cs,vs]=await Promise.all([clientCol(uidVal).get(),visitCol(uidVal).get()]); const remote=normalizeDB({clients:cs.docs.map(d=>d.data()).filter(Boolean).filter(d=>!isDeleted("clients",d.id)),visits:vs.docs.map(d=>d.data()).filter(Boolean).filter(d=>!isDeleted("visits",d.id)&&!isDeleted("clients",d.clientId))}); const localClients=new Map(state.db.clients.filter(c=>!isDeleted("clients",c.id)).map(c=>[c.id,c])); const localVisits=new Map(state.db.visits.filter(v=>!isDeleted("visits",v.id)&&!isDeleted("clients",v.clientId)).map(v=>[v.id,v])); remote.clients.forEach(r=>{const l=localClients.get(r.id); if(isDirty("clients", r.id) && l) return; if(!l||isRemoteNewer(r,l))localClients.set(r.id,r);}); remote.visits.forEach(r=>{const l=localVisits.get(r.id); if(isDirty("visits", r.id) && l) return; if(!l||isRemoteNewer(r,l))localVisits.set(r.id,r);}); state.db=normalizeDB({clients:[...localClients.values()],visits:[...localVisits.values()]}); await idbClearAll(); state.indexes=buildIndexes(state.db); await Promise.all([idbPutMany("clients",state.db.clients),idbPutMany("visits",state.db.visits)]);}
async function pushLocalToFirebase(){const user=fbUser(); if(!user||!requireOwner(user))throw new Error("Cuenta no autorizada."); const uidVal=user.uid; await metaRef(uidVal).set({lastPingAt:isoNow(),app:"oasis_crm_pro_v4_5_2",visitCatalog:normalizeVisitCatalog(state.visitCatalog||defaultVisitCatalog())},{merge:true}); const ops=[]; state.db.clients.filter(c=>!isDeleted("clients",c.id)).forEach(c=>ops.push({store:"clients",id:c.id,ref:clientCol(uidVal).doc(c.id),doc:c})); state.db.visits.filter(v=>!isDeleted("visits",v.id)&&!isDeleted("clients",v.clientId)).forEach(v=>ops.push({store:"visits",id:v.id,ref:visitCol(uidVal).doc(v.id),doc:v})); for(let i=0;i<ops.length;i+=450){const batch=fbDB.batch(); ops.slice(i,i+450).forEach(item=>batch.set(item.ref,item.doc,{merge:true})); await batch.commit();} ops.forEach(item=>clearDirty(item.store,item.id));}
async function safeSyncNow(reason="manual"){if(!canAutoSync())return; if(_syncRunning){_syncPending=true;return;} _syncRunning=true;_syncPending=false; try{fbStatus(`sync ${reason}...`); await deleteRemoteTombstones(); const localFirst=/local-change|save|edit|delete/i.test(String(reason||"")) || hasDirtyRecords(); if(localFirst){ await pushLocalToFirebase(); await pullFirebaseToLocal(); } else { await pullFirebaseToLocal(); await pushLocalToFirebase(); } refreshAll(); const user=fbUser(); fbStatus(user?`online (${user.email})`:"offline");}catch(e){console.error(e);const user=fbUser();fbStatus(user?`online (${user.email})`:"offline");}finally{_syncRunning=false;if(_syncPending)setTimeout(()=>safeSyncNow("pending"),400);}}
function startAutoSyncLoop(){stopAutoSyncLoop(); if(AUTO_SYNC_ENABLED)_syncTimer=setInterval(()=>safeSyncNow("interval"),AUTO_SYNC_INTERVAL_MS);} function stopAutoSyncLoop(){if(_syncTimer)clearInterval(_syncTimer);_syncTimer=null;} function scheduleDebouncedSync(reason="local-change"){if(!canAutoSync())return;clearTimeout(_syncDebounce);_syncDebounce=setTimeout(()=>safeSyncNow(reason),AUTO_SYNC_DEBOUNCE_MS);} async function fbLogin(){if(!fbReady())return alert("Firebase no está listo.");const provider=new firebase.auth.GoogleAuthProvider();if(isIOS())return fbAuth.signInWithRedirect(provider);const res=await fbAuth.signInWithPopup(provider);if(!requireOwner(res.user)){await fbAuth.signOut();throw new Error("Cuenta no autorizada.");}} async function fbHandleRedirectResult(){if(!fbReady())return;try{const res=await fbAuth.getRedirectResult();if(res?.user&&!requireOwner(res.user)){await fbAuth.signOut();throw new Error("Cuenta no autorizada.");}}catch(e){const msg=String(e?.message||"").toLowerCase();if(msg&&!msg.includes("redirect")&&!msg.includes("no redirect"))alert("Login redirect falló: "+(e?.message||e));}} async function fbLogout(){if(fbReady())await fbAuth.signOut();} async function exitCRM(){try{clearSessionUnlock();if(fbReady()&&fbUser())await fbAuth.signOut();}catch(e){console.error(e);}finally{window.location.href=HUB_URL;}}

function bindUI(){document.querySelectorAll(".navBtn").forEach(btn=>btn.addEventListener("click",()=>setView(btn.dataset.view)));$("globalSearch")?.addEventListener("input",refreshAll);$("clientSearch")?.addEventListener("input",renderClients);$("clientStatusFilter")?.addEventListener("change",renderClients);$("clientSort")?.addEventListener("change",renderClients);$("followupFilter")?.addEventListener("change",renderFollowups);$("visitSearch")?.addEventListener("input",renderVisits);$("timelineSearch")?.addEventListener("input",()=>{state.timelineLimit=100;renderTimeline();});$("timelineFrom")?.addEventListener("change",()=>{state.timelineLimit=100;renderTimeline();});$("timelineTo")?.addEventListener("change",()=>{state.timelineLimit=100;renderTimeline();});$("btnClearTimelineFilters")?.addEventListener("click",()=>{$("timelineSearch").value="";$("timelineFrom").value="";$("timelineTo").value="";state.timelineLimit=100;renderTimeline();});$("btnMoreTimeline")?.addEventListener("click",()=>{state.timelineLimit+=100;renderTimeline();});$("btnNewClient")?.addEventListener("click",openClientModal);$("btnCloseModal")?.addEventListener("click",closeClientModal);$("btnCreateClient")?.addEventListener("click",createClient);$("btnOpenQuickVisit")?.addEventListener("click",()=>openVisitModal(null));$("btnAddVisit")?.addEventListener("click",()=>openVisitModal(null,state.activeClientId));$("btnCloseVisitModal")?.addEventListener("click",closeVisitModal);$("btnSaveVisit")?.addEventListener("click",saveVisit);$("btnCloseProfile")?.addEventListener("click",closeProfile);$("btnSaveClient")?.addEventListener("click",saveClientEdits);$("btnDeleteClient")?.addEventListener("click",()=>deleteClient(state.activeClientId));$("btnExportBackup")?.addEventListener("click",exportJSONBackup);$("btnRestoreBackup")?.addEventListener("click",()=>$("restoreBackupFile").click());$("restoreBackupFile")?.addEventListener("change",e=>{if(e.target.files?.[0])restoreBackup(e.target.files[0]);e.target.value="";});$("btnMigrateLegacy")?.addEventListener("click",async()=>{const ok=await importLegacyIfNeeded(true);alert(ok?"Legacy migrado ✅":"No encontré data legacy.");refreshAll();});$("btnResetAll")?.addEventListener("click",resetAll);$("btnSaveVisitCatalog")?.addEventListener("click",saveVisitCatalogFromSettings);$("btnChangePin")?.addEventListener("click",()=>showLock("change"));$("btnExitCRM")?.addEventListener("click",exitCRM);$("btnLogin")?.addEventListener("click",()=>fbLogin().catch(e=>alert(e.message||e)));$("btnLogout")?.addEventListener("click",fbLogout);$("btnSyncNow")?.addEventListener("click",()=>safeSyncNow("manual"));$("btnExportTimeline")?.addEventListener("click",()=>exportCSV("timeline_oasis", [["Fecha","Cliente","Servicio","Tipo","Equipo","Próxima","Pago","Monto","Nota"],...timelineRows().map(({visit,client})=>[visit.date,client.name,visit.service,visit.type,[visit.equipment,visit.model].filter(Boolean).join(" "),visit.nextDate,visit.paymentStatus,visit.amount,visit.note])]));$("btnExportFollowups")?.addEventListener("click",()=>exportCSV("seguimientos_oasis", [["Prioridad","Cliente","Contacto","Última","Motivo","Acción"],...getFollowups().map(f=>[f.priority,f.client.name,f.client.contact,f.lastDate,f.reason,f.action])]));}
function initFirebase(){if(!window.firebase)return fbStatus("offline"); try{fbApp=firebase.apps?.length?firebase.app():firebase.initializeApp(firebaseConfig);fbAuth=firebase.auth();fbDB=firebase.firestore();fbAuth.onAuthStateChanged(async user=>{if(user&&requireOwner(user)){fbStatus(`online (${user.email})`);startAutoSyncLoop();await pullVisitCatalogFromFirebase(user.uid);await safeSyncNow("login");}else{if(user&&!requireOwner(user)){alert("Cuenta no autorizada.");await fbAuth.signOut();}stopAutoSyncLoop();fbStatus("offline");}});fbHandleRedirectResult();}catch(e){console.error(e);fbStatus("offline");}}
async function init(){loadVisitCatalog();bindPin();bindUI();populateVisitDropdowns();renderVisitCatalogSettings();await loadStateFromIndexedDB();await importLegacyIfNeeded(false);state.indexes=buildIndexes(state.db);updatePinStatus();initFirebase();refreshAll(); if(!getStoredPin())showLock("create"); else if(!hasSessionUnlock())showLock("unlock");}
init().catch(e=>{console.error(e);alert("Error cargando CRM: "+(e.message||e));});
