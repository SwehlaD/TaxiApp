const STORE_KEY = 'taxiAppState.v4';
const SESSION_KEY = 'taxiAppSession.v4';
const defaultSettings = { baseFare: 6, perMile: 2.25, bookingFee: 1.5, minimumFare: 10, driverCommission: 80 };
const views = { welcome: qs('#welcomeView'), auth: qs('#authView'), passenger: qs('#passengerView'), driver: qs('#driverView'), admin: qs('#adminView') };
let data = { users: [], rides: [], settings: Object.assign({}, defaultSettings) };
let session = loadSession();
let selectedRole = null;
let authMode = 'signin';
let backendAvailable = location.protocol === 'http:' || location.protocol === 'https:';
let deferredInstallPrompt = null;
let adminPricingDirty = false;
let rideMap = null;
let rideMapMarkers = [];

function qs(selector) { return document.querySelector(selector); }
function qsa(selector) { return Array.from(document.querySelectorAll(selector)); }
function on(selector, eventName, handler) { const element = qs(selector); if (element) element.addEventListener(eventName, handler); return element; }
function setBusy(element, busy) { if (!element) return; element.disabled = Boolean(busy); element.classList.toggle('is-busy', Boolean(busy)); }
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function money(value) { return '$' + Number(value || 0).toFixed(2); }
function nowLabel() { return new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function normalizePhone(value) { return value.replace(/\D/g, ''); }
function formatPhone(value) { const digits = normalizePhone(value); const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits; return local.length === 10 ? '(' + local.slice(0, 3) + ') ' + local.slice(3, 6) + '-' + local.slice(6) : value; }
function isValidPhone(value) { const digits = normalizePhone(value); const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits; return /^[2-9]\d{2}[2-9]\d{6}$/.test(local); }
function normalizeLocation(value) { return value.trim().replace(/\s+/g, ' '); }
function isValidLocation(value) { const location = normalizeLocation(value); return location.length >= 6 && /[a-zA-Z]/.test(location) && !/^(here|home|work|test|asdf|none|na|n\/a)$/i.test(location); }
function mapsDirectionsUrl(origin, destination) { return 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(destination) + '&travelmode=driving'; }
async function geocodeLocation(location) {
  if (!location) return null;
  try {
    const response = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(location));
    const results = await response.json();
    if (!results || !results[0]) return null;
    return { lat: Number(results[0].lat), lng: Number(results[0].lon), label: results[0].display_name || location };
  } catch (error) {
    return null;
  }
}
function clearRideMap() {
  const status = qs('#mapStatus');
  if (rideMap) rideMap.remove();
  rideMap = null;
  rideMapMarkers = [];
  const mapEl = qs('#rideMap');
  if (mapEl) mapEl.innerHTML = '';
  if (status) status.textContent = 'Map will appear when a ride is active.';
}
function addMapMarker(coords, label, color) {
  if (!rideMap || !coords) return;
  const marker = L.circleMarker([coords.lat, coords.lng], { radius: 9, color: color, fillColor: color, fillOpacity: 0.85, weight: 3 }).addTo(rideMap).bindPopup(label);
  rideMapMarkers.push(marker);
}
function markerPosition(point, bounds) {
  const lngSpan = bounds.east - bounds.west || 0.01;
  const latSpan = bounds.north - bounds.south || 0.01;
  return { left: ((point.lng - bounds.west) / lngSpan) * 100, top: ((bounds.north - point.lat) / latSpan) * 100 };
}
function renderFallbackMap(mapEl, points, ride, taxiDrivers) {
  const lats = points.map(point => point.lat);
  const lngs = points.map(point => point.lng);
  let south = Math.min.apply(null, lats);
  let north = Math.max.apply(null, lats);
  let west = Math.min.apply(null, lngs);
  let east = Math.max.apply(null, lngs);
  const latPad = Math.max((north - south) * 0.35, 0.015);
  const lngPad = Math.max((east - west) * 0.35, 0.015);
  const bounds = { south: south - latPad, north: north + latPad, west: west - lngPad, east: east + lngPad };
  const mapUrl = 'https://www.openstreetmap.org/export/embed.html?bbox=' + [bounds.west, bounds.south, bounds.east, bounds.north].map(encodeURIComponent).join('%2C') + '&layer=mapnik&marker=' + encodeURIComponent(ride.pickupCoords.lat + ',' + ride.pickupCoords.lng);
  const baseMarkers = [
    { coords: ride.pickupCoords, label: 'P', title: 'Pickup', className: 'pickup' },
    { coords: ride.destinationCoords, label: 'D', title: 'Destination', className: 'destination' }
  ];
  const taxiMarkers = taxiDrivers.map(function(taxi, index) {
    return { coords: taxi.driverLocation, label: 'T' + (taxiDrivers.length > 1 ? index + 1 : ''), title: 'Taxi: ' + taxi.name, className: 'taxi' };
  });
  const markers = baseMarkers.concat(taxiMarkers).filter(item => item.coords).map(function(item) {
    const pos = markerPosition(item.coords, bounds);
    return '<span class="fallback-marker ' + item.className + '" style="left:' + pos.left.toFixed(2) + '%;top:' + pos.top.toFixed(2) + '%" title="' + escapeHtml(item.title) + '">' + item.label + '</span>';
  }).join('');
  mapEl.innerHTML = '<iframe class="fallback-map-frame" src="' + mapUrl + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Ride map"></iframe><div class="fallback-marker-layer">' + markers + '</div>';
}
async function renderRideMap(ride, driver) {
  const mapEl = qs('#rideMap');
  const status = qs('#mapStatus');
  if (!mapEl) return;
  if (!ride) return clearRideMap();
  if (!ride.pickupCoords) ride.pickupCoords = await geocodeLocation(ride.pickup);
  if (!ride.destinationCoords) ride.destinationCoords = await geocodeLocation(ride.destination);
  const taxiDrivers = driver && driver.driverLocation ? [driver] : data.users.filter(function(user) { return user.role === 'driver' && user.online && user.driverLocation; });
  const taxiPoints = taxiDrivers.map(function(user) { return user.driverLocation; });
  const points = [ride.pickupCoords, ride.destinationCoords].concat(taxiPoints).filter(Boolean);
  if (!points.length) {
    mapEl.innerHTML = '';
    if (status) status.textContent = 'Could not load map coordinates yet. Use fuller addresses for better map results.';
    return;
  }
  if (rideMap) rideMap.remove();
  rideMap = null;
  rideMapMarkers = [];
  if (window.L) {
    rideMap = L.map(mapEl, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(rideMap);
    addMapMarker(ride.pickupCoords, 'Pickup: ' + ride.pickup, '#111111');
    addMapMarker(ride.destinationCoords, 'Destination: ' + ride.destination, '#b42318');
    taxiDrivers.forEach(function(taxi) { addMapMarker(taxi.driverLocation, 'Taxi location: ' + taxi.name, '#f5c400'); });
    if (ride.pickupCoords && ride.destinationCoords) L.polyline([[ride.pickupCoords.lat, ride.pickupCoords.lng], [ride.destinationCoords.lat, ride.destinationCoords.lng]], { color: '#111111', weight: 4, opacity: 0.65 }).addTo(rideMap);
    const bounds = L.latLngBounds(points.map(point => [point.lat, point.lng]));
    rideMap.fitBounds(bounds.pad(0.25));
  } else {
    renderFallbackMap(mapEl, points, ride, taxiDrivers);
  }
  if (status) status.textContent = taxiDrivers.length ? 'Showing taxi, pickup, and destination.' : 'Showing pickup and destination. Driver location appears after a driver shares it.';
}
async function shareDriverLocation() {
  if (!navigator.geolocation) return alert('Location sharing is not available on this device.');
  navigator.geolocation.getCurrentPosition(async function(position) {
    await loadData();
    const user = currentUser();
    if (!user) return;
    user.driverLocation = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, updatedAt: nowLabel() };
    await saveData();
    renderDriver();
  }, function() { alert('Location permission was denied. Enable location access to show the taxi on the map.'); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}
function normalizeData(value) { return { users: Array.isArray(value.users) ? value.users : [], rides: Array.isArray(value.rides) ? value.rides : [], supportTickets: Array.isArray(value.supportTickets) ? value.supportTickets : [], settings: Object.assign({}, defaultSettings, value.settings || {}) }; }
function loadSession() { try { const value = JSON.parse(localStorage.getItem(SESSION_KEY)); return value && value.token ? value : null; } catch (error) { return null; } }
function saveSession() { session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); }
function authHeaders() { return session && session.token ? { Authorization: 'Bearer ' + session.token } : {}; }
function loadLocalData() { try { return normalizeData(JSON.parse(localStorage.getItem(STORE_KEY)) || {}); } catch (error) { return normalizeData({}); } }
function saveLocalData() { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
function currentUser() { return data.users.find(function(user) { return session && user.id === session.userId; }); }
function showView(name) { Object.keys(views).forEach(function(key) { const view = views[key]; const active = key === name; view.classList.toggle('view-active', active); view.hidden = !active; view.setAttribute('aria-hidden', active ? 'false' : 'true'); }); }
function escapeHtml(value) { return String(value).replace(/[&<>"]/g, function(char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]; }); }
function estimatedMiles(pickup, destination) { return Math.max(1, Math.round(((pickup.length + destination.length) / 7) * 10) / 10); }
function calculateFare(pickup, destination) { const settings = data.settings; const subtotal = settings.baseFare + estimatedMiles(pickup, destination) * settings.perMile + settings.bookingFee; return Math.max(settings.minimumFare, Math.round(subtotal * 100) / 100); }
function driverPayout(fare) { return Math.round(Number(fare) * (data.settings.driverCommission / 100) * 100) / 100; }
function platformFee(fare) { return Math.round((Number(fare) - driverPayout(fare)) * 100) / 100; }

async function api(path, options) { const response = await fetch(path, Object.assign({ headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()) }, options || {})); const payload = await response.json().catch(function() { return {}; }); if (!response.ok) throw new Error(payload.error || 'Request failed'); return payload; }
async function loadData() { if (!session || !session.token) { data = loadLocalData(); return; } if (backendAvailable) { try { data = normalizeData(await api('/api/state')); return; } catch (error) { if (/Sign in required|User not found/i.test(error.message || '')) { session = null; saveSession(); data = loadLocalData(); return; } backendAvailable = false; } } data = loadLocalData(); }
async function saveData() { data = normalizeData(data); if (backendAvailable) { try { data = normalizeData(await api('/api/state', { method: 'PUT', body: JSON.stringify(data) })); return; } catch (error) { backendAvailable = false; } } saveLocalData(); }
async function refreshDataAndRender() { await loadData(); if (session && currentUser()) enterDashboard(); }

function setAuthMode(mode) {
  authMode = selectedRole === 'admin' ? 'signin' : mode;
  qs('#authModeTabs').style.display = selectedRole === 'admin' ? 'none' : 'grid';
  qs('#signInTab').classList.toggle('active', authMode === 'signin');
  qs('#createTab').classList.toggle('active', authMode === 'create');
  qs('#nameField').style.display = authMode === 'create' ? 'grid' : 'none';
  qs('#confirmPasswordField').style.display = authMode === 'create' ? 'grid' : 'none';
  qs('#confirmPasswordInput').required = authMode === 'create';
  qs('#passwordInput').autocomplete = authMode === 'create' ? 'new-password' : 'current-password';
  qs('#vehicleField').style.display = authMode === 'create' && selectedRole === 'driver' ? 'grid' : 'none';
  qs('#authSubmit').textContent = authMode === 'create' ? 'Create account' : 'Sign in';
  qs('#authTitle').textContent = authMode === 'create' ? 'Create your ' + selectedRole + ' account' : 'Welcome back';
  qs('#authMessage').textContent = '';
}
function openAuth(role) { selectedRole = role; qs('#authRoleLabel').textContent = role === 'admin' ? 'Admin Login' : role === 'driver' ? 'Driver Login' : 'Passenger Login'; qs('#authForm').reset(); setAuthMode('signin'); showView('auth'); }
async function handleAuth(event) {
  event.preventDefault();
  const submit = qs('#authSubmit');
  if (submit && submit.disabled) return;
  setBusy(submit, true);
  try {
    const phone = normalizePhone(qs('#phoneInput').value);
    const password = qs('#passwordInput').value;
    const confirmPassword = qs('#confirmPasswordInput').value;
    const name = qs('#nameInput').value.trim();
    const vehicle = qs('#vehicleInput').value.trim();
    if ((selectedRole !== 'admin' && !isValidPhone(phone)) || password.length < 4) return showAuthError(selectedRole === 'admin' ? 'Enter the admin phone and password.' : 'Use a valid 10-digit phone number and a password with at least 4 characters.');
    let result;
    if (authMode === 'create') {
      if (!name) return showAuthError('Enter your full name.');
      if (password !== confirmPassword) return showAuthError('Passwords do not match. Type them again.');
      if (selectedRole === 'driver' && !vehicle) return showAuthError('Enter vehicle details for the driver account.');
      result = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ role: selectedRole, name, phone, password, vehicle }) });
    } else {
      result = await api('/api/auth/signin', { method: 'POST', body: JSON.stringify({ role: selectedRole, phone, password }) });
    }
    session = { userId: result.user.id, role: result.user.role, token: result.token };
    backendAvailable = true;
    data = normalizeData(result.state);
    saveSession();
    enterDashboard();
  } catch (error) {
    showAuthError(error.message || 'Sign in failed.');
  } finally {
    setBusy(submit, false);
  }
}
function showAuthError(message) { qs('#authMessage').textContent = message; }
function enterDashboard() { const user = currentUser(); if (!user) { session = null; saveSession(); return showView('welcome'); } if (user.role === 'admin') { renderAdmin(); showView('admin'); } else if (user.role === 'driver') { renderDriver(); showView('driver'); } else { showView('passenger'); renderPassenger(); } }
async function logout() { await loadData(); const user = currentUser(); if (user && user.role === 'driver') { user.online = false; await saveData(); } session = null; saveSession(); showView('welcome'); }

