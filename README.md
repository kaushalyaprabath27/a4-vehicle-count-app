# A4 Classified Vehicle Count

Offline-first PWA for classified vehicle counts by time interval and direction, for the A4 Godagama – Avissawella widening (feasibility study). One row per interval goes to a Google Sheet through Google Apps Script. No login.

## How an enumerator uses it

1. **Setup:** enumerator name and count location (type the place, e.g. Hanwella junction, or use GPS). Then **Next**.
2. **Interval:** date (defaults to today), **From** and **To** (tap and roll the hour/minute wheels, or tap Now), and **Direction**: tap **To Colombo** or **From Colombo**, or **Other** to type another direction (e.g. Hanwella to Kaduwela).
3. **Count:** tap a counter for every vehicle that passes in that direction. Counters are in two groups, each with its own running total:
   - **Passenger vehicles:** Motorcycle, 3-wheeler, Taxi, Car / Jeep, Passenger van, Office van, School van, Minibus, Large bus.
   - **Freight vehicles:** Delivery van, Light truck (2 axles / 4 wheels), Medium truck (2 axles / 6 wheels), Large truck (2 axles / 6 wheels), Heavy vehicle (3 axles / 10 wheels), Container with trailer (3 axles / 20 ft), Container with trailer (multi-axle / 40 ft), Other freight.

   The **−** on a counter removes one; **Undo last tap** removes the last tap of any type.
4. **Notes** (optional): anything unusual in this interval (rain, accident, road blocked). If **Other freight** was counted, its vehicle type must be written here.
5. **Save interval:** writes one row with each type's count, the passenger, freight and overall totals. Counters reset and the next interval is filled in automatically (starts where the last ended, same length, same direction).
6. **Undo save** deletes the last saved interval (until it has been sent) and puts its counts back on the counters. **End** shows totals for the whole survey.

Running counts survive closing the app or a reload. To count both directions at one station, use one phone per direction.

## Data (sheet tab `a4-vehicle-counts`)

Enumerator, Location, Date, From, To, Interval (min), Direction, one column per vehicle type (17), Passenger Total, Freight Total, Total, Notes, Saved At, EventID.

The sheet menu **Vehicle Count → Build / refresh summary** makes two tabs:
- `Summary`: one row per Location × Date × Direction with each type's total, minutes counted and vehicles per hour.
- `Hourly`: the same per hour of the day (by the interval's From time), for peak-hour analysis.

## Deployment

1. **Backend:** new Google Sheet → Extensions → Apps Script → paste [`backend/a4_vehicle_count_apps_script.js`](backend/a4_vehicle_count_apps_script.js) → run `setup` once → Deploy → New deployment → Web app (Execute as: Me, Access: Anyone) → copy the `/exec` URL.
2. Paste the URL into `appsScriptUrl` in [`config.js`](config.js). Direction buttons (and optional location buttons) are also set there.
3. **Frontend:** push this folder to its own GitHub repo and connect it to Netlify (no build command, publish directory `.`).
4. After changing app files, bump `CACHE_NAME` in [`sw.js`](sw.js).

To change the vehicle types, edit `TYPES` at the top of [`app.js`](app.js) and `TYPE_COLUMNS` in the backend (same order).
