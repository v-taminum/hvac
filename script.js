// HVAC Plant Monitor - profil industri R410A + IAQ + 3-phase.
// Sumber: Live DDC (REST /data dari ddc_simulator.py) atau DemoEngine lokal.
const CONFIG = {
  ESP32_API: new URLSearchParams(window.location.search).get("api") || "/data",
  POLL_INTERVAL_MS: 5000,
  FETCH_TIMEOUT_MS: 8000,
  MAX_POINTS: 20,
};

// [min, max] normal. null = indikator saja (counter energi).
// Tekanan/suhu = profil R410A. Tabel teknisi di skema (LP 60-80 / HP 250-310 psi,
// outlet 8-14°C) adalah profil R22 - dipakai sebagai referensi, bukan batas.
const THRESHOLDS = {
  suctionPressure: [115, 140], dischargePressure: [320, 425],
  suctionTemp: [8, 16], liquidTemp: [35, 48],
  superheat: [4, 8], subcooling: [4, 8],
  supplyTemp: [12, 18], returnTemp: [23, 28],
  roomTemp: [22, 26], outdoorTemp: [28, 36],
  roomRH: [40, 60], co2: [400, 1000],
  airflowSupply: [1.5, 3.5], airflowReturn: [1.2, 3.0], airflowOutdoor: [1.5, 4.0],
  voltageLL: [365, 415], currentAvg: [4, 11],
  powerKW: [2.5, 7], powerFactor: [0.8, 1.0],
  energyKWh: null, deltaTemp: [7, 12],
  chwSupply: [5, 9], chwReturn: [9, 15], chwDelta: [3, 7],
};
const UNITS = {
  suctionPressure: "psi", dischargePressure: "psi",
  suctionTemp: "°C", liquidTemp: "°C", superheat: "K", subcooling: "K",
  supplyTemp: "°C", returnTemp: "°C", roomTemp: "°C", outdoorTemp: "°C",
  roomRH: "%", co2: "ppm",
  airflowSupply: "m/s", airflowReturn: "m/s", airflowOutdoor: "m/s",
  voltageLL: "V", currentAvg: "A",
  powerKW: "kW", powerFactor: "", energyKWh: "kWh", deltaTemp: "°C",
  chwSupply: "°C", chwReturn: "°C", chwDelta: "K",
};
const DECIMALS = {
  suctionPressure: 1, dischargePressure: 1, suctionTemp: 1, liquidTemp: 1,
  superheat: 1, subcooling: 1, supplyTemp: 1, returnTemp: 1, roomTemp: 1,
  outdoorTemp: 1, roomRH: 1, co2: 0,
  airflowSupply: 2, airflowReturn: 2, airflowOutdoor: 2,
  voltageLL: 0, currentAvg: 2,
  powerKW: 2, powerFactor: 2, energyKWh: 2, deltaTemp: 1,
  chwSupply: 1, chwReturn: 1, chwDelta: 1,
};
// Fallback peta lama (ESP32 legacy) bila DDC baru tidak tersedia.
const LEGACY = {
  suctionPressure: ["lowPressure"], dischargePressure: ["highPressure"],
  voltageLL: ["tegangan"], currentAvg: ["ampere"],
  supplyTemp: ["suhuOutlet"], returnTemp: ["suhuInlet"], roomTemp: ["suhuRuangan"],
};
// Nilai turunan: dihitung bila tidak dikirim sumber data.
const DERIVED = { deltaTemp: ["returnTemp", "supplyTemp"], chwDelta: ["chwReturn", "chwSupply"] };
// Sensor tidak ada pada profil unit ini (mis. DX di AHU central): tampil netral,
// bukan merah. Merah hanya untuk bacaan hadir tapi invalid/abnormal.
function setNeutral(key) {
  const el = $(key);
  const u = UNITS[key] || "";
  if (el) el.textContent = `-- ${u}`.trim();
  const card = $("card-" + key);
  if (card) {
    card.classList.remove("is-good");
    card.classList.remove("is-bad");
  }
  updateLimitMarker(key, NaN);
}