function renderPassenger() { const user = currentUser(); qs('#passengerGreeting').textContent = 'Book a ride, ' + user.name.split(' ')[0]; renderPassengerStatus(); renderPassengerHistory(); updateFareEstimate(); }
function activePassengerRide() { const user = currentUser(); return data.rides.find(function(ride) { return ride.passengerId === user.id && ['requested', 'accepted', 'arrived', 'started'].includes(ride.status); }); }
function renderPassengerStatus() {
  const ride = activePassengerRide(); const status = qs('#passengerStatus');
  if (!ride) { status.innerHTML = '<strong>No active ride</strong><span>Enter a pickup and destination to request a taxi.</span>'; clearRideMap(); return; }
  const driver = data.users.find(function(user) { return user.id === ride.driverId; });
  renderRideMap(ride, driver);
  let details = '<span class="badge ' + (ride.status === 'requested' ? 'waiting' : '') + '">' + ride.status + '</span>';
  details += '<strong>' + escapeHtml(ride.pickup) + ' to ' + escapeHtml(ride.destination) + '</strong><span>Fare: ' + money(ride.fare) + '</span>';
  details += driver ? '<span>Driver: ' + escapeHtml(driver.name) + ' | ' + escapeHtml(driver.vehicle || 'Vehicle pending') + '</span>' : '<span>Waiting for an online driver to accept.</span>';
  details += '<div class="actions"><button class="danger-button" id="cancelRide" type="button">Cancel ride</button></div>'; status.innerHTML = details; qs('#cancelRide').addEventListener('click', cancelPassengerRide);
}
function renderPassengerHistory() { const user = currentUser(); const rides = data.rides.filter(function(ride) { return ride.passengerId === user.id && ['completed', 'cancelled'].includes(ride.status); }).slice().reverse(); qs('#passengerHistory').innerHTML = rides.length ? rides.map(renderHistoryCard).join('') : '<div class="empty-state">Completed and cancelled rides will appear here.</div>'; }
async function requestRide(event) { event.preventDefault(); const submit = event.submitter || qs('#rideForm button[type="submit"]'); if (submit && submit.disabled) return; setBusy(submit, true); try { await loadData(); if (activePassengerRide()) return alert('Finish or cancel your current ride before requesting another.'); const pickup = normalizeLocation(qs('#pickupInput').value); const destination = normalizeLocation(qs('#destinationInput').value); if (!isValidLocation(pickup) || !isValidLocation(destination)) return alert('Enter a real pickup and destination, like a street address, airport, landmark, city, and state.'); if (pickup.toLowerCase() === destination.toLowerCase()) return alert('Pickup and destination must be different.'); const pickupCoords = await geocodeLocation(pickup); const destinationCoords = await geocodeLocation(destination); const fare = calculateFare(pickup, destination); data.rides.push({ id: uid('ride'), passengerId: currentUser().id, driverId: null, pickup, destination, pickupCoords, destinationCoords, fare, driverPayout: driverPayout(fare), platformFee: platformFee(fare), navigationUrl: mapsDirectionsUrl(pickup, destination), status: 'requested', requestedAt: nowLabel(), acceptedAt: null, completedAt: null }); await saveData(); qs('#rideForm').reset(); updateFareEstimate(); renderPassenger(); } finally { setBusy(submit, false); } }
async function cancelPassengerRide() { await loadData(); const ride = activePassengerRide(); if (!ride) return; if (!confirm('Are you sure you want to cancel this ride?')) return; ride.status = 'cancelled'; ride.completedAt = nowLabel(); await saveData(); renderPassenger(); }

