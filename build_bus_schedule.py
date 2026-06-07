#!/usr/bin/env python3
"""
Preprocessa il GTFS di Bologna per estrarre gli orari del bus 13
alla fermata DIRETTISSIMA direzione centro (stop 9025, direction 0).
Output: bus_schedule.json usato dal server Node.js.
"""
import csv, json, zipfile, sys
from collections import defaultdict

GTFS_ZIP = "/Users/raffaelegiustini/Downloads/gommagtfsbo_20260522.zip"
OUTPUT   = "/Users/raffaelegiustini/Documents/Claude/treni/bus_schedule.json"

# Fermata e linea di interesse
STOP_ID        = "9026"   # DIRETTISSIMA verso centro
DIRECTION_ID   = "1"      # verso Piazza Malpighi / Minghetti
LINE_SHORT     = "13"

DOW = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]

def read(zf, name):
    with zf.open(name) as f:
        return list(csv.DictReader(line.decode() for line in f))

def strip(d):
    return {k: v.strip('"').strip() for k, v in d.items()}

print("Apertura GTFS...")
with zipfile.ZipFile(GTFS_ZIP) as zf:
    routes       = [strip(r) for r in read(zf, "routes.txt")]
    trips        = [strip(r) for r in read(zf, "trips.txt")]
    stop_times   = [strip(r) for r in read(zf, "stop_times.txt")]
    calendar     = [strip(r) for r in read(zf, "calendar.txt")]
    cal_dates    = [strip(r) for r in read(zf, "calendar_dates.txt")]

# Route id per linea 13
route_id = next(r["route_id"] for r in routes if r["route_short_name"] == LINE_SHORT)
print(f"Route ID linea {LINE_SHORT}: {route_id}")

# trip_id → service_id per direction 0
trip_service = {
    t["trip_id"]: t["service_id"]
    for t in trips
    if t["route_id"] == route_id and t.get("direction_id","0") == DIRECTION_ID
}
print(f"Trips direction {DIRECTION_ID}: {len(trip_service)}")

# service_id → set di days-of-week (0=mon..6=sun) e date ranges
service_days = defaultdict(set)   # service_id -> set of dow indices
service_range = {}                 # service_id -> (start, end)
for row in calendar:
    sid = row["service_id"]
    for i, d in enumerate(DOW):
        if row.get(d,"0") == "1":
            service_days[sid].add(i)
    service_range[sid] = (row["start_date"], row["end_date"])

# calendar_dates overrides: {(service_id, date): exception_type}
cal_overrides = {
    (r["service_id"], r["date"]): r["exception_type"]
    for r in cal_dates
}

# Raccogli orari alla fermata di interesse
# Risultato: {service_id: [times...]}
service_times = defaultdict(list)
for row in stop_times:
    tid = row["trip_id"]
    if tid not in trip_service:
        continue
    if row["stop_id"] != STOP_ID:
        continue
    t = row["arrival_time"]
    h, m, s = map(int, t.split(":"))
    if h >= 24:
        continue  # ignora corse a cavallo di mezzanotte
    service_times[trip_service[tid]].append(f"{h:02d}:{m:02d}")

# Deduplica e ordina
for sid in service_times:
    service_times[sid] = sorted(set(service_times[sid]))

print(f"Service IDs con orari: {len(service_times)}")

# Costruisci lookup finale: per ogni data (YYYYMMDD) e per ogni dow
# Usiamo una struttura: dow_schedules[dow] = sorted unique times (unione di tutti i service)
# + date_overrides per eccezioni

# Per semplicità il server userà: per ogni richiesta, calcola data odierna,
# guarda quale service è attivo, restituisce gli orari.
# Esportiamo: lista di (service_id, days_of_week, start_date, end_date, times[])
# + calendar_dates exceptions

services_export = []
for sid, times in service_times.items():
    if not times:
        continue
    days = sorted(service_days.get(sid, []))
    rng = service_range.get(sid, ("20000101","29991231"))
    services_export.append({
        "service_id": sid,
        "days_of_week": days,
        "start_date": rng[0],
        "end_date": rng[1],
        "times": times,
    })

# Eccezioni per le date specifiche
exceptions_export = []
for (sid, date), exc_type in cal_overrides.items():
    if sid in service_times:
        exceptions_export.append({
            "service_id": sid,
            "date": date,
            "type": exc_type,  # "1"=added, "2"=removed
        })

out = {
    "line": LINE_SHORT,
    "stop_id": STOP_ID,
    "stop_name": "DIRETTISSIMA",
    "direction": "Centro (Piazza Malpighi)",
    "services": services_export,
    "exceptions": exceptions_export,
}

with open(OUTPUT, "w") as f:
    json.dump(out, f, separators=(",",":"))

print(f"Scritto {OUTPUT} ({len(services_export)} service_ids, {len(exceptions_export)} eccezioni)")
