#!/usr/bin/env python3
"""
DDC Simulator HVAC Industri - Opsi A (tanpa hardware).
Profil R410A + sensor kelembaban/CO2 + elektrikal 3-phase.

Fungsi ganda (stdlib only, tanpa pip install):
  1. Modbus TCP Slave  : 127.0.0.1:1502, Unit 1, FC3/FC4 (uji via PLC/SCADA/Modbus client)
  2. REST + static web : http://localhost:8000/  -> serve index.html/script.js/style.css
                         http://localhost:8000/data (JSON untuk dashboard)

Cara pakai:
  python ddc_simulator.py
  python ddc_simulator.py --scenario freon-kurang --modbus-port 1502 --http-port 8000
  Skenario: normal | beban-tinggi | freon-kurang | tegangan-drop
  Ganti skenario live: http://localhost:8000/scenario?name=beban-tinggi
  Dashboard: buka http://localhost:8000/?demo=0  (mode Live membaca /data simulator)
             atau file:// + ?api=http://localhost:8000/data

Register map (FC3, Unit 1, alamat protokol 0-based, float32 BE = 2 register):
  0-1   suctionPressure psi     2-3  dischargePressure psi
  4-5   suctionTemp C           6-7  liquidTemp C
  8-9   superheat K             10-11 subcooling K
  12-13 supplyTemp C            14-15 returnTemp C
  16-17 roomTemp C              18-19 outdoorTemp C
  20-21 roomRH %                22-23 co2 ppm
  24-25 voltageLL V             26-27 currentAvg A
  28-29 powerKW kW              30-31 energyKWh kWh (counter)
  32-33 powerFactor              34  compStatus (0/1)   35 alarmCode (bitmask)
  36-37 chwSupply C  38-39 chwReturn C  40-41 chwDelta K (append-only, map lama stabil)
  42-43 airflowSupply m/s  44-45 airflowReturn m/s  46-47 airflowOutdoor m/s (append)
"""
import argparse
import json
import math
import os
import random
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

COMP_ON_SEC = 100
COMP_OFF_SEC = 20

SCENARIOS = ("normal", "beban-tinggi", "freon-kurang", "tegangan-drop")