// ---------------- DemoEngine lokal (fallback bila tanpa simulator) -------------
const queryParams = new URLSearchParams(window.location.search);
// Default: Demo (aman tanpa DDC). Live DDC hanya jika ?demo=0 eksplisit.
let demoMode = queryParams.get("demo") !== "0";
let demoScenario = queryParams.get("skenario") || "normal";
const COMP_ON = 100, COMP_OFF = 20;
// Unit yang dimonitor. Tambah unit = tambah objek di sini.
// api: null = pakai ?api= / "/data". Live multi-unit: isi URL REST per unit,
// mis. { id: "AHU-02", label: "AHU-02", desc: "Split system • R410A", api: "http://192.168.1.51/data" }.
// AC central (AHU besar/chiller/VRF): pakai entri unit sendiri + point tambahan
// (air dingin in/out, flow, VFD) - struktur seksi kartu sudah siap diperluas.
const AC_UNITS = [
  { id: "SPLIT-01", label: "SPLIT-01", desc: "Split DX • R410A • 2.5 PK", type: "Split DX", ref: "R410A", profile: "dx", icon: "❄️", api: null },
  { id: "SPLIT-02", label: "SPLIT-02", desc: "Split DX • R410A • 2.5 PK", type: "Split DX", ref: "R410A", profile: "dx", icon: "❄️", api: null },
  { id: "SPLIT-03", label: "SPLIT-03", desc: "Split DX • R410A • 2 PK", type: "Split DX", ref: "R410A", profile: "dx", icon: "❄️", api: null },
  { id: "SPLIT-04", label: "SPLIT-04", desc: "Split DX • R410A • 2 PK", type: "Split DX", ref: "R410A", profile: "dx", icon: "❄️", api: null },
  { id: "SPLIT-05", label: "SPLIT-05", desc: "Split DX • R410A • 1.5 PK", type: "Split DX", ref: "R410A", profile: "dx", icon: "❄️", api: null },
  { id: "VRF-01", label: "VRF-01", desc: "VRF Outdoor • R410A • 8 PK", type: "VRF", ref: "R410A", profile: "dx", icon: "🏬", api: null, cap: 3, limits: { currentAvg: [15, 30], powerKW: [9, 20] } },
  { id: "AHU-02", label: "AHU-02", desc: "Central AHU • Chilled Water", type: "Central AHU", ref: "Chilled Water", profile: "ahu", icon: "🏢", api: null },
];
let currentUnit = AC_UNITS[0];
const DemoProto = {
  t: 0,
  s: null,
  nz(s) { return (Math.random() + Math.random() + Math.random() - 1.5) * s; },
  lp(c, t, k, n) { return c + (t - c) * k + this.nz(n); },
  next() {
    const dt = CONFIG.POLL_INTERVAL_MS / 1000;
    this.t += dt;
    const sc = demoScenario, st = this.s, cap = this.cap || 1;
    const on = (this.t % (COMP_ON + COMP_OFF)) < COMP_ON;
    // Start-up: langkah pertama setelah kompresor nyala mengejar cepat
    // (tekanan/arus naik dalam hitungan detik) - tanpa ini tiap siklus
    // memicu alarm transien palsu.
    const k = on && !this.onPrev ? 0.95 : 0.3;
    this.onPrev = on;
    const bT = sc === "beban-tinggi", fr = sc === "freon-kurang", vd = sc === "tegangan-drop";
    if (on) {
      const roomT = 24 + (this.bias || 0) * 0.5 + Math.sin(this.t / 240) * 0.8 + (bT ? 2 : 0) + (fr ? 0.5 : 0);
      const outT = 32 + (this.bias || 0) * 0.5 + Math.sin(this.t / 300) * 1.5 + (bT ? 4 : 0);
      const evapT = 7.5 + Math.sin(this.t / 53) * 0.5 + (fr ? 1.5 : 0);
      const kondT = outT + 12 + (bT ? 3 : 0) + (fr ? -2 : 0);
      st.room = this.lp(st.room, roomT, 0.15, 0.1);
      st.outdoor = this.lp(st.outdoor, outT, 0.1, 0.1);
      st.evap = this.lp(st.evap, evapT, 0.3, 0.12);
      st.ret = this.lp(st.ret, st.room + 1.5, k, 0.1);
      st.supply = this.lp(st.supply, st.ret - 10.5 + (fr ? 3 : 0), k, 0.12);
      st.kond = this.lp(st.kond, kondT, 0.2, 0.2);
      // Suction mengikuti suhu evaporasi (±5 psi/°C) dengan titik kerja
      // di tengah rentang normal R410A, bukan di bibir batas bawah.
      st.sucP = this.lp(st.sucP, 126 + (st.evap - 7.5) * 5 + (fr ? -18 : 0), k, 0.6);
      st.disP = this.lp(st.disP, 327 + ((st.kond + 1 - 37.8) / 0.12), k, 2);
      st.sh = this.lp(st.sh, 6 + (fr ? 5 : 0), k, 0.2);
      st.sc = this.lp(st.sc, 6 + (fr ? -3 : 0), k, 0.2);
      st.sucT = st.evap - 1 + st.sh;
      st.liqT = st.kond + 1 - st.sc;
      st.rh = this.lp(st.rh, 52 + Math.sin(this.t / 200) * 4 + (bT ? 5 : 0), 0.15, 0.4);
      st.co2 = this.lp(st.co2, 620 + Math.sin(this.t / 170) * 120 + (bT ? 200 : 0), 0.15, 8);
      let vT = 398 + (this.bias || 0) + Math.sin(this.t / 47) * 4 + (vd ? -50 : 0) + (bT ? -4 : 0);
      if (Math.random() < 0.03) vT -= 12;
      st.volt = this.lp(st.volt, vT, 0.5, 1.2);
      st.amp = Math.max(0.5, this.lp(st.amp, (7.4 + (st.disP - 365) * 0.02 + (bT ? 1.2 : 0) + (vd ? 0.6 : 0) + (fr ? -0.6 : 0)) * cap, k, 0.1));
      st.flowS = this.lp(st.flowS, 2.4, k, 0.05);
      st.flowR = this.lp(st.flowR, 2.2, k, 0.05);
      st.flowO = this.lp(st.flowO, 3.0, k, 0.08);
      st.pf = this.lp(st.pf, 0.86, 0.2, 0.005);
      st.kw = 1.732 * st.volt * st.amp * st.pf / 1000;
      st.comp = 1;
    } else {
      st.ret = this.lp(st.ret, st.room + 1.5, 0.3, 0.1);
      st.supply = this.lp(st.supply, st.ret - 2, 0.3, 0.12);
      st.sucP = this.lp(st.sucP, 185, 0.3, 0.8);
      st.disP = this.lp(st.disP, 195, 0.3, 1.5);
      st.amp = this.lp(st.amp, 0.5, 0.4, 0.03);
      st.flowS = this.lp(st.flowS, 0, 0.5, 0.02);
      st.flowR = this.lp(st.flowR, 0, 0.5, 0.02);
      st.flowO = this.lp(st.flowO, 0, 0.5, 0.03);
      st.kw = 1.732 * st.volt * st.amp * st.pf / 1000;
      st.comp = 0;
    }
    // Chilled water (untuk AHU central): supply ~6.5°C, delta ~4 K.
    const chwST = 6.5 + Math.sin(this.t / 200) * 0.5 + (bT ? 1.5 : 0);
    st.chwS = this.lp(st.chwS, chwST, 0.15, 0.08);
    st.chwR = this.lp(st.chwR, st.chwS + 4.2 + (bT ? 1.0 : 0), 0.15, 0.1);
    st.kwh += Math.max(0, st.kw) * dt / 3600;
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      suctionPressure: r1(st.sucP), dischargePressure: r1(st.disP),
      suctionTemp: r1(st.sucT), liquidTemp: r1(st.liqT),
      superheat: r1(st.sh), subcooling: r1(st.sc),
      supplyTemp: r1(st.supply), returnTemp: r1(st.ret),
      roomTemp: r1(st.room), outdoorTemp: r1(st.outdoor),
      roomRH: r1(st.rh), co2: Math.round(st.co2),
      airflowSupply: r2(st.flowS), airflowReturn: r2(st.flowR), airflowOutdoor: r2(st.flowO),
      chwSupply: r1(st.chwS), chwReturn: r1(st.chwR),
      voltageLL: Math.round(st.volt), currentAvg: Math.round(st.amp * 100) / 100,
      powerKW: Math.round(st.kw * 100) / 100, energyKWh: Math.round(st.kwh * 100) / 100,
      powerFactor: Math.round(st.pf * 1000) / 1000, compStatus: st.comp,
      alarmCode: 0, deltaTemp: r1(st.ret - st.supply),
    };
  },
};
// Tiap unit punya simulator independen (fase kompresor + bias suhu beda).
function makeDemo(seed, bias) {
  const d = Object.create(DemoProto);
  d.t = seed;
  d.bias = bias;
  d.s = { room: 24 + bias * 0.5, outdoor: 32, evap: 7.5, supply: 14.2, ret: 25.5, kond: 44, sucP: 128, disP: 365, sucT: 13.2, liqT: 38, sh: 6, sc: 6, rh: 52, co2: 620, volt: 398, amp: 7.4, kw: 4.4, kwh: 12.5, pf: 0.86, chwS: 6.8, chwR: 11.0, flowS: 2.4, flowR: 2.2, flowO: 3.0 };
  return d;
}
const demos = {};
function demoFor(id) {
  if (!demos[id]) {
    const u = AC_UNITS.find((x) => x.id === id) || {};
    const i = Math.max(0, AC_UNITS.findIndex((x) => x.id === id));
    const d = makeDemo(Math.random() * 120 + i * 47, i * 0.3);
    d.cap = u.cap || 1;
    demos[id] = d;
  }
  return demos[id];
}