function renderDriver() { const user = currentUser(); qs('#driverGreeting').textContent = 'Driver dashboard, ' + user.name.split(' ')[0]; qs('#availabilityToggle').checked = Boolean(user.online); qs('#driverMode').textContent = user.online ? 'You are online and receiving requests' : 'You are offline'; qs('#driverLocationStatus').textContent = user.driverLocation ? 'Location shared ' + (user.driverLocation.updatedAt || '') : 'Location not shared'; const completed = data.rides.filter(function(ride) { return ride.driverId === user.id && ride.status === 'completed'; }); qs('#driverEarnings').textContent = money(completed.reduce(function(total, ride) { return total + Number(ride.driverPayout || driverPayout(ride.fare)); }, 0)); qs('#driverTrips').textContent = String(completed.length); renderOpenRequests(); renderDriverActiveTrip(); renderDriverHistory(); }
function activeDriverRide() { const user = currentUser(); return data.rides.find(function(ride) { return ride.driverId === user.id && ['accepted', 'arrived', 'started'].includes(ride.status); }); }
function renderOpenRequests() { const user = currentUser(); const list = qs('#requestList'); if (!user.online) { list.innerHTML = '<div class="empty-state">Go online to receive nearby passenger requests.</div>'; return; } if (activeDriverRide()) { list.innerHTML = '<div class="empty-state">Complete your active trip before accepting another request.</div>'; return; } const requests = data.rides.filter(function(ride) { return ride.status === 'requested'; }); list.innerHTML = requests.length ? requests.map(function(ride) { const passenger = data.users.find(function(user) { return user.id === ride.passengerId; }); const navUrl = ride.navigationUrl || mapsDirectionsUrl(ride.pickup, ride.destination); return '<div class="request-card"><strong>' + escapeHtml(passenger ? passenger.name : 'Passenger') + '</strong><span>' + escapeHtml(ride.pickup) + ' to ' + escapeHtml(ride.destination) + '</span><span>' + money(ride.fare) + ' fare | ' + money(ride.driverPayout || driverPayout(ride.fare)) + ' driver payout</span><div class="actions"><button class="primary-button accept-request" data-id="' + ride.id + '" type="button">Accept ride</button><a class="map-link" href="' + escapeHtml(navUrl) + '" target="_blank" rel="noopener">Preview route</a></div></div>'; }).join('') : '<div class="empty-state">No open requests yet.</div>'; }
function renderDriverActiveTrip() { const ride = activeDriverRide(); const panel = qs('#driverActiveTrip'); if (!ride) { panel.innerHTML = '<strong>No active trip</strong><span>Accepted rides will appear here with trip controls.</span>'; return; } const passenger = data.users.find(function(user) { return user.id === ride.passengerId; }); const pickupUrl = mapsDirectionsUrl('Current Location', ride.pickup); const tripUrl = ride.navigationUrl || mapsDirectionsUrl(ride.pickup, ride.destination); let action = ''; if (ride.status === 'accepted') action = '<button class="primary-button trip-action" data-next="arrived" type="button">Mark arrived</button>'; if (ride.status === 'arrived') action = '<button class="primary-button trip-action" data-next="started" type="button">Start trip</button>'; if (ride.status === 'started') action = '<button class="success-button trip-action" data-next="completed" type="button">Complete trip</button>'; panel.innerHTML = '<span class="badge">' + ride.status + '</span><strong>' + escapeHtml(ride.pickup) + ' to ' + escapeHtml(ride.destination) + '</strong><span>Passenger: ' + escapeHtml(passenger ? passenger.name : 'Passenger') + '</span><span>Fare: ' + money(ride.fare) + ' | Driver payout: ' + money(ride.driverPayout || driverPayout(ride.fare)) + '</span><div class="actions"><a class="map-link" href="' + escapeHtml(pickupUrl) + '" target="_blank" rel="noopener">Navigate to pickup</a><a class="map-link" href="' + escapeHtml(tripUrl) + '" target="_blank" rel="noopener">Navigate trip</a></div><div class="actions">' + action + '<button class="danger-button trip-action" data-next="cancelled" type="button">Cancel</button></div>'; }
function renderDriverHistory() { const user = currentUser(); const rides = data.rides.filter(function(ride) { return ride.driverId === user.id && ['completed', 'cancelled'].includes(ride.status); }).slice().reverse(); qs('#driverHistory').innerHTML = rides.length ? rides.map(renderHistoryCard).join('') : '<div class="empty-state">Finished driver trips will appear here.</div>'; }
function renderHistoryCard(ride) { return '<div class="history-card"><span class="badge ' + (ride.status === 'completed' ? 'done' : 'cancelled') + '">' + ride.status + '</span><strong>' + escapeHtml(ride.pickup) + ' to ' + escapeHtml(ride.destination) + '</strong><span class="history-meta">Fare ' + money(ride.fare) + ' | Driver ' + money(ride.driverPayout || driverPayout(ride.fare)) + ' | Platform ' + money(ride.platformFee || platformFee(ride.fare)) + ' | Requested ' + ride.requestedAt + (ride.completedAt ? ' | Closed ' + ride.completedAt : '') + '</span></div>'; }
async function acceptRide(rideId) { await loadData(); const ride = data.rides.find(function(candidate) { return candidate.id === rideId; }); if (!ride || ride.status !== 'requested' || activeDriverRide()) return; ride.driverId = currentUser().id; ride.status = 'accepted'; ride.acceptedAt = nowLabel(); ride.driverPayout = ride.driverPayout || driverPayout(ride.fare); ride.platformFee = ride.platformFee || platformFee(ride.fare); await saveData(); renderDriver(); }
async function changeTripStatus(nextStatus) { await loadData(); const ride = activeDriverRide(); if (!ride) return; if (nextStatus === 'cancelled' && !confirm('Are you sure you want to cancel this trip?')) return; ride.status = nextStatus; if (['completed', 'cancelled'].includes(nextStatus)) ride.completedAt = nowLabel(); await saveData(); renderDriver(); }
function updateFareEstimate() { const pickup = qs('#pickupInput').value.trim(); const destination = qs('#destinationInput').value.trim(); qs('#fareEstimate').textContent = money(calculateFare(pickup, destination)); }

