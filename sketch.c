#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// WiFi AP Settings
const char* ssid = "ESP32-AC";
const char* password = "12345678";

// DS18B20 config
#define ONE_WIRE_BUS 4
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// Sensor analog
#define ARUS_PIN 34
#define TEGANGAN_PIN 35
#define TEKANAN_LOW_PIN 32
#define TEKANAN_HIGH_PIN 33

// ---------------------------------------------------------------------------
// MODE SIMULASI DINAMIS (untuk demo tanpa sensor lengkap).
// true  = endpoint /data menghasilkan data dinamis ala HVAC industri
//         (random-walk + sinus + siklus kompresor ON 100 dtk / OFF 20 dtk).
// false = baca sensor asli (DS18B20 + ADC).
// SKENARIO: 0=Normal, 1=Beban Tinggi, 2=Freon Kurang, 3=Gangguan Tegangan
// ---------------------------------------------------------------------------
#define SIMULASI_DINAMIS true
#define SKENARIO_SIMULASI 0

// State simulator (dipertahankan antar request)
// Profil R410A - identik dengan ddc_simulator.py (suction 115-140,
// discharge 320-425 psi, tegangan 3-phase 380-415 V, airflow m/s).
static float simT = 0;
static unsigned long simLastMs = 0;
static float sRuangan = 24.0, sEvap = 7.5, sOutlet = 14.5, sInlet = 26.8;
static float sKond = 47.0, sLow = 128.0, sHigh = 365.0, sVolt = 398.0, sAmp = 7.4;
static float sFlowS = 2.4, sFlowR = 2.2, sFlowO = 3.0;
static bool simInit = false;

float simNoise(float scale) {
  // pseudo-gaussian sederhana: rata-rata 3x uniform(-1..1)
  float n = 0;
  for (int i = 0; i < 3; i++) n += (random(-100, 101) / 100.0);
  return (n / 3.0) * scale;
}

float simLerp(float cur, float target, float k, float nScale) {
  return cur + (target - cur) * k + simNoise(nScale);
}

String buildSimulasiJson() {
  if (!simInit) {
    randomSeed(analogRead(0) + millis());
    simT = random(0, 120);
    simInit = true;
    simLastMs = millis();
  }
  unsigned long now = millis();
  float dt = (now - simLastMs) / 1000.0;
  if (dt < 0) dt = 0;
  if (dt > 30) dt = 5; // cap jika request lama tidak datang
  if (dt < 1) dt = 5;  // polling normal ~5 dtk
  simLastMs = now;
  simT += dt;

  float offRuangan = 0, offKond = 0, offEvap = 0, offVolt = 0, offAmp = 0;
  if (SKENARIO_SIMULASI == 1) { offRuangan = 2.5; offKond = 6; offEvap = 0.8; offVolt = -4; offAmp = 1.0; }
  else if (SKENARIO_SIMULASI == 2) { offRuangan = 0.5; offKond = -3; offEvap = 2.5; offAmp = -0.5; }
  else if (SKENARIO_SIMULASI == 3) { offVolt = -50; offAmp = 0.4; }

  float cycle = fmod(simT, 120.0);
  bool compOn = cycle < 100.0;
  float sinT = sin(simT / 47.0) * 3.0;

  if (compOn) {
    float ruanganT = 24.0 + sin(simT / 240.0) * 1.2 + offRuangan;
    float evapT = 7.5 + sin(simT / 53.0) * 0.6 + offEvap;
    float kondT = ruanganT + 22.5 + offKond + sin(simT / 90.0) * 1.0;
    float outletExtra = (SKENARIO_SIMULASI == 2) ? 3.5 : 0;
    float lowPAdjust = (SKENARIO_SIMULASI == 2) ? -16 : 0;
    sRuangan = simLerp(sRuangan, ruanganT, 0.15, 0.12);
    sEvap = simLerp(sEvap, evapT, 0.3, 0.15);
    sInlet = simLerp(sInlet, sRuangan + 2.8, 0.3, 0.12);
    sOutlet = simLerp(sOutlet, sEvap + 7.0 + outletExtra, 0.3, 0.15);
    sKond = simLerp(sKond, kondT, 0.2, 0.25);
    sLow = simLerp(sLow, 126.0 + (sEvap - 7.5) * 5.0 + lowPAdjust, 0.3, 0.5);
    sHigh = simLerp(sHigh, 327.0 + ((sKond + 1.0) - 37.8) / 0.12, 0.3, 1.2);
    float voltT = 398 + sinT + offVolt;
    if (random(0, 100) < 3) voltT -= 10; // sag sesaat
    sVolt = simLerp(sVolt, voltT, 0.5, 1.0);
    sAmp = simLerp(sAmp, 7.4 + (sHigh - 365) * 0.02 + offAmp, 0.35, 0.08);
    // Airflow (supply/return/outdoor) saat unit menyala
    sFlowS = simLerp(sFlowS, 2.4, 0.3, 0.05);
    sFlowR = simLerp(sFlowR, 2.2, 0.3, 0.05);
    sFlowO = simLerp(sFlowO, 3.0, 0.3, 0.08);
  } else {
    // Kompresor OFF: tekanan menyetarakan, arus sisa fan, delta mengecil
    sRuangan = simLerp(sRuangan, sRuangan + 0.05, 0.2, 0.08);
    sEvap = simLerp(sEvap, sRuangan - 8, 0.25, 0.15);
    sInlet = simLerp(sInlet, sRuangan + 2.8, 0.3, 0.1);
    sOutlet = simLerp(sOutlet, sInlet - 2.5, 0.3, 0.15);
    sKond = simLerp(sKond, sKond - 1.5, 0.2, 0.2);
    sLow = simLerp(sLow, 185, 0.3, 0.4);
    sHigh = simLerp(sHigh, 195, 0.3, 1.0);
    sVolt = simLerp(sVolt, 398 + sinT + offVolt, 0.5, 1.0);
    sAmp = simLerp(sAmp, 0.6, 0.4, 0.05);
    // Fan berhenti mengikuti kompresor -> airflow menuju 0
    sFlowS = simLerp(sFlowS, 0.0, 0.5, 0.02);
    sFlowR = simLerp(sFlowR, 0.0, 0.5, 0.02);
    sFlowO = simLerp(sFlowO, 0.0, 0.5, 0.03);
  }

  float deltaTemp = sInlet - sOutlet;
  String json = "{";
  json += "\"lowPressure\":" + String(sLow, 1) + ",";
  json += "\"highPressure\":" + String(sHigh, 1) + ",";
  json += "\"tegangan\":" + String((int)round(sVolt)) + ",";
  json += "\"ampere\":" + String(sAmp, 2) + ",";
  json += "\"suhuInlet\":" + String(sInlet, 1) + ",";
  json += "\"suhuOutlet\":" + String(sOutlet, 1) + ",";
  json += "\"suhuRuangan\":" + String(sRuangan, 1) + ",";
  json += "\"suhuEvaporator\":" + String(sEvap, 1) + ",";
  json += "\"suhuKondensor\":" + String(sKond, 1) + ",";
  json += "\"deltaTemp\":" + String(deltaTemp, 1) + ",";
  json += "\"compStatus\":" + String(compOn ? 1 : 0) + ",";
  json += "\"airflowSupply\":" + String(sFlowS, 2) + ",";
  json += "\"airflowReturn\":" + String(sFlowR, 2) + ",";
  json += "\"airflowOutdoor\":" + String(sFlowO, 2);
  json += "}";
  return json;
}

