/**
 * A4 CLASSIFIED VEHICLE COUNT - APPS SCRIPT BACKEND
 * (A4 Godagama – Avissawella widening, feasibility study)
 *
 * No login: every enumerator's counts go to the one Google Sheet this
 * script is attached to. One row per counted interval.
 *
 * HOW TO DEPLOY:
 * 1. Create a new Google Sheet (e.g. "A4 Vehicle Count Data").
 * 2. In that sheet: Extensions > Apps Script.
 * 3. Delete the sample code, paste ALL of this file, press Ctrl+S.
 * 4. Select the function "setup" in the toolbar and click Run once
 *    (approve the permissions). This creates the data tab and headers.
 * 5. Deploy > New deployment > type "Web app":
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy and copy the Web app URL (ends in /exec).
 * 6. Paste that URL into config.js in the app (appsScriptUrl).
 *
 * UPDATING THE CODE LATER:
 *    Deploy > Manage deployments > Edit (pencil) > Version: "New version"
 *    > Deploy. The URL stays the same.
 */

const DATA_SHEET_NAME = "a4-vehicle-counts";
const SUMMARY_SHEET_NAME = "Summary";
const HOURLY_SHEET_NAME = "Hourly";

// Vehicle types: [sheet header, record field, group]. Same order as the app.
const TYPE_COLUMNS = [
  ["Motorcycle", "motorcycle", "P"],
  ["3-Wheeler", "threeWheeler", "P"],
  ["Taxi", "taxi", "P"],
  ["Car / Jeep", "carJeep", "P"],
  ["Passenger Van", "passengerVan", "P"],
  ["Office Van", "officeVan", "P"],
  ["School Van", "schoolVan", "P"],
  ["Minibus", "minibus", "P"],
  ["Large Bus", "largeBus", "P"],
  ["Delivery Van", "deliveryVan", "F"],
  ["Light Truck (2 axles / 4 wheels)", "lightTruck", "F"],
  ["Medium Truck (2 axles / 6 wheels)", "mediumTruck", "F"],
  ["Large Truck (2 axles / 6 wheels)", "largeTruck", "F"],
  ["Heavy Vehicle (3 axles / 10 wheels)", "heavyVehicle", "F"],
  ["Container with Trailer (3 axles / 20 ft)", "container20", "F"],
  ["Container with Trailer (multi-axle / 40 ft)", "container40", "F"],
  ["Other Freight", "otherFreight", "F"]
];

// [sheet header, record field, type]
const COLUMNS = [
  ["Enumerator", "name", "text"],
  ["Location", "location", "text"],
  ["Date", "date", "text"],
  ["From", "fromTime", "text"],
  ["To", "toTime", "text"],
  ["Interval (min)", "intervalMinutes", "num"],
  ["Direction", "direction", "text"]
].concat(TYPE_COLUMNS.map(function (t) { return [t[0], t[1], "num"]; }))
 .concat([
  ["Passenger Total", "passengerTotal", "num"],
  ["Freight Total", "freightTotal", "num"],
  ["Total", "total", "num"],
  ["Notes", "notes", "long"],
  ["Saved At", "savedAt", "text"],
  ["EventID", "eventId", "text"]
]);
const HEADERS = COLUMNS.map(function (c) { return c[0]; });
const EVENT_ID_COL = HEADERS.indexOf("EventID") + 1; // 1-based

const MAX_BATCH_SIZE = 200;
const GLOBAL_RATE_LIMIT_PER_MIN = 300;
const LOCK_WAIT_MS = 30000;

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------
function doPost(e) { return handleRequest(e); }
function doGet(e) { return handleRequest(e); }

function handleRequest(e) {
  if (!checkGlobalRateLimit()) {
    return responseJson({ status: "error", message: "Too many requests. Please try again shortly." });
  }
  try {
    let data = {};
    if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); } catch (err) {}
    }
    const params = (e && e.parameter) || {};
    for (const key in params) data[key] = params[key];

    const action = data.action;
    if (action === "submit_a4_vehcount_v1") return handleSubmitBatch(data);
    if (!action) return responseJson({ status: "success", message: "A4 vehicle count backend is running." });
    return responseJson({ status: "error", message: "Invalid action" });
  } catch (error) {
    return responseJson({ status: "error", message: error.toString() });
  }
}

// ---------------------------------------------------------------------
// Batch write
// ---------------------------------------------------------------------
function handleSubmitBatch(data) {
  const payload = Array.isArray(data.payload) ? data.payload : [];
  if (payload.length === 0) return responseJson({ status: "success", count: 0, duplicatesSkipped: 0 });
  if (payload.length > MAX_BATCH_SIZE) {
    return responseJson({ status: "error", message: "Batch too large (max " + MAX_BATCH_SIZE + ")." });
  }

  // One writer at a time, so concurrent enumerators never overwrite each
  // other's rows and the duplicate check sees every committed row.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return responseJson({ status: "error", message: "Server busy. The app will retry automatically." });
  }

  try {
    const sheet = getDataSheet();
    // Idempotency: an eventId already in the sheet is skipped (a batch
    // re-sent after a lost response is not written twice).
    const existing = getExistingEventIds(sheet);

    const rows = [];
    let duplicatesSkipped = 0;
    for (let i = 0; i < payload.length; i++) {
      const item = payload[i];
      if (!item || typeof item !== "object") continue;
      const id = item.eventId ? String(item.eventId) : "";
      if (id && existing[id]) { duplicatesSkipped++; continue; }
      if (id) existing[id] = true;
      rows.push(toRow(item));
    }

    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
      SpreadsheetApp.flush();
    }
    return responseJson({ status: "success", count: rows.length, duplicatesSkipped: duplicatesSkipped });
  } finally {
    lock.releaseLock();
  }
}