function renderAdmin() {
  const completed = data.rides.filter(function(ride) { return ride.status === 'completed'; });
  const pricingForm = qs('#pricingForm');
  const editingPricing = adminPricingDirty || pricingForm.contains(document.activeElement);
  qs('#adminUsers').textContent = String(data.users.length);
  qs('#adminRides').textContent = String(data.rides.length);
  qs('#adminRevenue').textContent = money(completed.reduce(function(total, ride) { return total + Number(ride.platformFee || platformFee(ride.fare)); }, 0));
  qs('#adminOpenRides').textContent = String(data.rides.filter(function(ride) { return ride.status === 'requested'; }).length);
  if (!editingPricing) {
    qs('#baseFareInput').value = data.settings.baseFare;
    qs('#perMileInput').value = data.settings.perMile;
    qs('#bookingFeeInput').value = data.settings.bookingFee;
    qs('#minimumFareInput').value = data.settings.minimumFare;
    qs('#driverCommissionInput').value = data.settings.driverCommission;
  }
  qs('#adminUserList').innerHTML = data.users.length ? data.users.map(renderAdminUser).join('') : '<div class="empty-state">No users yet.</div>';
  qs('#adminRideList').innerHTML = data.rides.length ? data.rides.slice().reverse().map(renderAdminRide).join('') : '<div class="empty-state">No rides yet.</div>';
  renderAdminSupport();
}
function renderAdminUser(user) { return '<div class="history-card"><span class="badge">' + escapeHtml(user.role) + '</span><strong>' + escapeHtml(user.name) + '</strong><span class="history-meta">Phone ' + escapeHtml(formatPhone(user.phone)) + (user.vehicle ? ' | ' + escapeHtml(user.vehicle) : '') + (user.online ? ' | Online' : '') + '</span></div>'; }
function renderAdminRide(ride) { const passenger = data.users.find(function(user) { return user.id === ride.passengerId; }); const driver = data.users.find(function(user) { return user.id === ride.driverId; }); return '<div class="history-card"><span class="badge ' + (ride.status === 'completed' ? 'done' : ride.status === 'cancelled' ? 'cancelled' : 'waiting') + '">' + escapeHtml(ride.status) + '</span><strong>' + escapeHtml(ride.pickup) + ' to ' + escapeHtml(ride.destination) + '</strong><span class="history-meta">Passenger ' + escapeHtml(passenger ? passenger.name : 'Unknown') + ' | Driver ' + escapeHtml(driver ? driver.name : 'Unassigned') + ' | Fare ' + money(ride.fare) + ' | Platform ' + money(ride.platformFee || platformFee(ride.fare)) + '</span></div>'; }
async function savePricing(event) {
  event.preventDefault();
  const nextSettings = {
    baseFare: Number(qs('#baseFareInput').value),
    perMile: Number(qs('#perMileInput').value),
    bookingFee: Number(qs('#bookingFeeInput').value),
    minimumFare: Number(qs('#minimumFareInput').value),
    driverCommission: Number(qs('#driverCommissionInput').value)
  };
  if (Object.values(nextSettings).some(function(value) { return Number.isNaN(value) || value < 0; }) || nextSettings.driverCommission > 100) {
    qs('#pricingMessage').textContent = 'Check the pricing fields. Commission must be between 0 and 100.';
    return;
  }
  data.settings = nextSettings;
  adminPricingDirty = false;
  await saveData();
  qs('#pricingMessage').textContent = 'Pricing updated. New ride requests will use these rates.';
  renderAdmin();
}

