// ---- Clock ----------------------------------------------------------------
function updateClock() {
  const el = document.getElementById('clock');
  el.textContent = new Date().toLocaleString(undefined, {
    weekday: 'long', hour: 'numeric', minute: '2-digit',
  });
}
updateClock();
setInterval(updateClock, 30 * 1000);

// ---- Weather ---------------------------------------------------------------
// Weather codes -> plain-language condition (WMO codes, used by Open-Meteo)
const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
};

async function getApproxLocation() {
  // IP-based geolocation: no permission prompt, works with nobody at the
  // keyboard, which is exactly the situation a screensaver runs in.
  //
  // Deliberately http://, not https://. ip-api.com's free tier only
  // supports plain HTTP — the HTTPS endpoint returns a 403 with
  // "SSL unavailable for this endpoint, order a paid plan..." (confirmed
  // via curl on the physical Mint machine). This isn't a mixed-content
  // problem here: index.html is loaded via file://, not https://, so
  // Chromium doesn't block an http:// fetch from it the way it would from
  // a real https:// page.
  const res = await fetch('http://ip-api.com/json/');
  if (!res.ok) throw new Error('geolocation lookup failed');
  const data = await res.json();
  return { lat: data.lat, lon: data.lon, city: data.city, region: data.regionName };
}

async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather lookup failed');
  const data = await res.json();
  return {
    tempF: Math.round(data.current.temperature_2m),
    condition: WEATHER_CODES[data.current.weather_code] || 'Unknown',
  };
}

async function refreshWeather() {
  try {
    const loc = await getApproxLocation();
    const weather = await getWeather(loc.lat, loc.lon);

    document.getElementById('temp').textContent = `${weather.tempF}°`;
    document.getElementById('condition').textContent = weather.condition;
    document.getElementById('place').textContent = [loc.city, loc.region].filter(Boolean).join(', ');
  } catch (err) {
    document.getElementById('condition').textContent = 'Weather unavailable';
    console.error(err);
  }
}

refreshWeather();
setInterval(refreshWeather, 15 * 60 * 1000); // refresh every 15 min