// ---------------- Log teknisi ----------------
// JADWAL PENCATATAN: (1) EVENT-DRIVEN - tiap transisi alarm / kompresor /
// koneksi / skenario / unit / reset filter langsung dicatat detik itu juga.
// (2) SNAPSHOT BERKALA - 1x per 60 detik (tiap 12x polling) untuk bahan
// evaluasi tren. Snapshot tiap 5 detik TIDAK disarankan (boros storage,
// tidak menambah nilai evaluasi).
// PENYIMPANAN: localStorage browser (cocok untuk demo & HP, maks 500 event +
// 720 snapshot ≈ 12 jam data). Produksi: pindahkan ke server - simulator
// bisa append ke CSV/SQLite, atau historian BMS (Desigo CC / Niagara).
const LOG_KEY = "hvac-log-v1", SNAP_KEY = "hvac-snap-v1", HOURS_KEY = "hvac-hours-v1";
const LOG_CAP = 500, SNAP_EVERY = 12, SNAP_CAP = 720;
const FILTER_INTERVAL_H = 500;
const SETPOINTS = { roomTemp: 24.0, supplyTemp: 14.0 };
const SNAP_KEYS = ["suctionPressure", "dischargePressure", "suctionTemp", "liquidTemp", "superheat", "subcooling", "supplyTemp", "returnTemp", "roomTemp", "outdoorTemp", "roomRH", "co2", "airflowSupply", "airflowReturn", "airflowOutdoor", "voltageLL", "currentAvg", "powerKW", "chwSupply", "chwReturn", "chwDelta", "compStatus"];
let eventLog = [], snaps = [], pollCount = 0, prevComp = null;
let hours = { comp: 0, fan: 0, filter: 0 };
function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch (e) { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
eventLog = lsGet(LOG_KEY, []);
snaps = lsGet(SNAP_KEY, []);
hours = Object.assign(hours, lsGet(HOURS_KEY, {}));
function addLog(type, detail) {
  eventLog.push({ t: new Date().toISOString(), unit: currentUnit.id, type, detail });
  if (eventLog.length > LOG_CAP) eventLog = eventLog.slice(-LOG_CAP);
  lsSet(LOG_KEY, eventLog);
}
function recordSnap(vals) {
  const v = {};
  SNAP_KEYS.forEach((k) => { v[k] = Number.isFinite(vals[k]) ? vals[k] : null; });
  snaps.push({ t: new Date().toISOString(), unit: currentUnit.id, v });
  if (snaps.length > SNAP_CAP) snaps = snaps.slice(-SNAP_CAP);
  lsSet(SNAP_KEY, snaps);
}
function updateHours(data) {
  const dt = CONFIG.POLL_INTERVAL_MS / 1000;
  hours.fan += dt;
  hours.filter += dt;
  if (data.compStatus === 1) hours.comp += dt;
  lsSet(HOURS_KEY, hours);
}
function fmtJam(sec) { return (sec / 3600).toFixed(1).replace(".", ","); }
function updateMaint() {
  const sisaH = Math.max(0, FILTER_INTERVAL_H - hours.filter / 3600);
  if ($("mComp")) $("mComp").textContent = fmtJam(hours.comp) + " jam";
  if ($("mFilter")) $("mFilter").textContent = sisaH <= 0 ? "JATUH TEMPO - cek sekarang" : "sisa " + sisaH.toFixed(1).replace(".", ",") + " jam";
  $("maintBar")?.classList.toggle("is-due", sisaH < 50);
}
function resetFilter() {
  hours.filter = 0;
  lsSet(HOURS_KEY, hours);
  updateMaint();
  addLog("FILTER", "Jam filter di-reset setelah pembersihan/penggantian");
  getToast()?.fire({ icon: "success", title: "Jam filter di-reset" });
}

// ---------------- Skenario dropdown custom + SweetAlert2 ----------------
const SC_META = {
  "normal": { label: "Normal", desc: "Sistem optimal", icon: "✅" },
  "beban-tinggi": { label: "Beban Tinggi", desc: "Beban puncak, suhu naik", icon: "🔥" },
  "freon-kurang": { label: "Freon Kurang", desc: "Suction drop, delta loyo", icon: "❄️" },
  "tegangan-drop": { label: "Gangguan Tegangan", desc: "Voltase 3-phase drop", icon: "⚡" },
};
function setScenario(v, fetch = true) {
  if (!SC_META[v]) return;
  demoScenario = v;
  syncScenarioDD();
  addLog("SCENARIO", "Skenario demo: " + SC_META[v].label);
  if (fetch) fetchData();
}
function syncScenarioDD() {
  const m = SC_META[demoScenario] || SC_META.normal;
  if ($("scenarioLabel")) $("scenarioLabel").textContent = m.label;
  if ($("scenarioDesc")) $("scenarioDesc").textContent = m.desc;
  if ($("scenarioIcon")) $("scenarioIcon").textContent = m.icon;
  document.querySelectorAll("#scenarioMenu li").forEach((li) => {
    const sel = li.dataset.value === demoScenario;
    li.setAttribute("aria-selected", sel ? "true" : "false");
    li.classList.toggle("selected", sel);
  });
  const btn = $("scenarioBtn");
  if (btn) btn.disabled = !demoMode;
  $("scenarioDD")?.classList.toggle("disabled", !demoMode);
}
function closeDD() {
  const menu = $("scenarioMenu");
  if (menu) menu.hidden = true;
  $("scenarioDD")?.classList.remove("open");
  $("scenarioBtn")?.setAttribute("aria-expanded", "false");
  document.querySelectorAll("#scenarioMenu li.focus").forEach((li) => li.classList.remove("focus"));
}
function clearCharts() {
  if (chartPress) { chartPress.data.labels = []; chartPress.data.datasets.forEach((d) => (d.data = [])); chartPress.update(); }
}
function applyProfileSections() {
  const isAhu = (currentUnit.profile || "dx") === "ahu";
  if ($("sec-ref")) $("sec-ref").hidden = isAhu;
  if ($("sec-chw")) $("sec-chw").hidden = !isAhu;
}
let overviewActive = false;
function showOverview() {
  overviewActive = true;
  ["sec-ref", "sec-chw", "sec-air", "sec-flow", "sec-el", "sec-trend", "alarmBanner", "diagBar", "maintBar"].forEach((id) => { if ($(id)) $(id).hidden = true; });
  if ($("sec-overview")) $("sec-overview").hidden = false;
  $("btnOv")?.classList.add("active");
  fetchOverview();
}
function showDetail() {
  overviewActive = false;
  if ($("sec-overview")) $("sec-overview").hidden = true;
  ["sec-air", "sec-flow", "sec-el", "sec-trend", "alarmBanner", "diagBar", "maintBar"].forEach((id) => { if ($(id)) $(id).hidden = false; });
  applyProfileSections();
  $("btnOv")?.classList.remove("active");
}
function setUnit(id) {
  showDetail();
  const u = AC_UNITS.find((x) => x.id === id);
  if (!u) return;
  const changed = u.id !== currentUnit.id;
  currentUnit = u;
  applyProfileSections();
  if (changed) {
    prevComp = null;
    lastAlarmKey = "";
    fitCardHeaders();
    clearCharts();
    syncUnitDD();
    syncBrand();
    initLimitBars();
    addLog("UNIT", "Pindah monitoring ke " + u.id);
  }
  fetchData();
}

// ---------------- Ringkasan semua unit ----------------
// Tiap unit diambil paralel, lalu dirender jadi kartu; klik kartu = buka detail.
const OV_METRIC = {
  dx: ["roomTemp", "suctionPressure", "dischargePressure", "airflowSupply", "currentAvg", "powerKW"],
  ahu: ["roomTemp", "supplyTemp", "airflowSupply", "chwSupply", "chwReturn", "chwDelta"],
};
const OV_LABEL = {
  roomTemp: "Room", roomRH: "RH", suctionPressure: "Suction", dischargePressure: "Discharge",
  currentAvg: "Arus", powerKW: "Daya", supplyTemp: "Supply", chwSupply: "CHW Sup",
  chwReturn: "CHW Ret", chwDelta: "Δ CHW",
  airflowSupply: "Flow Sup", airflowReturn: "Flow Ret", airflowOutdoor: "Flow Out",
};
function ovMetrics(u, vals, data) {
  const keys = OV_METRIC[u.profile || "dx"] || OV_METRIC.dx;
  return `<span class="ov-metrics">` + keys.map((k) => {
    const v = vals ? vals[k] : NaN;
    const bad = !!vals && classify(k, v, data, u) === "bad";
    return `<span class="ov-m${bad ? " is-bad" : ""}"><small>${OV_LABEL[k] || FRIENDLY[k] || k}</small><b>${Number.isFinite(v) ? fmt(k, v) : "--"}</b></span>`;
  }).join("") + `</span>`;
}
let ovBusy = false, ovQueued = false;
async function fetchOverview() {
  if (!overviewActive) return;
  if (ovBusy) { ovQueued = true; return; }
  ovBusy = true;
  try {
    const rows = await Promise.all(AC_UNITS.map(async (u) => {
      try {
        const data = await getUnitData(u);
        if (!data || typeof data !== "object") throw new Error("respons bukan objek");
        const { vals, bad } = evalUnit(data, u);
        return { u, data, vals, bad, ok: true };
      } catch (err) { return { u, ok: false, err: err.message }; }
    }));
    if (!overviewActive) return;
    renderOverview(rows);
    $("lastUpdate").textContent = "Update: " + new Date().toLocaleTimeString("id-ID", { hour12: false });
    const offline = rows.filter((r) => !r.ok).length;
    if (demoMode) {
      setPill($("connPill"), "Demo", "is-demo");
      $("statusBar").className = "status-bar is-demo";
      $("statusText").textContent = `Mode DEMO (${demoScenario}) - ringkasan ${rows.length} unit.`;
    } else {
      const allOff = offline >= rows.length;
      setPill($("connPill"), allOff ? "Offline" : "Live DDC", allOff ? "is-bad" : "is-ok");
      $("statusBar").className = "status-bar " + (allOff ? "is-offline" : "is-online");
      $("statusText").textContent = allOff ? "Semua unit terputus dari DDC." : `Ringkasan ${rows.length} unit${offline ? ` • ${offline} offline` : ""}.`;
    }
  } finally {
    ovBusy = false;
    if (ovQueued) { ovQueued = false; if (overviewActive) fetchOverview(); }
  }
}
function renderOverview(rows) {
  const grid = $("ovGrid");
  if (!grid) return;
  let nAlarm = 0, nOff = 0;
  grid.innerHTML = rows.map((r) => {
    const u = r.u;
    const nBad = r.ok ? r.bad.length : 0;
    if (!r.ok) nOff++; else if (nBad) nAlarm++;
    const badge = !r.ok ? "Offline" : nBad ? `Alarm (${nBad})` : "Normal";
    const foot = !r.ok
      ? r.err || "Tidak ada data"
      : `${r.data.compStatus === 1 ? "Kompresor ON" : r.data.compStatus === 0 ? "Standby - kompresor OFF" : "Kompresor --"}${nBad ? ` • ${nBad} parameter abnormal` : ""}`;
    return `<button type="button" class="ov-card ${!r.ok ? "is-off" : nBad ? "is-bad" : "is-ok"}" data-unit="${u.id}" title="Buka detail ${u.label}">` +
      `<span class="ov-top"><span class="ov-icon">${u.icon || "🏭"}</span><span class="ov-name">${u.label}</span><span class="ov-badge">${badge}</span></span>` +
      `<span class="ov-desc">${u.desc || ""}</span>` +
      ovMetrics(u, r.ok ? r.vals : null, r.ok ? r.data : {}) +
      `<span class="ov-foot">${foot}</span></button>`;
  }).join("");
  const nOk = rows.length - nAlarm - nOff;
  const sum = $("ovSummary");
  if (sum) sum.textContent = `${rows.length} unit • ${nOk} normal${nAlarm ? ` • ${nAlarm} alarm` : ""}${nOff ? ` • ${nOff} offline` : ""}`;
  setPill($("alarmPill"), nAlarm ? `Alarm (${nAlarm})` : "Normal", nAlarm ? (nAlarm > 1 ? "is-bad" : "is-warn") : "is-ok");
  const onN = rows.filter((r) => r.ok && r.data.compStatus === 1).length;
  setPill($("compPill"), `${onN}/${rows.length} kompresor ON`, onN ? "is-ok" : "");
}
function syncBrand() {
  if ($("brandSub")) $("brandSub").textContent = `${currentUnit.label} • ${currentUnit.type || ""} • ${currentUnit.ref || ""}`.replace(/ • $/, "");
}
function syncUnitDD() {
  if ($("unitLabel")) $("unitLabel").textContent = currentUnit.label;
  if ($("unitDesc")) $("unitDesc").textContent = currentUnit.desc;
  if ($("unitIcon")) $("unitIcon").textContent = currentUnit.icon || "🏭";
  const menu = $("unitMenu");
  if (!menu) return;
  menu.innerHTML = "";
  AC_UNITS.forEach((u) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = u.id;
    const sel = u.id === currentUnit.id;
    li.setAttribute("aria-selected", sel ? "true" : "false");
    if (sel) li.classList.add("selected");
      li.innerHTML = `<span class="dd-icon">${u.icon || "🏭"}</span><span class="dd-text"><b>${u.label}</b><small>${u.desc}</small></span><span class="dd-check">✓</span>`;
    menu.appendChild(li);
  });
}
function closeUnitDD() {
  const menu = $("unitMenu");
  if (menu) menu.hidden = true;
  $("unitDD")?.classList.remove("open");
  $("unitBtn")?.setAttribute("aria-expanded", "false");
}
function initUnitDD() {
  const btn = $("unitBtn"), menu = $("unitMenu"), dd = $("unitDD");
  if (!btn || !menu) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    closeUnitDD();
    if (willOpen) { menu.hidden = false; dd?.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-value]");
    if (!li) return;
    closeUnitDD();
    setUnit(li.dataset.value);
  });
  document.addEventListener("click", (e) => { if (!dd?.contains(e.target)) closeUnitDD(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { closeUnitDD(); btn.focus(); } });
  syncUnitDD();
}
function initScenarioDD() {
  const btn = $("scenarioBtn"), menu = $("scenarioMenu"), dd = $("scenarioDD");
  if (!btn || !menu) return;
  const items = [...menu.querySelectorAll("li")];
  let focusIdx = -1;
  const focusItem = (i) => {
    focusIdx = (i + items.length) % items.length;
    items.forEach((li, j) => li.classList.toggle("focus", j === focusIdx));
    items[focusIdx]?.scrollIntoView({ block: "nearest" });
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    const willOpen = menu.hidden;
    closeDD();
    if (willOpen) {
      menu.hidden = false;
      dd?.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      focusIdx = items.findIndex((li) => li.dataset.value === demoScenario);
    }
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-value]");
    if (!li) return;
    closeDD();
    setScenario(li.dataset.value);
  });
  document.addEventListener("click", (e) => { if (!dd?.contains(e.target)) closeDD(); });
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") { closeDD(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focusItem(focusIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(focusIdx - 1); }
    else if (e.key === "Enter" && focusIdx >= 0) { e.preventDefault(); const li = items[focusIdx]; closeDD(); setScenario(li.dataset.value); }
  });
  syncScenarioDD();
}