function renderAdminSupport() { const tickets = data.supportTickets.slice().reverse(); qs('#adminSupportList').innerHTML = tickets.length ? tickets.map(function(ticket) { const user = data.users.find(function(candidate) { return candidate.id === ticket.userId; }); return '<div class="history-card"><span class="badge waiting">' + escapeHtml(ticket.role) + '</span><strong>' + escapeHtml(user ? user.name : 'Unknown user') + '</strong><span>' + escapeHtml(ticket.message) + '</span><span class="history-meta">' + escapeHtml(ticket.createdAt) + ' | ' + escapeHtml(user ? formatPhone(user.phone) : 'No phone') + '</span></div>'; }).join('') : '<div class="empty-state">Customer service messages will appear here.</div>'; }
async function submitSupport(event) { event.preventDefault(); const form = event.currentTarget; const messageInput = form.querySelector('textarea[name="message"]'); const status = form.querySelector('[data-support-message]'); const message = messageInput.value.trim(); await loadData(); const user = currentUser(); if (message.length < 8) { status.textContent = 'Please describe the issue in a little more detail.'; return; } data.supportTickets.push({ id: uid('support'), userId: user.id, role: user.role, message: message, status: 'open', createdAt: nowLabel() }); await saveData(); messageInput.value = ''; status.textContent = 'Sent. Customer service can now review this message.'; }