function toRow(item) {
  return COLUMNS.map(function (c) {
    const v = item[c[1]];
    if (c[2] === "num") return num(v);
    return text(v, c[2] === "long" ? 2000 : 300);
  });
}

// Plain text only: trims, caps length, and stops a typed value such as
// "=IMPORTXML(...)" from being run as a formula in the sheet.
function text(v, maxLen) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim().slice(0, maxLen || 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function num(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  return isFinite(n) ? n : "";
}

// ---------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------
function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet(); // set when attached to a sheet
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  const ss = SpreadsheetApp.create("A4 Vehicle Count Data");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function getDataSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (sheet && !hasCurrentHeaders(sheet)) {
    if (sheet.getLastRow() <= 1) {
      sheet.clear();
    } else {
      // Rows in an older column layout: keep them untouched under a new name.
      sheet.setName(DATA_SHEET_NAME + " (old " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmm") + ")");
      sheet = null;
    }
  }
  if (!sheet) sheet = ss.insertSheet(DATA_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold").setWrap(true);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasCurrentHeaders(sheet) {
  if (sheet.getLastRow() === 0) return true;
  if (sheet.getLastColumn() !== HEADERS.length) return false;
  const row = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  return row.every(function (v, i) { return String(v) === HEADERS[i]; });
}

function getExistingEventIds(sheet) {
  const seen = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return seen;
  const values = sheet.getRange(2, EVENT_ID_COL, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) seen[String(values[i][0])] = true;
  }
  return seen;
}

function responseJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkGlobalRateLimit() {
  const cache = CacheService.getScriptCache();
  const key = "global_rate_limit";
  const count = parseInt(cache.get(key) || "0", 10);
  if (count >= GLOBAL_RATE_LIMIT_PER_MIN) return false;
  cache.put(key, String(count + 1), 60);
  return true;
}

// Run once from the editor: creates the data tab + header row and asks for
// the permissions the web app needs.
function setup() {
  const sheet = getDataSheet();
  Logger.log("Data sheet ready: " + sheet.getParent().getUrl());
}

// ---------------------------------------------------------------------
// Summary tabs (menu: Vehicle Count > Build / refresh summary)
//   Summary: one row per Location x Date x Direction (whole day counted)
//   Hourly:  one row per Location x Date x Direction x hour (by the From time)
// Each with every vehicle type's total, the passenger / freight / overall
// totals, minutes counted and vehicles per hour.
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Vehicle Count")
    .addItem("Build / refresh summary", "buildSummary")
    .addToUi();
}

function buildSummary() {
  const ss = getSpreadsheet();
  const data = getDataSheet().getDataRange().getDisplayValues();
  const col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });
  const KEY_SEP = "||";
  const SUMS = TYPE_COLUMNS.map(function (t) { return t[0]; }).concat(["Passenger Total", "Freight Total", "Total"]);

  const daily = {}, hourly = {};
  const add = function (groups, key, row) {
    const g = groups[key] || (groups[key] = { intervals: 0, minutes: 0, first: "", last: "", sums: {} });
    g.intervals++;
    g.minutes += Number(row[col["Interval (min)"]]) || 0;
    const from = row[col["From"]], to = row[col["To"]];
    if (from && (!g.first || from < g.first)) g.first = from;
    if (to && (!g.last || to > g.last)) g.last = to;
    SUMS.forEach(function (h) { g.sums[h] = (g.sums[h] || 0) + (Number(row[col[h]]) || 0); });
  };
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[col["EventID"]] && !row[col["Total"]]) continue;
    const base = [row[col["Location"]], row[col["Date"]], row[col["Direction"]]];
    add(daily, base.join(KEY_SEP), row);
    const hour = String(row[col["From"]] || "").split(":")[0];
    const label = /^\d+$/.test(hour) ? ("0" + Number(hour)).slice(-2) + ":00–" + ("0" + ((Number(hour) + 1) % 24)).slice(-2) + ":00" : "?";
    add(hourly, base.concat([label]).join(KEY_SEP), row);
  }

  const write = function (name, keyHeads, groups) {
    const out = [keyHeads.concat(["Intervals", "Minutes counted", "First From", "Last To"], SUMS, ["Vehicles per hour"])];
    Object.keys(groups).sort().forEach(function (key) {
      const g = groups[key];
      out.push(key.split(KEY_SEP).concat(
        [g.intervals, g.minutes, g.first, g.last],
        SUMS.map(function (h) { return g.sums[h] || 0; }),
        [g.minutes ? Math.round(g.sums["Total"] * 60 / g.minutes * 10) / 10 : ""]
      ));
    });
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.clear();
    sheet.getRange(1, 1, out.length, out[0].length).setValues(out);
    sheet.getRange(1, 1, 1, out[0].length).setFontWeight("bold").setWrap(true);
    sheet.setFrozenRows(1);
  };
  write(SUMMARY_SHEET_NAME, ["Location", "Date", "Direction"], daily);
  write(HOURLY_SHEET_NAME, ["Location", "Date", "Direction", "Hour"], hourly);
}