let toast = null;
function getToast() {
  if (typeof Swal === "undefined") return null;
  if (!toast) toast = Swal.mixin({ toast: true, position: "top-end", showConfirmButton: false, timer: 3200, timerProgressBar: true });
  return toast;
}
let lastAlarmKey = "";
let lastConn = "";
function noteConnection(ok) {
  const t = getToast();
  if (lastConn === "") { lastConn = ok ? "up" : "down"; return; }
  if (ok && lastConn === "down") { t?.fire({ icon: "success", title: "Koneksi pulih" }); addLog("CONN_UP", "Koneksi data pulih"); }
  if (!ok && lastConn === "up") { t?.fire({ icon: "error", title: demoMode ? "Demo error" : "Terputus dari DDC" }); addLog("CONN_DOWN", demoMode ? "Demo error" : "Terputus dari DDC"); }
  lastConn = ok ? "up" : "down";
}

// ---------------- UI helpers ----------------
const $ = (id) => document.getElementById(id);
function fmt(key, v) {
  const u = UNITS[key] || "";
  if (!Number.isFinite(v)) return `-- ${u}`.trim();
  const d = DECIMALS[key] ?? 1;
  return v.toFixed(d) + (u ? " " + u : "");
}
function pick(data, key) {
  let v = data[key];
  if (v === undefined) for (const a of LEGACY[key] || []) if (data[a] !== undefined) { v = data[a]; break; }
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
}
// Batas efektif: unit boleh override (mis. VRF arus/daya lebih besar).
function effTH(key, unit) {
  const u = unit || currentUnit;
  const o = u.limits;
  return (o && o[key]) || THRESHOLDS[key];
}
// Klasifikasi bacaan: "good" = hijau, "bad" = merah + alarm,
// "neutral" = abu-abu (tidak dinilai - mis. sirkuit saat kompresor OFF,
// saat OFF tekanan menyetarakan & delta-T loyo, itu bukan gangguan).
const RUN_ONLY_KEYS = ["suctionPressure", "dischargePressure", "suctionTemp", "liquidTemp", "superheat", "subcooling", "supplyTemp", "deltaTemp", "airflowSupply", "airflowReturn", "airflowOutdoor"];
const OFF_LOW_OK_KEYS = ["currentAvg", "powerKW"];
function hasRawField(key, data) {
  return data[key] !== undefined || (LEGACY[key] || []).some((a) => data[a] !== undefined);
}
function classify(key, value, data, unit) {
  const th = effTH(key, unit);
  if (!th) return "good";
  if (!Number.isFinite(value)) return hasRawField(key, data) ? "bad" : "neutral";
  if (data && data.compStatus === 0) {
    if (RUN_ONLY_KEYS.includes(key)) return "neutral";
    if (OFF_LOW_OK_KEYS.includes(key)) return value > th[1] ? "bad" : "neutral";
  }
  return value < th[0] || value > th[1] ? "bad" : "good";
}
// Nilai + daftar abnormal sebuah unit tanpa menyentuh DOM (untuk ringkasan).
function evalUnit(data, unit) {
  const vals = {};
  for (const key of Object.keys(THRESHOLDS)) {
    let v = pick(data, key);
    const der = DERIVED[key];
    if (!Number.isFinite(v) && der && Number.isFinite(vals[der[0]]) && Number.isFinite(vals[der[1]])) v = vals[der[0]] - vals[der[1]];
    vals[key] = v;
  }
  const bad = [];
  for (const key of Object.keys(THRESHOLDS)) {
    if (classify(key, vals[key], data, unit) === "bad") bad.push(key);
  }
  return { vals, bad };
}
// Bilah batas atas-bawah di tiap kartu: angka min di kiri, maks di kanan,
// pita hijau = zona normal, jarum = posisi nilai aktual. Dipanggil ulang
// tiap ganti unit agar batas mengikuti profil unit.
function initLimitBars() {
  document.querySelectorAll(".limit-bar").forEach((b) => b.remove());
  for (const key of Object.keys(THRESHOLDS)) {
    const th = effTH(key);
    if (!th) continue;
    const card = $("card-" + key);
    if (!card) continue;
    let nv = card.querySelector(".normal-value");
    if (!nv) {
      if (!card.dataset.normalTxt) continue;
      nv = document.createElement("div");
      nv.className = "normal-value";
      nv.innerHTML = card.dataset.normalTxt;
      card.querySelector(".value")?.after(nv);
    } else if (!card.dataset.normalTxt) {
      card.dataset.normalTxt = nv.innerHTML;
    }
    const [lo, hi] = th;
    const span = hi - lo, sMin = lo - 0.4 * span, sMax = hi + 0.4 * span;
    const pctOf = (x) => Math.min(100, Math.max(0, ((x - sMin) / (sMax - sMin)) * 100)).toFixed(1);
    const sp = SETPOINTS[key];
    const bar = document.createElement("div");
    bar.className = "limit-bar";
    bar.title = `Batas normal: ${lo}-${hi} ${UNITS[key] || ""}${sp !== undefined ? ` • Setpoint: ${sp}` : ""}`;
    bar.setAttribute("aria-hidden", "true");
    bar.innerHTML = `<span class="limit-num lo">▼ ${lo}</span><div class="limit-track"><div class="limit-zone" style="left:${pctOf(lo)}%;width:${(((hi - lo) / (sMax - sMin)) * 100).toFixed(1)}%"></div>${sp !== undefined ? `<div class="limit-sp" style="left:${pctOf(sp)}%" title="Setpoint ${sp}"></div>` : ""}<div class="limit-marker" style="display:none"></div></div><span class="limit-num hi">${hi} ▲</span>`;
    nv.replaceWith(bar);
    card.dataset.smin = sMin;
    card.dataset.smax = sMax;
  }
}
function updateLimitMarker(key, value, cls) {
  const card = $("card-" + key);
  const m = card?.querySelector(".limit-marker");
  if (!m) return;
  if (!Number.isFinite(value)) { m.style.display = "none"; return; }
  const pct = Math.min(100, Math.max(0, ((value - parseFloat(card.dataset.smin)) / (parseFloat(card.dataset.smax) - parseFloat(card.dataset.smin))) * 100));
  m.style.display = "block";
  m.style.left = pct.toFixed(1) + "%";
  m.classList.toggle("out", cls ? cls === "bad" : false);
}
function setCard(key, value, cls) {
  const el = $(key);
  if (el) el.textContent = fmt(key, value);
  const card = $("card-" + key);
  const th = effTH(key);
  if (card) {
    card.classList.toggle("is-good", cls === "good" && !!th);
    card.classList.toggle("is-bad", cls === "bad");
  }
  updateLimitMarker(key, value, cls);
  return cls !== "bad";
}
function setPill(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-ok", "is-warn", "is-bad", "is-demo");
  if (cls) el.classList.add(cls);
}

