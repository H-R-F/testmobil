/*
 * Testmobil — Customer app logic (vanilla JS, no build step).
 * Talks ONLY to the real backend API (§27 rule 14: no frontend mock business logic).
 * Business rules (state machine, handover gate, pricing) are enforced server-side;
 * this file renders state and calls endpoints.
 */

// ── tiny helpers ────────────────────────────────────────────────────────────
const API_BASE = location.port === '5173' || location.hostname.endsWith('.pages.dev') ? 'http://localhost:3000' : '';
const $ = (id) => document.getElementById(id);
const money = (minor, cur = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(minor / 100);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let TOKEN = localStorage.getItem('tm_token') || null;
let USER = JSON.parse(localStorage.getItem('tm_user') || 'null');
let currentQuote = null;      // quote pending confirmation
let activeTripId = localStorage.getItem('tm_active_trip') || null;
let selectedVehicleId = localStorage.getItem('tm_vehicle') || null;
let pollTimer = null;
let ratingScore = 0;

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(API_BASE + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.code; err.status = res.status; throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = `toast ${kind}`;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}

function show(view) {
  for (const v of ['auth', 'home', 'trip', 'history']) $(`view-${v}`).classList.toggle('hidden', v !== view);
  $('tabbar').classList.toggle('hidden', !USER);
  $('btn-logout').classList.toggle('hidden', !USER);
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
}

// ── auth ────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  busy(e.target, true);
  try {
    const d = await api('/api/v1/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    if (d.user.role !== 'CUSTOMER') throw new Error('This app is for customers. Drivers use the driver app.');
    setSession(d);
  } catch (err) { toast(err.message, 'err'); } finally { busy(e.target, false); }
});

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  busy(e.target, true);
  try {
    const d = await api('/api/v1/auth/register/customer', { method: 'POST', body: {
      fullName: f.get('fullName'), phone: f.get('phone'), email: f.get('email'), password: f.get('password') } });
    setSession(d); toast('Welcome to Testmobil 🚗', 'ok');
  } catch (err) { toast(err.message, 'err'); } finally { busy(e.target, false); }
});

function setSession(d) {
  TOKEN = d.accessToken; USER = d.user;
  localStorage.setItem('tm_token', TOKEN); localStorage.setItem('tm_user', JSON.stringify(USER));
  afterLogin();
}
function logout() {
  TOKEN = null; USER = null; stopPolling();
  localStorage.removeItems?.call?.(); // no-op guard
  ['tm_token','tm_user','tm_active_trip','tm_vehicle'].forEach((k) => localStorage.removeItem(k));
  activeTripId = null; show('auth');
}
$('btn-logout').addEventListener('click', logout);

function busy(form, on) { form.querySelector('button[type=submit]') && (form.querySelector('button[type=submit]').disabled = on); }

// ── vehicles ────────────────────────────────────────────────────────────────
async function loadVehicles() {
  const vs = await api('/api/v1/customers/vehicles');
  const box = $('vehicle-list'); box.innerHTML = '';
  if (!vs.length) { box.innerHTML = '<span class="muted small">No vehicle yet — add one below.</span>'; selectedVehicleId = null; return; }
  if (!vs.some((v) => v.id === selectedVehicleId)) selectedVehicleId = vs[0].id;
  for (const v of vs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (v.id === selectedVehicleId ? ' sel' : '');
    b.textContent = `${v.plate} · ${v.make} ${v.model} (${v.transmission === 'MANUAL' ? 'MT' : 'AT'})`;
    b.onclick = () => { selectedVehicleId = v.id; localStorage.setItem('tm_vehicle', v.id); loadVehicles(); };
    box.appendChild(b);
  }
}
$('vehicle-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  try {
    await api('/api/v1/customers/vehicles', { method: 'POST', body: {
      plate: String(f.get('plate')).toUpperCase(), make: f.get('make'), model: f.get('model'), transmission: f.get('transmission') } });
    e.target.reset(); toast('Vehicle added', 'ok'); await loadVehicles();
  } catch (err) { toast(err.message, 'err'); }
});

// ── request → quote → confirm ───────────────────────────────────────────────
$('btn-geolocate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Geolocation not available on this device.', 'err');
  navigator.geolocation.getCurrentPosition(
    (p) => { $('request-form').plat.value = p.coords.latitude.toFixed(6); $('request-form').plng.value = p.coords.longitude.toFixed(6); toast('Location captured 📍', 'ok'); },
    () => toast('Could not read your location. Enter coordinates manually.', 'err'),
    { enableHighAccuracy: true, timeout: 8000 });
});

