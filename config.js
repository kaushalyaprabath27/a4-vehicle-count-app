// Settings for this deployment. Edit here, not in app.js.
window.A4VC_CONFIG = {
    // Google Apps Script Web App URL (Deploy > Manage deployments, ends in /exec).
    // Until this is set, counts are kept safely on the device and are NOT sent.
    appsScriptUrl: 'https://script.google.com/macros/s/AKfycby6dBM1Q5TzgG7rd6scBjkN-_YC0o-8IuC26QfEdIaGLciLiBPi6xgvmY_rqqX00fJBqQ/exec',

    // Optional location buttons on the setup screen. Empty = the enumerator types the place (or uses GPS).
    locations: [],

    // Direction buttons for each interval: [label, Font Awesome icon]. Any other direction can be typed.
    directions: [['To Colombo', 'fa-arrow-left'], ['From Colombo', 'fa-arrow-right']]
};