// ---------------- Charts ----------------
let chartPress = null, chartAir = null;
function initCharts() {
  if (typeof Chart === "undefined") { $("chartError")?.removeAttribute("hidden"); return; }
  if (typeof ChartDataLabels !== "undefined") {
    try { Chart.register(ChartDataLabels); if (Chart.defaults?.plugins?.datalabels) Chart.defaults.plugins.datalabels.display = false; }
    catch (e) { console.warn(e); }
  }
  chartPress = new Chart($("chartPress"), {
    type: "line",
    data: { labels: [], datasets: [
      { label: "Suction", data: [], borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,0.08)", fill: true, tension: 0.1, spanGaps: true, yAxisID: "y", borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5 },
      { label: "Discharge", data: [], borderColor: "#dc2626", backgroundColor: "rgba(220,38,38,0.08)", fill: true, tension: 0.1, spanGaps: true, yAxisID: "y1", borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { display: false }, legend: { labels: { boxWidth: 22, boxHeight: 8 } } }, scales: {
      x: { title: { display: true, text: "Waktu" }, grid: { color: "rgba(15,23,42,0.05)" } },
      y: { type: "linear", position: "left", title: { display: true, text: "Suction (psi)", color: "#16a34a" }, ticks: { color: "#16a34a" }, suggestedMin: 80, suggestedMax: 200, grid: { color: "rgba(15,23,42,0.06)" } },
      y1: { type: "linear", position: "right", title: { display: true, text: "Discharge (psi)", color: "#dc2626" }, ticks: { color: "#dc2626" }, suggestedMin: 150, suggestedMax: 450, grid: { drawOnChartArea: false } },
    } },
  });
  chartAir = new Chart($("chartAir"), {
    type: "bar",
    data: { labels: ["Supply", "Return", "Room", "Outdoor"], datasets: [{ label: "Suhu", backgroundColor: "#2563eb", borderRadius: 3, borderSkipped: "start", data: [NaN, NaN, NaN, NaN] }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 22, boxHeight: 8 } },
        datalabels: { display: true, anchor: "end", align: "end", offset: 2, color: "#0f172a", font: { weight: "bold", size: 11 }, formatter: (v) => (Number.isFinite(v) ? v.toFixed(1) + "°" : "--") },
      },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "rgba(15,23,42,0.06)" } } } },
  });
}
function pushTrend(suc, dis, sup, ret, room, out) {
  const now = new Date().toLocaleTimeString("id-ID", { hour12: false });
  if (chartPress) {
    chartPress.data.labels.push(now);
    chartPress.data.datasets[0].data.push(suc);
    chartPress.data.datasets[1].data.push(dis);
    while (chartPress.data.labels.length > CONFIG.MAX_POINTS) { chartPress.data.labels.shift(); chartPress.data.datasets.forEach((d) => d.data.shift()); }
    chartPress.update();
  }
  if (chartAir) {
    const keys = ["supplyTemp", "returnTemp", "roomTemp", "outdoorTemp"];
    const v = [sup, ret, room, out];
    chartAir.data.datasets[0].data = v;
    chartAir.data.datasets[0].backgroundColor = v.map((n, i) => {
      const th = effTH(keys[i]);
      return th && Number.isFinite(n) && (n < th[0] || n > th[1]) ? "#dc2626" : "#2563eb";
    });
    chartAir.update();
  }
}

