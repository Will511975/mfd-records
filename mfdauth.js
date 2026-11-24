/* ============================================================
   MFD Records System — Password Gate + Roles + Reports
   Shared across all module pages (same-origin localStorage).

   - Login is per-person: username = last name (from the Roster),
     password = set by an Admin (temporary), then changed by the person.
   - Roles: "admin" (full access everywhere) and "personnel"
     (view everything, no editing anywhere; can add a Report only
     from the Timecards page; can view Reports everywhere).
   - Sign-in is a real Firebase account (see mfd-sync.js). The first
     Admin is created by hand in the Firebase console; every other
     login is created by an Admin from the Roster.
   - Session stays unlocked while navigating between pages/tabs;
     closing the browser/tab clears it (sessionStorage).
   ============================================================ */
(function () {

  // ---- Dashboard embeds (?dash=...): the Dashboard page already shows one account bar ----
  try {
    var __q = /[?&]dash=/;
    if (__q.test(location.search) || (window.parent !== window && __q.test(window.parent.location.search))) {
      var __st = document.createElement('style'); __st.setAttribute('data-dash-embed','1');
      __st.textContent = '.mfd-floating-bar, #mfdReportsModal { display:none !important; }';
      document.head.appendChild(__st);
    }
  } catch (e) { /* ignore */ }

  // ---- Shared "Deleted … Undo" bar (window.mfdUndo(message, undoFn)) ----
  (function () {
    var bar = null, timer = null;
    function ensure() {
      if (bar) return bar;
      var st = document.createElement('style');
      st.textContent = '#mfdUndoBar{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483000;display:none;align-items:center;gap:12px;background:#1e293b;color:#f1f5f9;border:1px solid #475569;border-radius:10px;padding:10px 14px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:600 13px/1.3 Inter,system-ui,sans-serif;max-width:92vw}'
        + '#mfdUndoBar button{font:700 13px Inter,system-ui,sans-serif;cursor:pointer;border-radius:7px;padding:5px 12px;border:1px solid #475569;background:#334155;color:#f1f5f9}'
        + '#mfdUndoBar .u-go{background:#dc2626;border-color:#dc2626;color:#fff}#mfdUndoBar .u-x{background:none;border:none;color:#94a3b8;padding:2px 6px}';
      document.head.appendChild(st);
      bar = document.createElement('div'); bar.id = 'mfdUndoBar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
      document.body.appendChild(bar);
      return bar;
    }
    function hide() { clearTimeout(timer); if (bar) bar.style.display = 'none'; }
    function note(msg) {
      var b = ensure(); clearTimeout(timer); b.innerHTML = ''; var m = document.createElement('span'); m.textContent = msg; b.appendChild(m);
      b.style.display = 'flex'; timer = setTimeout(hide, 2500);
    }
    window.mfdUndo = function (message, undoFn, seconds) {
      var b = ensure(); clearTimeout(timer); b.innerHTML = '';
      var m = document.createElement('span'); m.textContent = message;
      var u = document.createElement('button'); u.className = 'u-go'; u.type = 'button'; u.textContent = 'Undo';
      var x = document.createElement('button'); x.className = 'u-x'; x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
      b.appendChild(m); b.appendChild(u); b.appendChild(x); b.style.display = 'flex';
      u.onclick = function () { hide(); try { undoFn(); note('Restored ✓'); } catch (e) { console.error('Undo failed', e); note('Sorry, that could not be undone.'); } };
      x.onclick = hide;
      timer = setTimeout(hide, (seconds || 12) * 1000);
    };
  })();
  const MEMBERS_KEY = 'mfd_members_v5';
  const SESSION_KEY = 'mfd_authSession';       // sessionStorage
  const REPORTS_KEY = 'mfd_reports_v1';        // localStorage

  function getMembers() {
    try { return JSON.parse(localStorage.getItem(MEMBERS_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveMembers(list) { localStorage.setItem(MEMBERS_KEY, JSON.stringify(list)); }

  function lastNameOf(fullName) {
    const parts = (fullName || '').trim().split(/\s+/);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function getReports() {
    try { return JSON.parse(localStorage.getItem(REPORTS_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveReports(list) { localStorage.setItem(REPORTS_KEY, JSON.stringify(list)); }

  // Exposed so page-specific UI (e.g. Timecards "Submit a Report") can add one.
  window.MFD_addReport = function (text) {
    if (!window.MFD_AUTH || !text || !text.trim()) return false;
    const reports = getReports();
    reports.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      authorName: window.MFD_AUTH.name,
      authorRole: window.MFD_AUTH.role,
      text: text.trim()
    });
    saveReports(reports);
    return true;
  };

  const style = document.createElement('style');
  style.textContent = `
    #mfdAuthGate {
      position: fixed; inset: 0; z-index: 999999;
      background: linear-gradient(160deg, #1a1a1a 0%, #3d0d0d 100%);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Inter', system-ui, sans-serif;
      padding: 20px; overflow-y: auto;
    }
    .mfd-gate-box {
      background: #fff; border-radius: 14px; padding: 36px 32px;
      max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      border-top: 5px solid #C8922A; margin: auto;
    }
    .mfd-gate-shield { font-size: 40px; margin-bottom: 10px; }
    .mfd-gate-box h2 { font-size: 20px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px; }
    .mfd-gate-box p { font-size: 13px; color: #666; margin-bottom: 20px; line-height: 1.5; }
    #mfdGateForm input, #mfdGateForm select {
      width: 100%; padding: 12px 14px; margin-bottom: 10px; box-sizing: border-box;
      border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit;
    }
    #mfdGateForm label.mfd-field-label {
      display: block; text-align: left; font-size: 12px; font-weight: 700;
      color: #888; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    #mfdGateForm button {
      width: 100%; padding: 12px; background: #8B0000; color: #fff; border: none;
      border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; margin-top: 6px;
      font-family: inherit;
    }
    #mfdGateForm button:hover { background: #B22222; }
    .mfd-gate-error { color: #B22222; font-size: 12px; margin-top: 10px; min-height: 16px; font-weight: 600; }
    .mfd-gate-note { font-size: 11px; color: #999; margin-top: 14px; line-height: 1.5; }
    .mfd-gate-shake { animation: mfdShake 0.4s; }
    @keyframes mfdShake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-8px); }
      40%, 80% { transform: translateX(8px); }
    }
    .mfd-floating-bar {
      position: fixed; bottom: 14px; z-index: 99998;
      display: flex; gap: 8px; font-family: 'Inter', system-ui, sans-serif;
    }
    .mfd-floating-bar.left { left: 14px; }
    .mfd-floating-bar.right { right: 14px; }
    @media print {
      .mfd-floating-bar, #mfdAuthGate, #mfdReportsModal { display: none !important; }
    }
    .mfd-pill-btn {
      background: rgba(0,0,0,0.7); color: #fff; border: none; border-radius: 20px;
      padding: 8px 14px; font-size: 12px; cursor: pointer; font-family: inherit;
      white-space: nowrap;
    }
    .mfd-pill-btn:hover { background: rgba(0,0,0,0.9); }
    .mfd-pill-btn.mfd-role-admin { background: rgba(139,0,0,0.85); }
    .mfd-pill-btn.mfd-role-admin:hover { background: rgba(178,34,34,0.95); }
    /* Phones and small tablets: one compact bar. Name pill on the left (shortens if needed), the other
       three buttons shrink to icons so nothing runs off the screen, and the page gets bottom room. */
    @media (max-width: 640px) {
      body { padding-bottom: 64px !important; }
      .mfd-floating-bar { bottom: 8px; gap: 6px; }
      .mfd-floating-bar.left { left: 8px; right: 52px; }
      .mfd-floating-bar.right { right: 8px; }
      .mfd-floating-bar.left #mfdWhoAmI { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; }
      .mfd-floating-bar .mfd-pill-btn { min-height: 40px; padding: 8px 12px; }
      .mfd-floating-bar .mfd-lbl { display: none; }
      #mfdChangePassBtn, #mfdLogoutBtn, #mfdReportsBtn, #mfdHelpBtn { min-width: 40px; font-size: 15px; padding: 8px 10px; }
    }
    #mfdReportsModal {
      position: fixed; inset: 0; z-index: 999998; background: rgba(0,0,0,0.6);
      display: none; align-items: flex-start; justify-content: center; padding: 40px 16px;
      font-family: 'Inter', system-ui, sans-serif;
    }
    #mfdReportsModal.open { display: flex; }
    .mfd-reports-box {
      background: #16181d; color: #f1f1f1; border-radius: 12px; max-width: 560px; width: 100%;
      max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 25px 60px rgba(0,0,0,0.5);
      border-top: 4px solid #C8922A;
    }
    .mfd-reports-head {
      padding: 16px 20px; border-bottom: 1px solid #2a2d34; display: flex;
      align-items: center; justify-content: space-between;
    }
    .mfd-reports-head h3 { font-size: 16px; font-weight: 800; margin: 0; }
    .mfd-reports-head button {
      background: none; border: none; color: #aaa; font-size: 20px; cursor: pointer; line-height: 1;
    }
    .mfd-reports-list { overflow-y: auto; padding: 10px 20px 20px; }
    .mfd-report-item {
      border-bottom: 1px solid #2a2d34; padding: 12px 0;
    }
    .mfd-report-item:last-child { border-bottom: none; }
    .mfd-report-meta { font-size: 11px; color: #999; margin-bottom: 4px; display:flex; justify-content:space-between; gap:8px;}
    .mfd-report-text { font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
    .mfd-report-del {
      background: rgba(178,34,34,0.15); color: #f87171; border: 1px solid rgba(178,34,34,0.4);
      border-radius: 6px; font-size: 11px; padding: 2px 8px; cursor: pointer; flex-shrink: 0;
    }
    .mfd-reports-empty { color: #777; font-size: 13px; text-align: center; padding: 30px 0; }

    /* Easier tapping on touch screens */
    @media (max-width: 800px) and (pointer: coarse) {
      button:not(.mfd-pill-btn), select, .btn, [role="button"], input[type="button"], input[type="submit"] { min-height: 36px; }
      td button, td .btn { min-width: 36px; }
    }
  `;
  document.head.appendChild(style);

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    const gate = document.getElementById('mfdAuthGate');
    const content = document.getElementById('mfdAppContent');
    if (!gate || !content) return; // page wasn't wrapped correctly, fail safe open

    function showContent() {
      gate.style.display = 'none';
      content.style.display = '';
      injectFloatingUI();
      if (window.MFD_AUTH && window.MFD_AUTH.role === 'personnel') startPersonnelLock();
      // Screen readers: give the page a main region and a level-1 heading if it has none
      try {
        if (!document.querySelector('main, [role="main"]')) {
          var mainEl = content.querySelector(':scope > .main, :scope > .frame-wrap, :scope > .wrap');
          if (mainEl) mainEl.setAttribute('role', 'main');
          else { content.setAttribute('role', 'main'); content.querySelectorAll('header').forEach(function (h) { h.setAttribute('role', 'presentation'); }); }
        }
        if (!document.querySelector('h1, [role="heading"][aria-level="1"]')) {
          var t = document.querySelector('.header-title, .mfd-header-text-block > .title, .mfd-header-text-block > div:nth-child(2)');
          if (t) { t.setAttribute('role', 'heading'); t.setAttribute('aria-level', '1'); }
        }
      } catch (e) { /* non-critical */ }
      window.dispatchEvent(new CustomEvent('mfd-auth-ready', { detail: window.MFD_AUTH }));
    }

    // ---------- Best-effort Personnel read-only lock ----------
    // Roster.html manages its own precise Admin/Personnel gating (see isLeadership()).
    // On every other page this is a generic safety net: it disables anything that looks
    // like an edit/save/delete/add/import action, while leaving search, filter, print,
    // and navigation controls usable. It's heuristic, not exhaustive — since these pages
    // weren't all audited control-by-control, some edit paths could slip through, and
    // occasionally a legitimate view/filter control could get disabled by mistake.
    const MFD_EDIT_VERBS = /(save|delete|remove|confirmdelete|executedelete|^edit|edit\()|import|restore|create|update|insert/i;
    const MFD_SAFE_ID_HINT = /(search|filter|from|to|start|end|range|sort)/i;

    function applyGenericPersonnelLock() {
      if (typeof window.isLeadership === 'function') return; // Roster.html handles itself
      document.querySelectorAll('button, input, select, textarea').forEach(function (el) {
        if (el.closest('#mfdAccountBar, #mfdReportsModal, #mfd-personnel-report-card')) return;
        if (el.dataset.mfdLocked === 'skip' || el.closest('[data-mfd-locked="skip"]')) return;

        const tag = el.tagName.toLowerCase();
        if (tag === 'button') {
          const onclickAttr = el.getAttribute('onclick') || '';
          const text = (el.textContent || '').trim();
          // data-mfd-verb is an explicit escape hatch for buttons whose handler is
          // attached via `.onclick =` / addEventListener (so there's no onclick
          // attribute to inspect) and/or whose visible text leads with an icon
          // instead of the verb itself (so the text-prefix check below misses it
          // too) — e.g. an icon-only "🗑 Delete" button. Mark those explicitly
          // with data-mfd-verb="delete" (or edit/save/etc.) rather than relying
          // on the heuristics guessing right.
          const verbHint = el.dataset.mfdVerb || '';
          const looksEditish = MFD_EDIT_VERBS.test(onclickAttr) || MFD_EDIT_VERBS.test(verbHint) ||
                                /^(\+|add|edit|delete|remove|save|update|import|restore)\b/i.test(text) ||
                                /^(add|edit|delete|remove|save|update|import|restore)\b/i.test(verbHint);
          const looksSafe = /^(print|view|open|close|filter|show|toggle|export|download|back\s?up)\b/i.test(text) ||
                             /(print|filter|open|close|toggle|export|backup)/i.test(onclickAttr);
          if (looksEditish && !looksSafe && !el.disabled) {
            el.disabled = true;
            el.style.opacity = '0.4';
            el.style.cursor = 'not-allowed';
            if (!/Admins only/.test(el.title||'')) el.title = (el.title ? el.title + ' — ' : '') + 'Admins only';
          }
        } else {
          const hint = (el.id || '') + ' ' + (el.name || '') + ' ' + (el.getAttribute('placeholder') || '');
          const isSafe = MFD_SAFE_ID_HINT.test(hint) || el.type === 'search';
          if (!isSafe && !el.disabled) {
            el.disabled = true;
            el.style.opacity = '0.5';
            if (!/Admins only/.test(el.title||'')) el.title = (el.title ? el.title + ' — ' : '') + 'Admins only';
          }
        }
      });
    }

    function startPersonnelLock() {
      applyGenericPersonnelLock();
      let scheduled = false;
      const observer = new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; applyGenericPersonnelLock(); }, 200);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    function escH(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

    // Turn the approved-account record into the session the pages use
    // (window.MFD_AUTH). The role comes from the approved-accounts list in the
    // database, which only Admins can change.
    function slugOf(x) { return window.MFD_FB ? window.MFD_FB.slugify(x) : String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
    // Members whose last name matches this account's address (used only when the
    // account was created by hand and is not linked to a roster member yet).
    function sameNameMembers(user) {
      const wanted = user && user.email ? user.email.split('@')[0].split('.')[0] : '';
      return getMembers().filter(m => wanted && slugOf(lastNameOf(m.name)) === wanted);
    }

    function applyAccount(acc, user) {
      const members = getMembers();
      let me = members.find(m => m.id && m.id === acc.memberId);
      if (!me) { const same = sameNameMembers(user); if (same.length === 1) me = same[0]; }
      const name = me ? me.name : (acc.name || 'Member');
      window.MFD_AUTH = { memberId: me ? me.id : (acc.memberId || ''), name: name, lastName: lastNameOf(name), role: acc.role === 'admin' ? 'admin' : 'personnel', uid: acc.uid, tempPassword: !!acc.tempPassword };
      return window.MFD_AUTH;
    }

    function gateMessage(title, text, withLogout) {
      gate.innerHTML = `
        <div class="mfd-gate-box">
          <div class="mfd-gate-shield">🛡️</div>
          <h2>${escH(title)}</h2>
          ${text ? '<p>' + escH(text) + '</p>' : ''}
          ${withLogout ? '<button type="button" id="mfdGateBack">Back to sign in</button>' : ''}
        </div>`;
      const back = document.getElementById('mfdGateBack');
      if (back) back.addEventListener('click', function () {
        (window.MFD_FB && window.MFD_FB.signOut ? window.MFD_FB.signOut() : Promise.resolve()).catch(function () {}).then(function () { location.reload(); });
      });
    }

    const SIGNIN_ERRORS = {
      'auth/invalid-credential': 'Last name or password is incorrect.',
      'auth/wrong-password': 'Last name or password is incorrect.',
      'auth/user-not-found': 'Last name or password is incorrect.',
      'auth/invalid-email': 'Last name or password is incorrect.',
      'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
      'auth/network-request-failed': 'Cannot reach the sign-in service. Check your internet connection and try again.',
      'auth/user-disabled': 'This account has been turned off. Ask an Admin.',
      'auth/operation-not-allowed': 'Sign-in is not switched on yet in the department database. Ask the person who manages it.'
    };

    // First-Admin set-up: the login was created by hand and several members share the
    // last name (or none match), so ask once which roster member this is.
    function buildLinkPicker(acc, user, onDone) {
      let list = sameNameMembers(user); if (!list.length) list = getMembers();
      gate.innerHTML = `
        <div class="mfd-gate-box">
          <div class="mfd-gate-shield">🛡️</div>
          <h2>Which member are you?</h2>
          <p>This login is not linked to a roster member yet. Pick yourself once and it will be remembered.</p>
          <form id="mfdGateForm">
            <label class="mfd-field-label" for="mfdLinkSel">Your name</label>
            <select id="mfdLinkSel">${list.map(m => `<option value="${escH(m.id)}">${escH(m.name)}</option>`).join('')}</select>
            <button type="submit">Continue</button>
          </form>
          <div id="mfdGateError" class="mfd-gate-error" role="alert"></div>
        </div>`;
      document.getElementById('mfdGateForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try { await window.MFD_FB.linkMember(document.getElementById('mfdLinkSel').value); onDone(); }
        catch (err) { document.getElementById('mfdGateError').textContent = 'Could not save that. Try again.'; }
      });
    }

    // ---------- Login screen ----------
    function buildLoginUI(errText) {
      gate.innerHTML = `
        <div class="mfd-gate-box">
          <div class="mfd-gate-shield">🛡️</div>
          <h2>Sign In</h2>
          <p>Enter your last name and password to access the MFD records system.</p>
          <form id="mfdGateForm" autocomplete="on">
            <label class="mfd-field-label" for="mfdLastName">Last Name</label>
            <input type="text" id="mfdLastName" name="username" autocomplete="username" autocapitalize="off" />
            <label class="mfd-field-label" for="mfdPass1">Password</label>
            <input type="password" id="mfdPass1" name="password" autocomplete="current-password" />
            <button type="submit">Unlock</button>
          </form>
          <div id="mfdGateError" class="mfd-gate-error" role="alert">${escH(errText || '')}</div>
        </div>
      `;
      document.getElementById('mfdLastName').focus();

      document.getElementById('mfdGateForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errEl = document.getElementById('mfdGateError');
        const btn = gate.querySelector('button[type=submit]');
        errEl.textContent = '';
        const lastName = document.getElementById('mfdLastName').value.trim();
        const password = document.getElementById('mfdPass1').value;
        if (!lastName || !password) { errEl.textContent = 'Enter both your last name and password.'; return; }
        const FB = window.MFD_FB;
        if (!FB || !FB.available) { errEl.textContent = SIGNIN_ERRORS['auth/network-request-failed']; return; }
        btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          await FB.signIn(lastName, password);
          // Signed in. mfd-sync.js now checks the account is approved, downloads the
          // shared data and reloads this page. Show progress meanwhile.
          gateMessage('Signing in…', 'Loading the department data.', false);
          waitForSignedInData();
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Unlock';
          errEl.textContent = SIGNIN_ERRORS[err && err.code] || 'Could not sign in. Try again.';
          const box = gate.querySelector('.mfd-gate-box');
          box.classList.add('mfd-gate-shake');
          setTimeout(() => box.classList.remove('mfd-gate-shake'), 400);
          document.getElementById('mfdPass1').value = '';
          document.getElementById('mfdPass1').focus();
        }
      });
    }

    // After a successful sign-in, wait for the account check / data download.
    // Normally the page just reloads. These cover the failure cases.
    let waiting = false;
    function waitForSignedInData() {
      if (waiting) return; waiting = true;
      const t = setTimeout(function () {
        gateMessage('Taking too long', 'The department data did not load. Check your connection and try again.', true);
      }, 30000);
      window.addEventListener('mfd-fb-state', function (ev) {
        const st = ev.detail && ev.detail.state;
        if (st === 'no-access') { clearTimeout(t); gateMessage('No access', 'Your sign-in worked, but an Admin has not approved this account yet. Ask an Admin to set up your login in the Roster.', true); }
        else if (st === 'hydrate-failed' || st === 'error') { clearTimeout(t); gateMessage('Could not load data', 'You are signed in, but the shared data could not be loaded. Try again, or ask an Admin.', true); }
      });
    }

    // ---------- Floating account bar + Reports viewer ----------
    function injectFloatingUI() {
      if (document.getElementById('mfdAccountBar')) return;
      const auth = window.MFD_AUTH;

      const leftBar = document.createElement('div');
      leftBar.className = 'mfd-floating-bar left';
      leftBar.id = 'mfdAccountBar';
      leftBar.innerHTML = `
        <button class="mfd-pill-btn ${auth.role === 'admin' ? 'mfd-role-admin' : ''}" id="mfdWhoAmI" title="Signed in">
          ${auth.role === 'admin' ? '⭐' : '👤'} ${escH(auth.name)} (${auth.role === 'admin' ? 'Admin' : 'Personnel'})
        </button>
        <button class="mfd-pill-btn" id="mfdChangePassBtn" title="Change Password" aria-label="Change Password">🔑<span class="mfd-lbl"> Change Password</span></button>
        <button class="mfd-pill-btn" id="mfdLogoutBtn" title="Log Out" aria-label="Log Out">🚪<span class="mfd-lbl"> Log Out</span></button>
        ${/MFD_Help\.html/.test(location.pathname) ? '' : '<a class="mfd-pill-btn" id="mfdHelpBtn" href="MFD_Help.html" title="Help &amp; User Guide" aria-label="Help" style="text-decoration:none;display:inline-flex;align-items:center;">❓<span class="mfd-lbl">&nbsp;Help</span></a>'}
      `;
      document.body.appendChild(leftBar);

      const rightBar = document.createElement('div');
      rightBar.className = 'mfd-floating-bar right';
      rightBar.innerHTML = `<button class="mfd-pill-btn" id="mfdReportsBtn" title="Reports" aria-label="Reports">📋<span class="mfd-lbl"> Reports</span></button>`;
      document.body.appendChild(rightBar);

      const modal = document.createElement('div');
      modal.id = 'mfdReportsModal';
      modal.innerHTML = `
        <div class="mfd-reports-box">
          <div class="mfd-reports-head">
            <h3>📋 Reports</h3>
            <button id="mfdReportsCloseBtn">✕</button>
          </div>
          <div class="mfd-reports-list" id="mfdReportsList"></div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('mfdChangePassBtn').addEventListener('click', changePasswordFlow);
      document.getElementById('mfdLogoutBtn').addEventListener('click', function () {
        if (!confirm('Log out of the MFD records system?')) return;
        sessionStorage.removeItem(SESSION_KEY);
        (window.MFD_FB && window.MFD_FB.signOut ? window.MFD_FB.signOut() : Promise.resolve()).catch(function () {}).then(function () { location.reload(); });
      });
      document.getElementById('mfdReportsBtn').addEventListener('click', openReportsModal);
      document.getElementById('mfdReportsCloseBtn').addEventListener('click', function () {
        modal.classList.remove('open');
      });
      modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.remove('open'); });
    }

    function renderReportsList() {
      const listEl = document.getElementById('mfdReportsList');
      const reports = getReports().slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (!reports.length) {
        listEl.innerHTML = '<div class="mfd-reports-empty">No reports yet. Reports can be submitted from the Timecards page.</div>';
        return;
      }
      const isAdmin = window.MFD_AUTH && window.MFD_AUTH.role === 'admin';
      listEl.innerHTML = reports.map(r => {
        const when = r.ts ? new Date(r.ts).toLocaleString() : '';
        return `
          <div class="mfd-report-item" data-report-id="${r.id}">
            <div class="mfd-report-meta">
              <span>${(r.authorName || 'Unknown').replace(/</g,'&lt;')} — ${when}</span>
              ${isAdmin ? '<button class="mfd-report-del" data-del-id="' + String(r.id).replace(/[&<>"']/g,'') + '">Delete</button>' : ''}
            </div>
            <div class="mfd-report-text">${(r.text || '').replace(/</g,'&lt;')}</div>
          </div>
        `;
      }).join('');

      if (isAdmin) {
        listEl.querySelectorAll('.mfd-report-del').forEach(btn => {
          btn.addEventListener('click', function () {
            if (!confirm('Delete this report? This cannot be undone.')) return;
            const id = btn.dataset.delId;
            saveReports(getReports().filter(r => r.id !== id));
            renderReportsList();
          });
        });
      }
    }

    function openReportsModal() {
      renderReportsList();
      document.getElementById('mfdReportsModal').classList.add('open');
    }

    async function changePasswordFlow() {
      const FB = window.MFD_FB;
      if (!FB || !FB.changePassword) { alert('Password change is not available right now.'); return; }
      const current = prompt('Enter your current password:');
      if (current === null) return;
      const p1 = prompt('Enter new password (at least ' + FB.minPassword + ' characters):');
      if (p1 === null) return;
      if (!p1 || p1.length < FB.minPassword) { alert('Password must be at least ' + FB.minPassword + ' characters. Nothing was changed.'); return; }
      const p2 = prompt('Confirm new password:');
      if (p1 !== p2) { alert('Passwords did not match. Nothing was changed.'); return; }
      try {
        await FB.changePassword(current, p1);
        const tb = document.getElementById('mfdTempBanner'); if (tb) tb.remove();
        alert('Your password has been updated.');
      } catch (e) {
        const c = e && e.code;
        alert(c === 'auth/invalid-credential' || c === 'auth/wrong-password' ? 'Incorrect current password. Nothing was changed.'
            : c === 'auth/weak-password' ? 'That password is too weak. Nothing was changed.'
            : c === 'auth/too-many-requests' ? 'Too many tries. Wait a few minutes and try again.'
            : 'Could not change the password. Nothing was changed.');
      }
    }

    function showTempPasswordBanner() {
      if (!window.MFD_AUTH || !window.MFD_AUTH.tempPassword || document.getElementById('mfdTempBanner')) return;
      if (/[?&]dash=/.test(location.search)) return;
      const b = document.createElement('div');
      b.id = 'mfdTempBanner'; b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147482000;background:#92400e;color:#fff;font:600 13px/1.3 Inter,system-ui,sans-serif;padding:8px 40px 8px 12px;text-align:center';
      b.innerHTML = 'You are using a temporary password. Tap <b>Change Password</b> at the bottom of the screen to choose your own. ';
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
      x.style.cssText = 'position:absolute;right:8px;top:4px;background:none;border:0;color:#fff;font-size:16px;cursor:pointer;min-height:0';
      x.addEventListener('click', function () { b.remove(); });
      b.appendChild(x); document.body.appendChild(b);
    }
    window.addEventListener('mfd-auth-ready', showTempPasswordBanner);

    // ---------- Init ----------
    function init() {
      const FB = window.MFD_FB;
      if (!FB) { buildLoginUI('The sign-in service did not start. Refresh the page.'); return; }
      gateMessage('Checking sign-in…', '', false);
      const timeout = new Promise(function (res) { setTimeout(function () { res({ user: null, error: 'sdk' }); }, 20000); });
      Promise.race([FB.ready, timeout]).then(function (r) {
        if (r && r.user && r.account) {
          if (!r.account.memberId && r.account.role === 'admin' && !FB.needsHydrate()) {
            const same = sameNameMembers(r.user);
            if (same.length !== 1) { buildLinkPicker(r.account, r.user, function () { location.reload(); }); return; }
          }
          applyAccount(r.account, r.user);
          if (FB.needsHydrate()) {
            // Signed in but the shared data has not been downloaded in this tab yet:
            // mfd-sync.js is doing that and will reload the page.
            gateMessage('Signing in…', 'Loading the department data.', false);
            waitForSignedInData();
            return;
          }
          showContent();
          return;
        }
        if (r && r.error === 'no-access') { buildLoginUI('Your sign-in worked, but an Admin has not approved this account yet. Ask an Admin to set up your login.'); return; }
        if (r && r.error === 'sdk') { buildLoginUI('Cannot reach the sign-in service. Check your internet connection, then refresh the page.'); return; }
        if (r && r.error) { buildLoginUI('Could not check your account. Try again.'); return; }
        buildLoginUI('');
      });
    }

    init();
  });
})();