function setupInstallPrompt() {
  const installButton = qs('#installAppButton');
  window.addEventListener('beforeinstallprompt', function(event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async function() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });
  window.addEventListener('appinstalled', function() {
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });
}

function bindEvents() {
  qsa('[data-role]').forEach(function(button) { button.addEventListener('click', function() { openAuth(button.dataset.role); }); });
  on('#authBack', 'click', function() { showView('welcome'); });
  on('#signInTab', 'click', function() { setAuthMode('signin'); });
  on('#createTab', 'click', function() { setAuthMode('create'); });
  on('#authForm', 'submit', handleAuth);
  qsa('[data-logout]').forEach(function(button) { button.addEventListener('click', logout); });
  on('#rideForm', 'submit', requestRide);
  on('#pickupInput', 'input', updateFareEstimate);
  on('#destinationInput', 'input', updateFareEstimate);
  on('#refreshPassenger', 'click', refreshDataAndRender);
  on('#availabilityToggle', 'change', async function(event) { await loadData(); const user = currentUser(); if (!user) return; user.online = event.target.checked; await saveData(); renderDriver(); });
  on('#requestList', 'click', function(event) { const button = event.target.closest('.accept-request'); if (button && !button.disabled) acceptRide(button.dataset.id); });
  on('#driverActiveTrip', 'click', function(event) { const button = event.target.closest('.trip-action'); if (button && !button.disabled) changeTripStatus(button.dataset.next); });
  on('#pricingForm', 'submit', savePricing);
  on('#shareDriverLocation', 'click', shareDriverLocation);
  on('#pricingForm', 'input', function() { adminPricingDirty = true; qs('#pricingMessage').textContent = ''; });
  qsa('.support-form').forEach(function(form) { form.addEventListener('submit', submitSupport); });
  window.addEventListener('storage', function(event) { if (event.key === STORE_KEY || event.key === SESSION_KEY) { session = loadSession(); refreshDataAndRender(); } });
}async function init() { bindEvents(); setupInstallPrompt(); setAuthMode('signin'); await loadData(); if (session && currentUser()) enterDashboard(); if ('serviceWorker' in navigator) window.addEventListener('load', function() { navigator.serviceWorker.register('sw.js').catch(function() {}); }); setInterval(function() { if (session && views[session.role] && views[session.role].classList.contains('view-active')) refreshDataAndRender(); }, 4000); }
init();