// ---------------- Data ----------------
async function fetchJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: c.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
async function getUnitData(unit) {
  if (demoMode) { await new Promise((r) => setTimeout(r, 50 + Math.random() * 60)); return demoFor(unit.id).next(); }
  return fetchJson(unit.api || CONFIG.ESP32_API);
}
async function getData() {
  return getUnitData(currentUnit);
}

// Diagnosis berbasis aturan untuk teknisi: satu baris kesimpulan + tindakan.
function diagnose(vals, data) {
  const num = (k) => vals[k];
  if (data.compStatus === 0) return { level: "info", icon: "ℹ", text: "Kompresor istirahat (siklus OFF) - tekanan high & low saling menyamakan, arus tinggal fan. Ini kondisi normal, bukan gangguan." };
  const isAhu = (currentUnit.profile || "dx") === "ahu";
  if (isAhu) {
    if (num("chwSupply") > 9) return { level: "bad", icon: "⚠", text: "CHW supply tinggi: chiller / pompa / valve 2-way bermasalah. Eskalasi ke plant sebelum reset." };
    if (num("chwDelta") < 3) return { level: "warn", icon: "⚠", text: "Delta CHW kecil: aliran berlebih atau coil kotor. Cek balancing valve & filter udara AHU." };
  } else {
    if (num("suctionPressure") < 115 && num("superheat") > 8) return { level: "bad", icon: "⚠", text: "Indikasi kekurangan refrigeran: suction rendah + superheat tinggi. Cek kebocoran, tambah freon R410A sesuai SH target 4-8 K." };
    if (num("dischargePressure") > 425) return { level: "bad", icon: "⚠", text: "Discharge over-pressure: cek kondensor kotor, fan outdoor mati, atau beban berlebih. Jangan reset paksa berulang." };
    if (num("suctionPressure") < 115) return { level: "warn", icon: "⚠", text: "Suction rendah: cek filter indoor, evaporator frosting, atau EEV/katup ekspansi." };
  }
  if (num("voltageLL") < 365) return { level: "bad", icon: "⚠", text: "Tegangan di bawah 365 V: cek panel 3-phase & koneksi sebelum start ulang kompresor." };
  if (num("airflowSupply") < 1.5) return { level: "warn", icon: "⚠", text: "Air flow supply rendah: filter/koi evaporator kotor, fan indoor lemah, atau duct tersumbat. Bersihkan filter & cek putaran fan." };
  if (num("airflowOutdoor") < 1.5) return { level: "bad", icon: "⚠", text: "Air flow outdoor rendah: fan kondenser mati/terhambat - tekanan tinggi akan naik. Cek kipas & sirip kondenser." };
  if (num("deltaTemp") < 7) return { level: "warn", icon: "⚠", text: "Delta-T rendah: kapasitas pendinginan turun. Cek filter, freon, dan putaran fan indoor." };
  if (num("co2") > 1000) return { level: "warn", icon: "⚠", text: "CO₂ di atas 1000 ppm: tambah fresh air / periksa damper ventilasi." };
  if (num("roomRH") > 60) return { level: "warn", icon: "⚠", text: "Kelembaban di atas 60%: risiko kondensasi & jamur. Cek drainase dan mode dehumidifikasi." };
  if (num("powerFactor") < 0.8) return { level: "warn", icon: "⚠", text: "Power factor rendah: periksa kapasitor bank panel." };
  return isAhu
    ? { level: "ok", icon: "✓", text: "AHU beroperasi normal. CHW dan delta-T udara tercapai, elektrikal stabil." }
    : { level: "ok", icon: "✓", text: "Sistem beroperasi normal. SH/SC dalam rentang, delta-T tercapai, elektrikal stabil." };
}
function updateDiag(vals, data) {
  const d = diagnose(vals, data);
  const bar = $("diagBar");
  if (!bar) return;
  bar.className = "diag-bar is-" + d.level;
  if ($("diagIcon")) $("diagIcon").textContent = d.icon;
  if ($("diagText")) $("diagText").textContent = d.text;
}
const ALARM_BITS = ["Suction pressure abnormal", "Discharge pressure tinggi", "Tegangan abnormal", "CO₂ > 1000 ppm"];
function alarmMessages(data, badKeys) {
  const msgs = [];
  const code = data.alarmCode || 0;
  ALARM_BITS.forEach((m, i) => { if (code & (1 << i)) msgs.push(m); });
  const seen = new Set(msgs.map((m) => m.toLowerCase()));
  badKeys.forEach((k) => {
    if (![...seen].some((m) => m.includes(k.slice(0, 6).toLowerCase()))) msgs.push(`${k} di luar batas normal`);
  });
  return msgs;
}
const FRIENDLY = {
  suctionPressure: "Suction Pressure", dischargePressure: "Discharge Pressure",
  suctionTemp: "Suction Temp", liquidTemp: "Liquid Temp",
  superheat: "Superheat", subcooling: "Subcooling",
  supplyTemp: "Supply Air", returnTemp: "Return Air", roomTemp: "Room Temp",
  outdoorTemp: "Outdoor Temp", roomRH: "Kelembaban", co2: "CO₂",
  airflowSupply: "Air Flow Supply", airflowReturn: "Air Flow Return", airflowOutdoor: "Air Flow Outdoor",
  voltageLL: "Tegangan L-L", currentAvg: "Arus", powerKW: "Daya Aktif",
  powerFactor: "Power Factor", energyKWh: "Energi", deltaTemp: "Delta Temp",
  chwSupply: "CHW Supply", chwReturn: "CHW Return", chwDelta: "Delta CHW",
};
const BIT_KEYS = ["suctionPressure", "dischargePressure", "voltageLL", "co2"];
function alarmRows(data, badKeys, vals) {
  const rows = [];
  const covered = new Set();
  (badKeys || []).forEach((k) => {
    covered.add(k);
    const th = effTH(k), u = UNITS[k] || "";
    const v = vals ? vals[k] : NaN;
    rows.push({
      label: FRIENDLY[k] || k,
      detail: `${Number.isFinite(v) ? fmt(k, v) : "tidak valid"}${th ? ` • normal ${th[0]}-${th[1]}${u ? " " + u : ""}` : ""}`,
    });
  });
  const code = data.alarmCode || 0;
  ALARM_BITS.forEach((m, i) => {
    if ((code & (1 << i)) && !covered.has(BIT_KEYS[i])) rows.push({ label: m, detail: "" });
  });
  return rows;
}
function renderAlarm(data, badKeys, vals) {
  const msgs = alarmMessages(data, badKeys);
  const banner = $("alarmBanner"), pill = $("alarmPill");
  if (!msgs.length) {
    if (banner) banner.hidden = true;
    setPill(pill, "Normal", "is-ok");
  } else {
    if (banner) { banner.hidden = false; banner.textContent = "⚠ ALARM: " + msgs.join(" • "); }
    setPill(pill, `Alarm (${msgs.length})`, msgs.length > 1 ? "is-bad" : "is-warn");
  }
  // SweetAlert2: popup hanya pada transisi (alarm baru / pulih), bukan tiap polling.
  if (typeof Swal === "undefined") { lastAlarmKey = msgs.join("|"); return; }
  const key = msgs.slice().sort().join("|");
  const wasAlarm = lastAlarmKey !== "";
  const isAlarm = msgs.length > 0;
  if (isAlarm && key !== lastAlarmKey) {
    lastAlarmKey = key;
    addLog("ALARM_ON", msgs.join(" • "));
    if (!document.hidden) {
      const rows = alarmRows(data, badKeys, vals);
      Swal.fire({
        icon: "warning",
        title: "Alarm HVAC",
        html: `<div class="sw-al-list">` + rows.map((r) => `<div class="sw-al-row"><b>${r.label}</b>${r.detail ? `<small>${r.detail}</small>` : ""}</div>`).join("") + `</div>`,
        footer: `${SC_META[demoScenario]?.label || demoScenario} • ${new Date().toLocaleTimeString("id-ID", { hour12: false })}`,
        width: "22rem",
        padding: "0.9rem 0.9rem 0.7rem",
        showCloseButton: true,
        confirmButtonText: "OK",
        confirmButtonColor: "#dc2626",
        timer: 9000,
        timerProgressBar: true,
        customClass: { popup: "sw-al" },
      });
    }
  } else if (!isAlarm && wasAlarm) {
    lastAlarmKey = "";
    addLog("ALARM_OFF", "Semua parameter kembali normal");
    getToast()?.fire({ icon: "success", title: "Sistem kembali normal" });
  }
}

