// Settings for this deployment. Edit here, not in app.js.
window.A4VC_CONFIG = {
    // Google Apps Script Web App URL (Deploy > Manage deployments, ends in /exec).
    // Until this is set, counts are kept safely on the device and are NOT sent.
    appsScriptUrl: 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE',

    // Count locations offered on the setup screen (any other place can be typed, or GPS used).
    locations: ['OD 1', 'OD 2', 'OD 3', 'OD 4', 'OD 5', 'OD 6', 'OD 7'],

    // Direction buttons for each interval: [label, Font Awesome icon]. Any other direction can be typed.
    directions: [['To Colombo', 'fa-arrow-left'], ['From Colombo', 'fa-arrow-right']]
};