AsyncWebServer server(80);

void setup() {
  Serial.begin(115200);
  WiFi.softAP(ssid, password);
  Serial.println("AP started");

  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed");
    return;
  }

  // Start temperature sensor
  sensors.begin();

  // Serve files
  server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");

  // Data endpoint
  server.on("/data", HTTP_GET, [](AsyncWebServerRequest *request){
    if (SIMULASI_DINAMIS) {
      request->send(200, "application/json", buildSimulasiJson());
      return;
    }

    sensors.requestTemperatures();
    float suhuInlet = sensors.getTempCByIndex(0);   // Inlet
    float suhuOutlet = sensors.getTempCByIndex(1);  // Outlet

    // Ganti dengan kalibrasi sensor masing-masing sebelum production!
    // Skala mengikuti profil R410A + tegangan 3-phase 380-415 V.
    float tegangan = analogRead(TEGANGAN_PIN) * (3.3 / 4095.0) * (415.0 / 3.3); // skala volt 3-phase
    float arus = (analogRead(ARUS_PIN) - 2048) * (5.0 / 1024.0); // asumsi offset dan skala ACS712
    float lowPressure = analogRead(TEKANAN_LOW_PIN) * 145.0 / 4095.0;  // Carel 0-10 bar = 0-145 psi
    float highPressure = analogRead(TEKANAN_HIGH_PIN) * 435.0 / 4095.0; // Carel 0-30 bar = 0-435 psi
    // AirflowSupply/Return/Outdoor: sengaja tidak dikirim - sensor belum
    // terpasang di jalur hardware ini. Field absen -> dashboard netral.

    float suhuRuangan = suhuInlet - 2;         // TODO: ganti sensor asli
    float suhuEvaporator = suhuOutlet - 3;     // TODO: ganti sensor asli
    float suhuKondensor = suhuInlet + 15;      // TODO: ganti sensor asli
    float deltaTemp = suhuInlet - suhuOutlet;

    String json = "{";
    json += "\"lowPressure\":" + String(lowPressure, 1) + ",";
    json += "\"highPressure\":" + String(highPressure, 1) + ",";
    json += "\"tegangan\":" + String(tegangan, 0) + ",";
    json += "\"ampere\":" + String(arus, 2) + ",";
    json += "\"suhuInlet\":" + String(suhuInlet, 1) + ",";
    json += "\"suhuOutlet\":" + String(suhuOutlet, 1) + ",";
    json += "\"suhuRuangan\":" + String(suhuRuangan, 1) + ",";
    json += "\"suhuEvaporator\":" + String(suhuEvaporator, 1) + ",";
    json += "\"suhuKondensor\":" + String(suhuKondensor, 1) + ",";
    json += "\"deltaTemp\":" + String(deltaTemp, 1);
    json += "}";

    request->send(200, "application/json", json);
  });

  server.begin();
}

void loop() {
  // Tidak diperlukan loop aktif
}