let isFetching = false;
async function fetchData() {
  if (isFetching) return;
  isFetching = true;
  try {
    const data = await getData();
    if (!data || typeof data !== "object") throw new Error("respons bukan objek");
    const vals = {};
    const bad = [];
    for (const key of Object.keys(THRESHOLDS)) {
      const hasRaw = data[key] !== undefined || (LEGACY[key] || []).some((a) => data[a] !== undefined);
      const der = DERIVED[key];
      let v = pick(data, key);
      if (!Number.isFinite(v) && der && Number.isFinite(vals[der[0]]) && Number.isFinite(vals[der[1]])) v = vals[der[0]] - vals[der[1]];
      vals[key] = v;
      if (!hasRaw && !Number.isFinite(v)) { setNeutral(key); continue; }
      if (!setCard(key, v, classify(key, v, data, currentUnit))) bad.push(key);
    }
    pushTrend(vals.suctionPressure, vals.dischargePressure, vals.supplyTemp, vals.returnTemp, vals.roomTemp, vals.outdoorTemp);
    $("lastUpdate").textContent = "Update: " + new Date().toLocaleTimeString("id-ID", { hour12: false });
    const comp = data.compStatus;
    setPill($("compPill"), comp === 1 ? "Kompresor ON" : comp === 0 ? "Kompresor OFF" : "Kompresor --", comp === 1 ? "is-ok" : "");
    if (demoMode) {
      setPill($("connPill"), "Demo", "is-demo");
      $("statusBar").className = "status-bar is-demo";
      $("statusText").textContent = `Mode DEMO (${demoScenario}) - simulator lokal.`;
    } else {
      setPill($("connPill"), "Live DDC", "is-ok");
      $("statusBar").className = "status-bar is-online";
      $("statusText").textContent = "Terhubung - data live.";
    }
    renderAlarm(data, bad, vals);
    updateDiag(vals, data);
    if (prevComp !== null && data.compStatus !== prevComp && (data.compStatus === 0 || data.compStatus === 1)) {
      addLog(data.compStatus === 1 ? "COMP_ON" : "COMP_OFF", data.compStatus === 1 ? "Kompresor start" : "Kompresor stop (siklus OFF)");
    }
    if (data.compStatus === 0 || data.compStatus === 1) prevComp = data.compStatus;
    updateHours(data);
    updateMaint();
    pollCount++;
    if (pollCount % SNAP_EVERY === 0) recordSnap(vals);
    noteConnection(true);
  } catch (err) {
    $("statusBar").className = "status-bar is-offline";
    $("statusText").textContent = demoMode ? `Demo error: ${err.message}` : `Terputus (${err.message}). Coba Demo atau jalankan simulator.`;
    setPill($("connPill"), "Offline", "is-bad");
    noteConnection(false);
    console.error(err);
  } finally { isFetching = false; }
}
function startPolling() {
  const tick = async () => { if (!document.hidden) { if (overviewActive) await fetchOverview(); else await fetchData(); } setTimeout(tick, CONFIG.POLL_INTERVAL_MS); };
  tick();
}