$('request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedVehicleId) return toast('Add your vehicle first — the driver needs to know what they will drive.', 'err');
  const f = new FormData(e.target);
  const btn = $('btn-quote'); btn.disabled = true; btn.textContent = 'Calculating…';
  try {
    currentQuote = await api('/api/v1/pricing/quote', { method: 'POST', body: {
      pickup: { lat: +f.get('plat'), lng: +f.get('plng'), label: f.get('pickup') },
      destination: { lat: +f.get('dlat'), lng: +f.get('dlng'), label: f.get('destination') },
      noteToDriver: f.get('note') || undefined } });
    renderQuote(currentQuote);
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Get price estimate'; }
});

function renderQuote(q) {
  $('quote-items').innerHTML = q.breakdown.items.map((i) => `<li><span>${i.label}</span><span>${money(i.amountMinor, q.breakdown.currency)}</span></li>`).join('');
  $('quote-total').textContent = money(q.breakdown.totalMinor, q.breakdown.currency);
  $('quote-exp').textContent = time(q.expiresAt);
  $('quote-box').classList.remove('hidden');
  $('quote-box').scrollIntoView({ behavior: 'smooth' });
}
$('btn-discard').addEventListener('click', () => { $('quote-box').classList.add('hidden'); currentQuote = null; });

$('btn-confirm').addEventListener('click', async () => {
  if (!currentQuote) return;
  const btn = $('btn-confirm'); btn.disabled = true; btn.textContent = 'Finding a driver…';
  try {
    const trip = await api('/api/v1/trips', { method: 'POST', body: { quoteId: currentQuote.id, vehicleId: selectedVehicleId, noteToDriver: $('request-form').note.value || undefined } });
    activeTripId = trip.id; localStorage.setItem('tm_active_trip', trip.id);
    $('quote-box').classList.add('hidden'); currentQuote = null;
    goTrip(); startPolling(); toast(trip.status === 'SEARCHING_DRIVER' ? 'Searching for nearby drivers…' : 'Trip created.', 'ok');
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = '✅ Confirm & find me a driver'; }
});

// ── live trip status (efficient polling; realtime WS is Phase 9) ────────────
const STATUS_UI = {
  REQUESTED:        ['Confirming your request…', ''],
  SEARCHING_DRIVER: ['🔍 Finding you a verified driver…', 'searching'],
  DRIVER_ASSIGNED:  ['✅ Driver found — heading to you', ''],
  DRIVER_EN_ROUTE:  ['🧑‍✈️ Driver on the way', ''],
  DRIVER_ARRIVED:   ['🏁 Your driver has arrived at the pickup!', 'arrived'],
  HANDOVER_PENDING: ['🔑 Vehicle handover — please review & confirm', 'arrived'],
  HANDOVER_CONFIRMED:['Handover confirmed — driver starting the trip', ''],
  TRIP_STARTED:     ['🚗 On the road — relaxing your ride home', 'arrived'],
  ARRIVING:         ['Almost there…', 'arrived'],
  TRIP_COMPLETED:   ['You\'re home! Payment captured.', 'done'],
  EMERGENCY:        ['🆘 Emergency response engaged. Stay where it is safe.', 'emergency'],
  CANCELLED_BY_CUSTOMER: ['Trip cancelled.', 'cancelled'],
  CANCELLED_BY_DRIVER:   ['Driver had to cancel — searching for a new one or refund issued.', 'cancelled'],
  DRIVER_NO_SHOW:   ['Driver did not show up. Refund processed.', 'cancelled'],
  CUSTOMER_NO_SHOW: ['Trip closed (customer no-show).', 'cancelled'],
  DISPUTED:         ['Trip under review by our team.', 'cancelled'],
};
const ORDER = Object.keys(STATUS_UI);

function goTrip() { show('trip'); }

async function refreshTrip() {
  if (!activeTripId) return;
  let trip;
  try { trip = await api(`/api/v1/trips/${activeTripId}`); }
  catch (err) { if (err.status === 404 || err.status === 403) { stopPolling(); activeTripId = null; localStorage.removeItem('tm_active_trip'); } return; }
  renderTrip(trip);
}