class HVACSim:
    def __init__(self, scenario="normal"):
        self.scenario = scenario if scenario in SCENARIOS else "normal"
        self.t = random.uniform(0, 120)
        self.last = time.monotonic()
        self.s = dict(room=24.0, outdoor=32.0, evap=7.5, supply=14.2,
                      ret=25.5, kond=44.0, sucP=128.0, disP=365.0,
                      sucT=13.2, liqT=38.0, sh=6.0, sc=6.0,
                      rh=52.0, co2=620.0, volt=398.0, amp=7.4,
                      kw=4.4, kwh=12.5, pf=0.86, comp=1,
                      chwS=6.8, chwR=11.0,
                      flowS=2.4, flowR=2.2, flowO=3.0)
        self.prev_comp = 1
        self.lock = threading.Lock()

    def noise(self, scale):
        return (random.random() + random.random() + random.random() - 1.5) * scale

    def lerp(self, cur, target, k, n):
        return cur + (target - cur) * k + self.noise(n)

    def tick(self, dt=None):
        with self.lock:
            now = time.monotonic()
            if dt is None:
                dt = now - self.last
                dt = min(max(dt, 0), 30)
                if dt < 1:
                    dt = 5  # polling dashboard ~5 dtk
            self.last = now
            self.t += dt
            sc = self.scenario
            st = self.s
            comp_on = (self.t % (COMP_ON_SEC + COMP_OFF_SEC)) < COMP_ON_SEC
            # Start-up: langkah pertama setelah kompresor nyala mengejar cepat
            # (tekanan/arus naik dalam hitungan detik) - cegah alarm transien.
            k = 0.95 if (comp_on and self.prev_comp == 0) else 0.30
            self.prev_comp = 1 if comp_on else 0

            # --- target suhu (R410A) ---
            outT = 32.0 + math.sin(self.t / 300.0) * 1.5 + (4.0 if sc == "beban-tinggi" else 0)
            roomT = 24.0 + math.sin(self.t / 240.0) * 0.8 \
                + (2.0 if sc == "beban-tinggi" else 0) + (0.5 if sc == "freon-kurang" else 0)
            evapT = 7.5 + math.sin(self.t / 53.0) * 0.5 + (1.5 if sc == "freon-kurang" else 0)
            kondT = outT + 12.0 + math.sin(self.t / 90.0) * 0.8 \
                + (3.0 if sc == "beban-tinggi" else 0) + (-2.0 if sc == "freon-kurang" else 0)

            if comp_on:
                st["room"] = self.lerp(st["room"], roomT, 0.15, 0.10)
                st["outdoor"] = self.lerp(st["outdoor"], outT, 0.10, 0.10)
                st["evap"] = self.lerp(st["evap"], evapT, 0.30, 0.12)
                st["ret"] = self.lerp(st["ret"], st["room"] + 1.5, k, 0.10)
                sup_extra = 3.0 if sc == "freon-kurang" else 0
                st["supply"] = self.lerp(st["supply"], st["ret"] - 10.5 + sup_extra, k, 0.12)
                st["kond"] = self.lerp(st["kond"], kondT, 0.20, 0.20)
                # Tekanan dari suhu saturasi. Titik kerja suction di tengah
                # rentang normal R410A (±5 psi/°C), bukan di bibir batas bawah.
                tsat_s = st["evap"] - 1.0
                tsat_c = st["kond"] + 1.0
                sucP_T = 126.0 + (st["evap"] - 7.5) * 5.0 + (-18.0 if sc == "freon-kurang" else 0)
                disP_T = 327.0 + (tsat_c - 37.8) / 0.12
                st["sucP"] = self.lerp(st["sucP"], sucP_T, k, 0.6)
                st["disP"] = self.lerp(st["disP"], disP_T, k, 2.0)
                sh_T = 6.0 + (5.0 if sc == "freon-kurang" else 0)
                sc_T = 6.0 + (-3.0 if sc == "freon-kurang" else 0)
                st["sh"] = self.lerp(st["sh"], sh_T, k, 0.2)
                st["sc"] = self.lerp(st["sc"], sc_T, k, 0.2)
                st["sucT"] = (tsat_s + st["sh"])
                st["liqT"] = (tsat_c - st["sc"])
                # IAQ: RH 45-58%, CO2 500-850 + ayunan okupansi
                rh_T = 52.0 + math.sin(self.t / 200.0) * 4.0 \
                    + (5.0 if sc == "beban-tinggi" else 0)
                co2_T = 620.0 + math.sin(self.t / 170.0) * 120.0 \
                    + (200.0 if sc == "beban-tinggi" else 0)
                st["rh"] = self.lerp(st["rh"], rh_T, 0.15, 0.4)
                st["co2"] = self.lerp(st["co2"], co2_T, 0.15, 8.0)
                # Elektrikal 3-phase 380-415V
                volt_T = 398.0 + math.sin(self.t / 47.0) * 4.0 \
                    + (-50.0 if sc == "tegangan-drop" else 0) + (-4.0 if sc == "beban-tinggi" else 0)
                if random.random() < 0.03:
                    volt_T -= 12.0
                st["volt"] = self.lerp(st["volt"], volt_T, 0.50, 1.2)
                amp_T = 7.4 + (st["disP"] - 365.0) * 0.02 \
                    + (1.2 if sc == "beban-tinggi" else 0) + (0.6 if sc == "tegangan-drop" else 0) \
                    + (-0.6 if sc == "freon-kurang" else 0)
                st["amp"] = max(0.5, self.lerp(st["amp"], amp_T, k, 0.10))
                st["flowS"] = self.lerp(st["flowS"], 2.4, k, 0.05)
                st["flowR"] = self.lerp(st["flowR"], 2.2, k, 0.05)
                st["flowO"] = self.lerp(st["flowO"], 3.0, k, 0.08)
                st["pf"] = self.lerp(st["pf"], 0.86, 0.2, 0.005)
                st["kw"] = 1.732 * st["volt"] * st["amp"] * st["pf"] / 1000.0
                st["comp"] = 1
            else:
                # Kompresor OFF: tekanan menyetarakan ~190 psi, arus fan, delta kecil
                st["evap"] = self.lerp(st["evap"], st["room"] - 10.0, 0.25, 0.12)
                st["ret"] = self.lerp(st["ret"], st["room"] + 1.5, 0.30, 0.10)
                st["supply"] = self.lerp(st["supply"], st["ret"] - 2.0, 0.30, 0.12)
                st["kond"] = self.lerp(st["kond"], st["kond"] - 1.0, 0.20, 0.15)
                st["sucP"] = self.lerp(st["sucP"], 185.0, 0.30, 0.8)
                st["disP"] = self.lerp(st["disP"], 195.0, 0.30, 1.5)
                st["sh"] = self.lerp(st["sh"], 2.0, 0.25, 0.2)
                st["sc"] = self.lerp(st["sc"], 1.0, 0.25, 0.2)
                st["sucT"] = self.lerp(st["sucT"], st["ret"] - 4.0, 0.3, 0.15)
                st["liqT"] = self.lerp(st["liqT"], st["outdoor"] + 2.0, 0.3, 0.15)
                st["amp"] = self.lerp(st["amp"], 0.5, 0.40, 0.03)
                st["flowS"] = self.lerp(st["flowS"], 0.0, 0.50, 0.02)
                st["flowR"] = self.lerp(st["flowR"], 0.0, 0.50, 0.02)
                st["flowO"] = self.lerp(st["flowO"], 0.0, 0.50, 0.03)
                st["kw"] = 1.732 * st["volt"] * st["amp"] * st["pf"] / 1000.0
                st["comp"] = 0
            # Chilled water (untuk AHU central): supply ~6.5C, delta ~4K
            chwS_T = 6.5 + math.sin(self.t / 200.0) * 0.5 + (1.5 if sc == "beban-tinggi" else 0)
            st["chwS"] = self.lerp(st["chwS"], chwS_T, 0.15, 0.08)
            st["chwR"] = self.lerp(st["chwR"], st["chwS"] + 4.2 + (1.0 if sc == "beban-tinggi" else 0), 0.15, 0.10)
            st["kwh"] += max(0.0, st["kw"]) * dt / 3600.0
            return dict(st)

    def snapshot(self):
        data = self.tick()
        delta = data["ret"] - data["supply"]
        alarm = 0
        # Tekanan hanya dinilai saat kompresor ON (saat OFF tekanan menyetarakan).
        if data["comp"] == 1:
            if data["sucP"] < 115 or data["sucP"] > 140:
                alarm |= 1 << 0
            if data["disP"] > 425:
                alarm |= 1 << 1
        if data["volt"] < 365 or data["volt"] > 415:
            alarm |= 1 << 2
        if data["co2"] > 1000:
            alarm |= 1 << 3
        r1 = lambda v: round(v, 1)
        out = {
            # Model baru (industri R410A)
            "suctionPressure": r1(data["sucP"]), "dischargePressure": r1(data["disP"]),
            "suctionTemp": r1(data["sucT"]), "liquidTemp": r1(data["liqT"]),
            "superheat": r1(data["sh"]), "subcooling": r1(data["sc"]),
            "supplyTemp": r1(data["supply"]), "returnTemp": r1(data["ret"]),
            "roomTemp": r1(data["room"]), "outdoorTemp": r1(data["outdoor"]),
            "roomRH": r1(data["rh"]), "co2": int(round(data["co2"])),
            "airflowSupply": round(data["flowS"], 2),
            "airflowReturn": round(data["flowR"], 2),
            "airflowOutdoor": round(data["flowO"], 2),
            "voltageLL": int(round(data["volt"])), "currentAvg": round(data["amp"], 2),
            "powerKW": round(data["kw"], 2), "energyKWh": round(data["kwh"], 2),
            "powerFactor": round(data["pf"], 3), "compStatus": data["comp"],
            "chwSupply": r1(data["chwS"]), "chwReturn": r1(data["chwR"]),
            "chwDelta": r1(data["chwR"] - data["chwS"]),
            "alarmCode": alarm, "scenario": self.scenario,
            # Alias kompatibel dashboard lama
            "lowPressure": r1(data["sucP"]), "highPressure": r1(data["disP"]),
            "tegangan": int(round(data["volt"])), "ampere": round(data["amp"], 2),
            "suhuInlet": r1(data["ret"]), "suhuOutlet": r1(data["supply"]),
            "suhuRuangan": r1(data["room"]), "suhuEvaporator": r1(data["evap"]),
            "suhuKondensor": r1(data["kond"]), "deltaTemp": r1(delta),
        }
        return out