// ---------------- Viewer Log teknisi ----------------
function fmtLogTime(iso) {
  try {
    return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch (e) { return iso; }
}
let logType = "SEMUA", logUnit = "SEMUA";
function renderLogTable() {
  const box = $("logList");
  if (!box) return;
  const rows = eventLog.filter((e) => (logType === "SEMUA" || e.type === logType) && (logUnit === "SEMUA" || e.unit === logUnit)).slice(-150).reverse();
  const c = $("logCount");
  if (c) c.textContent = `${rows.length} ditampilkan / ${eventLog.length} event`;
  if (!rows.length) { box.innerHTML = `<div class="log-empty">Belum ada log. Alarm, kompresor, dan koneksi tercatat otomatis.</div>`; return; }
  if ($("logTypeLabel")) $("logTypeLabel").textContent = logType === "SEMUA" ? "SEMUA" : logType;
  if ($("logUnitLabel")) $("logUnitLabel").textContent = logUnit;
  if (window.innerWidth <= 640) {
    box.innerHTML = `<div class="log-cards">` + rows.map((e) => `<div class="log-card"><div class="log-card-top"><span class="nw">${fmtLogTime(e.t)}</span><span class="log-unit">${e.unit}</span><span class="lt lt-${e.type.split("_")[0]}">${e.type}</span></div><div class="log-card-detail">${e.detail}</div></div>`).join("") + `</div>`;
    return;
  }
  box.innerHTML = `<table class="log-table"><thead><tr><th>Waktu</th><th>Unit</th><th>Tipe</th><th>Detail</th></tr></thead><tbody>` +
    rows.map((e) => `<tr><td class="nw">${fmtLogTime(e.t)}</td><td>${e.unit}</td><td><span class="lt lt-${e.type.split("_")[0]}">${e.type}</span></td><td>${e.detail}</td></tr>`).join("") +
    `</tbody></table>`;
}
function downloadCSV(name, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportLogCSV() {
  downloadCSV("hvac-log.csv", [["waktu", "unit", "tipe", "detail"], ...eventLog.map((e) => [fmtLogTime(e.t), e.unit, e.type, e.detail])]);
}
function exportDataCSV() {
  downloadCSV("hvac-data.csv", [["waktu", "unit", ...SNAP_KEYS], ...snaps.map((s) => [fmtLogTime(s.t), s.unit, ...SNAP_KEYS.map((k) => s.v[k] ?? "")])]);
}
function fillLogMenu(menuId, items, cur) {
  const menu = $(menuId);
  if (!menu) return;
  menu.innerHTML = "";
  items.forEach((v) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = v;
    const sel = v === cur;
    li.setAttribute("aria-selected", sel ? "true" : "false");
    if (sel) li.classList.add("selected");
    li.innerHTML = `<span class="dd-text"><b>${v === "SEMUA" ? "SEMUA" : v}</b></span><span class="dd-check">✓</span>`;
    menu.appendChild(li);
  });
}
function bindLogDD(ddId, btnId, menuId, onPick) {
  const btn = $(btnId), menu = $(menuId), dd = $(ddId);
  if (!btn || !menu) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    document.querySelectorAll(".swal2-popup .dd-menu").forEach((m) => (m.hidden = true));
    document.querySelectorAll(".swal2-popup .dd.open").forEach((d) => d.classList.remove("open"));
    document.querySelectorAll(".swal2-popup .dd-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (willOpen) { menu.hidden = false; dd?.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-value]");
    if (!li) return;
    onPick(li.dataset.value);
    menu.hidden = true;
    dd?.classList.remove("open");
  });
  if (!window.__logDDOut) {
    window.__logDDOut = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".swal2-popup .dd")) {
        document.querySelectorAll(".swal2-popup .dd-menu").forEach((m) => (m.hidden = true));
        document.querySelectorAll(".swal2-popup .dd.open").forEach((d) => d.classList.remove("open"));
      }
    });
  }
}
function openLog() {
  if (typeof Swal === "undefined") return;
  const types = ["SEMUA", ...new Set(eventLog.map((e) => e.type))];
  Swal.fire({
    title: "Log Teknisi",
    width: "52rem",
    showConfirmButton: false,
    showCloseButton: true,
    customClass: { popup: "sw-log" },
    html: `<div class="log-tools"><div class="dd sm" id="logTypeDD"><button type="button" class="dd-btn" id="logTypeBtn" aria-haspopup="listbox" aria-expanded="false"><span class="dd-text"><b id="logTypeLabel">Semua</b></span><svg class="dd-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><ul class="dd-menu" id="logTypeMenu" role="listbox" aria-label="Filter tipe" hidden></ul></div><div class="dd sm" id="logUnitDD2"><button type="button" class="dd-btn" id="logUnitBtn" aria-haspopup="listbox" aria-expanded="false"><span class="dd-text"><b id="logUnitLabel">SEMUA</b></span><svg class="dd-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><ul class="dd-menu" id="logUnitMenu" role="listbox" aria-label="Filter unit" hidden></ul></div><span class="log-count" id="logCount"></span><span class="log-spacer"></span><button type="button" id="logExp" class="mini-btn">⬇ Log CSV</button><button type="button" id="logExpData" class="mini-btn">⬇ Data CSV</button><button type="button" id="logClear" class="mini-btn danger">Hapus</button></div><div class="log-list" id="logList"></div><div class="log-hint">Event + snapshot tiap 60 dtk • tersimpan di browser (kapasitas ${LOG_CAP} event / ${SNAP_CAP} snapshot)</div>`,
    didOpen: () => {
      fillLogMenu("logTypeMenu", types, logType);
      fillLogMenu("logUnitMenu", ["SEMUA", ...AC_UNITS.map((u) => u.id)], logUnit);
      bindLogDD("logTypeDD", "logTypeBtn", "logTypeMenu", (v) => { logType = v; fillLogMenu("logTypeMenu", types, logType); renderLogTable(); });
      bindLogDD("logUnitDD2", "logUnitBtn", "logUnitMenu", (v) => { logUnit = v; fillLogMenu("logUnitMenu", ["SEMUA", ...AC_UNITS.map((u) => u.id)], logUnit); renderLogTable(); });
      $("logExp")?.addEventListener("click", exportLogCSV);
      $("logExpData")?.addEventListener("click", exportDataCSV);
      $("logClear")?.addEventListener("click", () => {
        Swal.fire({ title: "Hapus semua log?", icon: "warning", showCancelButton: true, confirmButtonText: "Hapus", cancelButtonText: "Batal", confirmButtonColor: "#dc2626" }).then((r) => {
          if (r.isConfirmed) {
            eventLog = [];
            snaps = [];
            lsSet(LOG_KEY, eventLog);
            lsSet(SNAP_KEY, snaps);
            addLog("INFO", "Log dihapus teknisi");
            openLog();
          }
        });
      });
      renderLogTable();
    },
  });
}

// Toolbar + jam
function syncToolbar() {
  $("btnLive")?.classList.toggle("active", !demoMode);
  $("btnDemo")?.classList.toggle("active", demoMode);
  syncScenarioDD();
}
$("btnLive")?.addEventListener("click", () => { demoMode = false; syncToolbar(); fetchData(); });
$("btnDemo")?.addEventListener("click", () => { demoMode = true; syncToolbar(); fetchData(); });
$("btnLog")?.addEventListener("click", openLog);
$("btnOv")?.addEventListener("click", () => {
  if (overviewActive) { showDetail(); fetchData(); }
  else showOverview();
});
$("ovGrid")?.addEventListener("click", (e) => {
  const card = e.target.closest(".ov-card[data-unit]");
  if (card) setUnit(card.dataset.unit);
});
$("btnFilterReset")?.addEventListener("click", resetFilter);
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString("id-ID", { hour12: false }); }, 1000);

// Judul kartu satu baris: bila teks panjang, font dikecilkan otomatis
// sampai muat (bukan dipotong "...").
function fitCardHeaders() {
  document.querySelectorAll(".card-header").forEach((el) => {
    if (!el.clientWidth) return;
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize) || 12;
    const min = base * 0.7;
    let size = base;
    while (el.scrollWidth > el.clientWidth && size > min) {
      size -= 0.5;
      el.style.fontSize = size + "px";
    }
  });
}
let fitT = null;
window.addEventListener("resize", () => {
  clearTimeout(fitT);
  fitT = setTimeout(() => { fitCardHeaders(); if (document.querySelector(".swal2-popup.sw-log")) renderLogTable(); }, 200);
});
if (document.fonts?.ready) document.fonts.ready.then(() => fitCardHeaders());
initCharts();
initScenarioDD();
initUnitDD();
syncBrand();
applyProfileSections();
initLimitBars();
fitCardHeaders();
updateMaint();
syncToolbar();
showOverview(); // posisi default: mode Ringkasan semua unit
startPolling();