async function renderTrip(trip) {
  const [label, cls] = STATUS_UI[trip.status] ?? [trip.status, ''];
  const banner = $('trip-banner'); banner.textContent = label; banner.className = `status-banner ${cls}`;
  $('t-pickup').textContent = trip.origin.label || `${trip.origin.lat.toFixed(4)}, ${trip.origin.lng.toFixed(4)}`;
  $('t-dest').textContent = trip.destination.label || `${trip.destination.lat.toFixed(4)}, ${trip.destination.lng.toFixed(4)}`;
  $('t-price').textContent = money(trip.quoteSnapshot.totalMinor, trip.quoteSnapshot.currency);

  // progress along canonical flow
  const idx = ORDER.indexOf(trip.status), done = ['TRIP_COMPLETED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_DRIVER','DRIVER_NO_SHOW','CUSTOMER_NO_SHOW'].includes(trip.status);
  $('prog-bar').style.width = done ? '100%' : `${Math.min(95, Math.round((idx / 9) * 100))}%`;

  // driver card
  const dbox = $('driver-box');
  if (trip.driver) {
    dbox.classList.remove('hidden');
    $('d-name').textContent = trip.driver.name;
    $('d-meta').textContent = `Rating ${trip.driver.rating?.toFixed(1) ?? '–'} ★ · ${trip.driver.tripsCount ?? ''} trips · ${trip.pickupDistanceKm ? trip.pickupDistanceKm.toFixed(1) + ' km away' : ''}`;
  } else dbox.classList.add('hidden');
  $('t-eta').textContent = trip.etaSeconds ? `ETA ~${Math.max(1, Math.round(trip.etaSeconds / 60))} min` : '';

  // timeline (timestamped records §3.7)
  const tl = trip.timeline ?? [];
  $('t-timeline').innerHTML = tl.slice(-8).map((h, i, arr) =>
    `<li class="${i === arr.length - 1 ? 'now' : ''}">${time(h.at)} — ${h.to.replace(/_/g, ' ')}</li>`).join('');

  // handover panel (§7)
  const hoBox = $('handover-box');
  if (trip.status === 'HANDOVER_PENDING' || (trip.handovers ?? []).some((h) => h.phase === 'BEFORE' && !h.customerConfirmedAt)) {
    hoBox.classList.remove('hidden');
    const before = (trip.handovers ?? []).find((h) => h.phase === 'BEFORE');
    $('ho-details').innerHTML = before ? `
      <ul class="items">
        <li><span>Odometer</span><span>${before.odometerKm ?? '–'} km</span></li>
        <li><span>Fuel</span><span>${before.fuelLevelPercent != null ? before.fuelLevelPercent + '%' : '–'}</span></li>
        <li><span>Damage noted</span><span>${before.damageNotes.length ? before.damageNotes.map((d) => d.location).join(', ') : 'none recorded'}</span></li>
        <li><span>Driver confirmed</span><span>${before.driverConfirmedAt ? '✔ ' + time(before.driverConfirmedAt) : 'waiting…'}</span></li>
      </ul>` : '<p class="muted small">Waiting for driver to record vehicle condition…</p>';
    window._hoPending = before;
  } else hoBox.classList.add('hidden');

  // completion / rating
  const doneBox = $('done-box');
  if (trip.status === 'TRIP_COMPLETED') {
    doneBox.classList.remove('hidden'); stopPolling();
    $('done-summary').textContent = `Paid ${money(trip.quoteSnapshot.totalMinor, trip.quoteSnapshot.currency)} · ${trip.tripDistanceKm?.toFixed(1)} km. Thank you for not driving.`;
    $('rate-box').classList.toggle('hidden', !!trip.rated);
    if (trip.rated) $('done-summary').textContent += ' You already rated this trip.';
  } else doneBox.classList.add('hidden');

  // cancel/sos visibility
  const terminal = ['TRIP_COMPLETED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_DRIVER','DRIVER_NO_SHOW','CUSTOMER_NO_SHOW','DISPUTED'].includes(trip.status);
  $('btn-cancel').classList.toggle('hidden', terminal);
  if (terminal && activeTripId) { /* keep id for history view */ }
  if (!terminal && !pollTimer && USER) startPolling();
}

$('btn-ho-confirm').addEventListener('click', async () => {
  const ho = window._hoPending; if (!ho) return toast('Handover record not created yet.', 'err');
  try {
    await api(`/api/v1/handovers/${ho.id}/confirm-customer`, { method: 'POST', body: {} });
    toast('Handover confirmed ✔', 'ok'); refreshTrip();
  } catch (err) { toast(err.message, 'err'); }
});
$('btn-ho-reject').addEventListener('click', async () => {
  const ho = window._hoPending; if (!ho) return;
  const reason = prompt('What is wrong with the vehicle record? (e.g. missing scratch)');
  if (!reason) return;
  try { await api(`/api/v1/handovers/${ho.id}/reject`, { method: 'POST', body: { reason } }); toast('Handover rejected — driver notified.', 'ok'); refreshTrip(); }
  catch (err) { toast(err.message, 'err'); }
});