SIM = HVACSim()

REGMAP = [  # (key JSON, tipe) - float32 menempati 2 register
    ("suctionPressure", "f32"), ("dischargePressure", "f32"),
    ("suctionTemp", "f32"), ("liquidTemp", "f32"),
    ("superheat", "f32"), ("subcooling", "f32"),
    ("supplyTemp", "f32"), ("returnTemp", "f32"),
    ("roomTemp", "f32"), ("outdoorTemp", "f32"),
    ("roomRH", "f32"), ("co2", "f32"),
    ("voltageLL", "f32"), ("currentAvg", "f32"),
    ("powerKW", "f32"), ("energyKWh", "f32"),
    ("powerFactor", "f32"), ("compStatus", "u16"), ("alarmCode", "u16"),
    ("chwSupply", "f32"), ("chwReturn", "f32"), ("chwDelta", "f32"),
    ("airflowSupply", "f32"), ("airflowReturn", "f32"), ("airflowOutdoor", "f32"),
]


def build_registers(data):
    regs = []
    for key, typ in REGMAP:
        v = data[key]
        if typ == "f32":
            regs.extend(struct.unpack(">HH", struct.pack(">f", float(v))))
        else:
            regs.append(int(v) & 0xFFFF)
    return regs


def modbus_server(host, port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(5)
    print(f"[modbus] slave Unit 1 di {host}:{port} (FC3/FC4)")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_modbus, args=(conn, addr), daemon=True).start()


