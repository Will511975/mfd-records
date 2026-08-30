/* ============================================================
   MFD Records System — Password Gate + Roles + Reports
   Shared across all module pages (same-origin localStorage).

   - Login is per-person: username = last name (from the Roster),
     password = whatever that person's Admin sets on their profile.
   - Roles: "admin" (full access everywhere) and "personnel"
     (view everything, no editing anywhere; can add a Report only
     from the Timecards page; can view Reports everywhere).
   - First-ever login on a browser with no accounts set up yet
     walks through a one-time "create the first Admin" step.
   - Session stays unlocked while navigating between pages/tabs;
     closing the browser/tab clears it (sessionStorage).
   ============================================================ */
(function () {
  const MEMBERS_KEY = 'mfd_members_v5';
  const SESSION_KEY = 'mfd_authSession';       // sessionStorage
  const REPORTS_KEY = 'mfd_reports_v1';        // localStorage

  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

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
        if (el.dataset.mfdLocked === 'skip') return;

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

    function setSession(member) {
      const session = { memberId: member.id, name: member.name, lastName: lastNameOf(member.name), role: member.authRole || 'personnel' };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      window.MFD_AUTH = session;
    }

    // ---------- Login screen ----------
    function buildLoginUI(errText) {
      gate.innerHTML = `
        <div class="mfd-gate-box">
          <div class="mfd-gate-shield">🛡️</div>
          <h2>Sign In</h2>
          <p>Enter your last name and password to access the MFD records system.</p>
          <form id="mfdGateForm" autocomplete="off">
            <label class="mfd-field-label">Last Name</label>
            <input type="text" id="mfdLastName" autocomplete="username" />
            <label class="mfd-field-label">Password</label>
            <input type="password" id="mfdPass1" autocomplete="current-password" />
            <button type="submit">Unlock</button>
          </form>
          <div id="mfdGateError" class="mfd-gate-error">${errText || ''}</div>
        </div>
      `;
      document.getElementById('mfdLastName').focus();

      document.getElementById('mfdGateForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errEl = document.getElementById('mfdGateError');
        errEl.textContent = '';
        const lastName = document.getElementById('mfdLastName').value.trim();
        const password = document.getElementById('mfdPass1').value;
        if (!lastName || !password) { errEl.textContent = 'Enter both your last name and password.'; return; }

        const hash = await sha256(password);
        const members = getMembers();
        const match = members.find(m =>
          m.authPasswordHash &&
          lastNameOf(m.name).toLowerCase() === lastName.toLowerCase() &&
          m.authPasswordHash === hash
        );

        if (match) {
          setSession(match);
          showContent();
        } else {
          errEl.textContent = 'Last name or password is incorrect.';
          const box = gate.querySelector('.mfd-gate-box');
          box.classList.add('mfd-gate-shake');
          setTimeout(() => box.classList.remove('mfd-gate-shake'), 400);
          document.getElementById('mfdPass1').value = '';
          document.getElementById('mfdPass1').focus();
        }
      });
    }

    // ---------- First-time setup (no admin account exists yet) ----------
    function buildBootstrapUI() {
      const members = getMembers();
      const hasMembers = members.length > 0;
      gate.innerHTML = `
        <div class="mfd-gate-box">
          <div class="mfd-gate-shield">🛡️</div>
          <h2>First-Time Setup</h2>
          <p>No login has been set up yet on this system. Create the first Admin account to get started — you can add passwords for everyone else later from the Roster page.</p>
          <form id="mfdGateForm" autocomplete="off">
            ${hasMembers ? `
              <label class="mfd-field-label">Select Your Name</label>
              <select id="mfdBootMemberSelect">
                ${members.map(m => `<option value="${m.id}">${m.name.replace(/</g,'&lt;')}</option>`).join('')}
              </select>
            ` : `
              <label class="mfd-field-label">Your Full Name</label>
              <input type="text" id="mfdBootFullName" placeholder="John Doe" />
            `}
            <label class="mfd-field-label">New Password</label>
            <input type="password" id="mfdPass1" autocomplete="new-password" />
            <label class="mfd-field-label">Confirm Password</label>
            <input type="password" id="mfdPass2" autocomplete="new-password" />
            <button type="submit">Create Admin Account & Continue</button>
          </form>
          <div id="mfdGateError" class="mfd-gate-error"></div>
          <div class="mfd-gate-note">This account will have full Admin access. Everyone else's login (username + password + role) is added from the Roster page afterward.</div>
        </div>
      `;

      document.getElementById('mfdGateForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errEl = document.getElementById('mfdGateError');
        errEl.textContent = '';
        const p1 = document.getElementById('mfdPass1').value;
        const p2 = document.getElementById('mfdPass2').value;
        if (!p1 || p1.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }
        if (p1 !== p2) { errEl.textContent = 'Passwords do not match.'; return; }

        const hash = await sha256(p1);
        let members = getMembers();
        let member;

        if (hasMembers) {
          const id = document.getElementById('mfdBootMemberSelect').value;
          member = members.find(m => m.id === id);
          if (!member) { errEl.textContent = 'Could not find that member — try again.'; return; }
          member.authRole = 'admin';
          member.authPasswordHash = hash;
        } else {
          const fullName = (document.getElementById('mfdBootFullName').value || '').trim();
          if (!fullName) { errEl.textContent = 'Enter your full name.'; return; }
          member = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: fullName,
            callSign: '—',
            rank: 'Probationary',
            status: 'Active',
            phone: '', email: '', address: '', joinDate: new Date().toISOString().split('T')[0],
            gearSizes: {}, emergencyContact: { name:'', relationship:'', phone:'', altPhone:'' }, notes: '',
            authRole: 'admin', authPasswordHash: hash
          };
          members.push(member);
        }
        saveMembers(members);
        setSession(member);
        showContent();
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
          ${auth.role === 'admin' ? '⭐' : '👤'} ${auth.name} (${auth.role === 'admin' ? 'Admin' : 'Personnel'})
        </button>
        <button class="mfd-pill-btn" id="mfdChangePassBtn">🔑 Change Password</button>
        <button class="mfd-pill-btn" id="mfdLogoutBtn">🚪 Log Out</button>
      `;
      document.body.appendChild(leftBar);

      const rightBar = document.createElement('div');
      rightBar.className = 'mfd-floating-bar right';
      rightBar.innerHTML = `<button class="mfd-pill-btn" id="mfdReportsBtn">📋 Reports</button>`;
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
        location.reload();
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
              ${isAdmin ? '<button class="mfd-report-del" data-del-id="' + r.id + '">Delete</button>' : ''}
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
      const current = prompt('Enter your current password:');
      if (current === null) return;
      const currentHash = await sha256(current);
      const members = getMembers();
      const me = members.find(m => m.id === window.MFD_AUTH.memberId);
      if (!me || me.authPasswordHash !== currentHash) { alert('Incorrect current password.'); return; }

      const p1 = prompt('Enter new password (at least 4 characters):');
      if (p1 === null) return;
      if (!p1 || p1.length < 4) { alert('Password must be at least 4 characters. Nothing was changed.'); return; }
      const p2 = prompt('Confirm new password:');
      if (p1 !== p2) { alert('Passwords did not match. Nothing was changed.'); return; }

      me.authPasswordHash = await sha256(p1);
      saveMembers(members);
      alert('Your password has been updated.');
    }

    // ---------- Init ----------
    function init() {
      const members = getMembers();
      const anyAccountExists = members.some(m => m.authPasswordHash);
      const sessionRaw = sessionStorage.getItem(SESSION_KEY);

      if (sessionRaw) {
        try {
          const session = JSON.parse(sessionRaw);
          // Re-validate the session against current member data (role/password could have changed).
          const me = members.find(m => m.id === session.memberId);
          if (me && me.authPasswordHash) {
            window.MFD_AUTH = { memberId: me.id, name: me.name, lastName: lastNameOf(me.name), role: me.authRole || 'personnel' };
            showContent();
            return;
          }
        } catch (e) { /* fall through to login */ }
      }

      if (!anyAccountExists) {
        buildBootstrapUI();
      } else {
        buildLoginUI();
      }
    }

    init();
  });
})();