$('btn-cancel').addEventListener('click', async () => {
  if (!activeTripId) return;
  if (!confirm('Cancel this trip? A cancellation fee may apply once the driver has arrived.')) return;
  try {
    await api(`/api/v1/trips/${activeTripId}/transition`, { method: 'POST', body: { to: 'CANCELLED_BY_CUSTOMER' } });
    toast('Trip cancelled.', 'ok'); refreshTrip();
  } catch (err) { toast(err.message, 'err'); }
});

$('btn-sos').addEventListener('click', async () => {
  if (!confirm('Send SOS to the driver AND platform safety team?\n\n⚠️ SOS alerts people — it does NOT replace calling 112.')) return;
  const gps = $('request-form'); // reuse last known coords fallback below
  try {
    const trip = await api(`/api/v1/trips/${activeTripId}`);
    await api('/api/v1/incidents/sos', { method: 'POST', body: { tripId: activeTripId, gps: trip.origin, message: 'Customer SOS from app' } });
    toast('🆘 SOS sent. If in immediate danger, call 112.', 'err'); refreshTrip();
  } catch (err) { toast(err.message, 'err'); }
});

// rating
document.querySelectorAll('#stars button').forEach((b) => {
  b.addEventListener('click', () => {
    ratingScore = +b.dataset.s;
    document.querySelectorAll('#stars button').forEach((x) => x.classList.toggle('on', +x.dataset.s <= ratingScore));
  });
});
$('btn-rate').addEventListener('click', async () => {
  if (!ratingScore) return toast('Tap a star rating first.', 'err');
  try {
    await api(`/api/v1/trips/${activeTripId}/rating`, { method: 'POST', body: { score: ratingScore, comment: $('rate-comment').value || undefined } });
    $('rate-box').classList.add('hidden'); toast('Thanks for the feedback ⭐', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});
$('btn-new-trip').addEventListener('click', () => { activeTripId = null; localStorage.removeItem('tm_active_trip'); stopPolling(); show('home'); });

// ── history ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  const trips = await api('/api/v1/trips');
  const list = $('history-list'); list.innerHTML = '';
  $('history-empty').classList.toggle('hidden', trips.length > 0);
  for (const t of trips.slice().reverse()) {
    const el = document.createElement('div'); el.className = 'card hist-item';
    el.innerHTML = `<div><strong>${t.origin.label ?? 'Pickup'}</strong> → ${t.destination.label ?? 'Home'}<br />
      <span class="muted small">${new Date(t.createdAt).toLocaleString()} · ${t.tripDistanceKm?.toFixed(1)} km</span></div>
      <div style="text-align:right"><span class="st">${t.status.replace(/_/g,' ')}</span><br /><strong>${money(t.quoteSnapshot.totalMinor, t.quoteSnapshot.currency)}</strong></div>`;
    el.style.cursor = 'pointer';
    el.onclick = () => { activeTripId = t.id; renderTripCache(t); goTrip(); refreshTrip(); };
    list.appendChild(el);
  }
}
function renderTripCache(t){ /* light pre-render then authoritative refresh */ const c = t; renderTrip(c).catch?.(()=>{}); }

// ── polling control (Phase 9 replaces with WebSocket push) ─────────────────
function startPolling() { stopPolling(); refreshTrip(); pollTimer = setInterval(refreshTrip, 4000); }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ── tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  const tab = b.dataset.tab;
  if (tab === 'home') show('home');
  if (tab === 'trip') { if (activeTripId) { goTrip(); refreshTrip(); } else toast('No active trip yet.', 'err'); }
  if (tab === 'history') { show('history'); loadHistory(); }
}));

// ── boot ────────────────────────────────────────────────────────────────────
async function afterLogin() {
  show('home');
  await loadVehicles();
  if (activeTripId) {
    try { const t = await api(`/api/v1/trips/${activeTripId}`);
      const terminal = ['TRIP_COMPLETED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_DRIVER','DRIVER_NO_SHOW','CUSTOMER_NO_SHOW','DISPUTED'].includes(t.status);
      goTrip(); renderTrip(t); if (!terminal) startPolling();
    } catch { activeTripId = null; localStorage.removeItem('tm_active_trip'); }
  }
}

(async function init() {
  if (TOKEN && USER) { try { await api('/api/v1/auth/me'); await afterLogin(); } catch { logout(); } }
  else show('auth');
})();