def handle_modbus(conn, addr):
    try:
        while True:
            hdr = conn.recv(7)
            if len(hdr) < 7:
                break
            tid, pid, length, unit = struct.unpack(">HHHB", hdr)
            body = b""
            while len(body) < length - 1:
                chunk = conn.recv(length - 1 - len(body))
                if not chunk:
                    break
                body += chunk
            if len(body) < 5:
                break
            func, start, qty = struct.unpack(">BHH", body[:5])
            data = SIM.snapshot()
            regs = build_registers(data)
            if func in (3, 4) and start + qty <= len(regs):
                payload = b"".join(struct.pack(">H", r) for r in regs[start:start + qty])
                resp = struct.pack(">HHHB", tid, 0, 3 + len(payload), unit) \
                    + struct.pack(">BB", func, len(payload)) + payload
            else:
                resp = struct.pack(">HHHB", tid, 0, 3, unit) + struct.pack(">BB", func | 0x80, 0x02)
            conn.sendall(resp)
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        conn.close()


MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml"}
BASEDIR = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path in ("/data", "/api/data"):
            self.send_json(SIM.snapshot())
        elif p.path == "/health":
            self.send_json({"ok": True, "scenario": SIM.scenario})
        elif p.path == "/modbus-map":
            self.send_json({"unit": 1, "port": ARGS.modbus_port, "fc": [3, 4],
                            "map": [{"addr": sum(2 if t == "f32" else 1 for _, t in REGMAP[:i]),
                                     "key": k, "type": t} for i, (k, t) in enumerate(REGMAP)]})
        elif p.path == "/scenario":
            q = parse_qs(p.query)
            name = (q.get("name", [""])[0] or "").lower()
            if name in SCENARIOS:
                with SIM.lock:
                    SIM.scenario = name
                self.send_json({"ok": True, "scenario": name})
            else:
                self.send_json({"ok": False, "valid": list(SCENARIOS)}, 400)
        else:
            path = p.path if p.path != "/" else "/index.html"
            if "?" in path:
                path = path.split("?", 1)[0]
            fpath = os.path.normpath(os.path.join(BASEDIR, path.lstrip("/")))
            if not fpath.startswith(BASEDIR) or not os.path.isfile(fpath):
                self.send_response(404)
                self.end_headers()
                return
            ext = os.path.splitext(fpath)[1].lower()
            with open(fpath, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="normal", choices=list(SCENARIOS))
    ap.add_argument("--modbus-port", type=int, default=1502)
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ARGS = ap.parse_args()
    SIM.scenario = ARGS.scenario
    threading.Thread(target=modbus_server, args=(ARGS.host, ARGS.modbus_port), daemon=True).start()
    print(f"[http] http://{ARGS.host}:{ARGS.http_port}/  (skenario: {ARGS.scenario})")
    print(f"[http] GET /data  |  /scenario?name=beban-tinggi  |  /modbus-map")
    ThreadingHTTPServer((ARGS.host, ARGS.http_port), Handler).serve_forever()
