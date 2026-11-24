/*
 * MFD Records — sign-in + Firestore sync shim
 * --------------------------------------------
 * Makes the existing localStorage-based app share live data across
 * browsers and devices, WITHOUT changing any of the app's own logic,
 * and signs members in with real Firebase accounts.
 *
 * How it works:
 *  1. Members sign in with their last name + password. Behind the scenes
 *     each member has a Firebase email/password account whose address is
 *     built from their last name (e.g. smith.k3f9@mfd-records.local).
 *     The app never shows that address.
 *  2. A signed-in account only gets data if an Admin has approved it: the
 *     database holds an "approved accounts" list (mfd_accounts) and the
 *     database rules only let approved accounts read or write anything.
 *  3. Once approved, the page downloads every synced key from Firestore
 *     into localStorage and reloads once so the app boots with fresh data.
 *     After that it mirrors every localStorage.setItem / removeItem call
 *     (for app keys) up to Firestore and applies changes made by other
 *     users/devices.
 *
 * Exposes window.MFD_FB for mfdauth.js, the Roster and the Backup page.
 * This file must be loaded as the FIRST script on every page, before any
 * other script that reads localStorage.
 */
(function () {
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyC6S_5XYRIg05hvkyvivRS5J4z6XsrIub4",
    authDomain: "mfd-records.firebaseapp.com",
    projectId: "mfd-records",
    storageBucket: "mfd-records.firebasestorage.app",
    messagingSenderId: "161028344658",
    appId: "1:161028344658:web:ca8699024025795bff888b"
  };

  var SDK_VERSION = "12.18.0";
  var COLLECTION = "mfd_data";            // the app's data
  var ACCOUNTS = "mfd_accounts";          // approved accounts (doc id = Firebase uid)
  var DIRECTORY = "login_directory";      // last-name -> account addresses (sign-in lookup)
  var EMAIL_DOMAIN = "mfd-records.local"; // never emailed; just a unique account name
  var BOOTSTRAP_FLAG = "mfd_sync_bootstrapped";
  var MIN_PASSWORD = 6;                   // Firebase's minimum

  // Only keys with these prefixes are synced to Firestore. Everything
  // else (if anything) stays purely local to the browser.
  var SYNC_PREFIXES = ["mfd_", "mantua", "MFD_"];

  function shouldSync(key) {
    if (!key || key === BOOTSTRAP_FLAG) return false;
    for (var i = 0; i < SYNC_PREFIXES.length; i++) {
      if (key.indexOf(SYNC_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function safeReload() {
    try { window.location.reload(); } catch (e) { /* ignore */ }
  }

  function slugify(lastName) {
    var s = String(lastName || '').toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old browser */ }
    return s.replace(/[^a-z0-9]/g, '');
  }

  function randomSuffix() {
    try {
      var a = new Uint8Array(4); crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
    } catch (e) { return Math.random().toString(36).slice(2, 6); }
  }


  // ---------- merging two people's changes ----------
  // The app keeps each list (time cards, members, expenses...) as ONE
  // saved value. Without care, when two people save at nearly the same
  // time the later save silently replaces the earlier one and an entry is
  // lost. So before a save is sent, it is merged with what is already in
  // the shared database using the last version this device saw (the
  // "base"): records added by either side are kept, records deleted by
  // one side are removed, and edits to different records or different
  // fields both survive. Lists whose items have no "id" (or plain values)
  // keep the old rule: the latest save wins.
  function canon(x) {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { o[k] = canon(x[k]); }); return o; }
    return x;
  }
  function deepEq(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function isIdArray(a) {
    return Array.isArray(a) && a.every(function (e) { return isObj(e) && e.id !== undefined && e.id !== null; });
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  var baseKnownFlag = true;

  function mergeIdArrays(b, l, r) {
    var bm = {}, lm = {}, rm = {}, i;
    for (i = 0; i < l.length; i++) lm[String(l[i].id)] = l[i];
    for (i = 0; i < r.length; i++) rm[String(r[i].id)] = r[i];
    if (baseKnownFlag) {
      for (i = 0; i < b.length; i++) bm[String(b[i].id)] = b[i];
    } else {
      // No saved base: only treat records present on both sides as "known", so nothing is ever inferred as deleted.
      Object.keys(lm).forEach(function (id) { if (rm[id] !== undefined) bm[id] = rm[id]; });
    }
    var maxNum = 0;
    l.concat(r).forEach(function (e) { if (typeof e.id === 'number' && e.id > maxNum) maxNum = e.id; });
    function freshId(old) {
      if (typeof old === 'number') return ++maxNum;
      return String(old) + '-' + Math.random().toString(36).slice(2, 6);
    }
    var out = [], seen = {};
    r.forEach(function (re) {
      var id = String(re.id), le = lm[id], be = bm[id];
      seen[id] = 1;
      if (le !== undefined) {
        if (be === undefined && !deepEq(le, re)) {
          // Two different new records were given the same id on two devices: keep both.
          out.push(re);
          var ne = clone(le); ne.id = freshId(le.id); out.push(ne);
        } else {
          out.push(mergeNode(be, le, re));
        }
      } else if (be !== undefined) {
        if (!deepEq(be, re)) out.push(re);     // deleted here, but edited by the other person: keep the edit
      } else {
        out.push(re);                          // added by the other person
      }
    });
    l.forEach(function (le) {
      var id = String(le.id), be = bm[id];
      if (seen[id]) return;
      if (be !== undefined) {
        if (!deepEq(be, le)) out.push(le);     // deleted by the other person, but edited here: keep the edit
      } else {
        out.push(le);                          // added here
      }
    });
    return out;
  }

  function mergeNode(b, l, r) {
    if (deepEq(l, r)) return l;
    if (deepEq(l, b)) return r;
    if (deepEq(r, b)) return l;
    if (isIdArray(l) && isIdArray(r) && (b === undefined || isIdArray(b))) return mergeIdArrays(b || [], l, r);
    if (isObj(l) && isObj(r)) {
      var bb = isObj(b) ? b : {}, out = {}, keys = Object.keys(r);
      Object.keys(l).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
      keys.forEach(function (k) {
        var inL = Object.prototype.hasOwnProperty.call(l, k), inR = Object.prototype.hasOwnProperty.call(r, k);
        var inB = Object.prototype.hasOwnProperty.call(bb, k);
        if (inL && inR) out[k] = mergeNode(bb[k], l[k], r[k]);
        else if (inR) { if (!(inB && deepEq(bb[k], r[k]))) out[k] = r[k]; }   // dropped here unless the other side changed it
        else { if (!(inB && deepEq(bb[k], l[k]))) out[k] = l[k]; }
      });
      return out;
    }
    return l; // both changed something we can't combine: this device's save wins
  }

  // Returns the text to store, given the last-synced text (or null if unknown),
  // this device's text, and the shared database's current text.
  function mergeValues(baseStr, localStr, remoteStr) {
    try {
      var l = JSON.parse(localStr), r = JSON.parse(remoteStr), b;
      baseKnownFlag = (baseStr !== null && baseStr !== undefined);
      if (baseKnownFlag) { try { b = JSON.parse(baseStr); } catch (e) { baseKnownFlag = false; b = undefined; } }
      var m = mergeNode(b, l, r);
      if (deepEq(m, l)) return localStr;
      if (deepEq(m, r)) return remoteStr;
      return JSON.stringify(m);
    } catch (e) {
      return localStr;
    }
  }

  function fail(code, message) { var e = new Error(message || code); e.code = code; return e; }

  var FB = window.MFD_FB = {
    config: FIREBASE_CONFIG,
    emailDomain: EMAIL_DOMAIN,
    minPassword: MIN_PASSWORD,
    slugify: slugify,
    _merge: mergeValues,       // exposed for testing
    user: null,
    account: null,            // the signed-in member's approved-account record
    available: false,         // true once the Firebase SDK has loaded
    ready: null,              // resolves once: {user, account} | {user:null, error?}
    needsHydrate: function () { return window.sessionStorage.getItem(BOOTSTRAP_FLAG) !== "1"; },
    state: function (name, detail) {
      try { window.dispatchEvent(new CustomEvent('mfd-fb-state', { detail: { state: name, info: detail || null } })); } catch (e) { /* ignore */ }
    }
  };
  var resolveReady, readyDone = false;
  FB.ready = new Promise(function (res) { resolveReady = res; });
  function finishReady(v) { if (readyDone) return; readyDone = true; resolveReady(v); }

  var base = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";

  Promise.all([
    import(/* webpackIgnore: true */ base + "firebase-app.js"),
    import(/* webpackIgnore: true */ base + "firebase-firestore.js"),
    import(/* webpackIgnore: true */ base + "firebase-auth.js")
  ]).then(function (mods) {
    var appMod = mods[0], fsMod = mods[1], authMod = mods[2];
    var app = appMod.initializeApp(FIREBASE_CONFIG);
    var db = fsMod.getFirestore(app);
    var auth = authMod.getAuth(app);
    FB.available = true;

    var applyingRemote = false; // guard against write-back loops
    var knownValues = {};       // last value seen/written for each key, by key
    var syncStarted = false;

    // ---------- data sync (unchanged behaviour) ----------
    // Unsent saves are remembered across reloads/closing the tab (these two
    // storage names deliberately don't start with a synced prefix, so they
    // never go to the shared database themselves).
    var PENDING_KEY = 'sync_pending', BASE_PREFIX = 'sync_base:';
    var bases = {};      // last text of each key known to match the shared database
    var pending = {};    // keys with saves not yet confirmed by the shared database
    var flushing = {}, again = {}, retryTimer = null;

    function loadPending() {
      try { return JSON.parse(window.localStorage.getItem(PENDING_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function savePending() {
      try {
        if (Object.keys(pending).length) window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
        else window.localStorage.removeItem(PENDING_KEY);
      } catch (e) { /* ignore */ }
    }
    function saveBase(key, val) {
      try {
        if (val === null || val === undefined) window.localStorage.removeItem(BASE_PREFIX + key);
        else window.localStorage.setItem(BASE_PREFIX + key, val);
      } catch (e) { /* too big to keep a copy: the merge then just avoids deleting anything */ }
    }
    function markPending(key) {
      if (!pending[key]) { pending[key] = 1; savePending(); saveBase(key, bases[key]); }
    }
    function clearPending(key) {
      if (pending[key]) { delete pending[key]; savePending(); }
      saveBase(key, null);
    }

    function primeKnownValues() {
      pending = loadPending();
      try {
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (!shouldSync(k)) continue;
          knownValues[k] = window.localStorage.getItem(k);
          if (pending[k]) { var bv = window.localStorage.getItem(BASE_PREFIX + k); bases[k] = bv === null ? undefined : bv; }
          else bases[k] = knownValues[k];
        }
      } catch (e) { /* ignore */ }
    }

    function writeLocalOnly(key, value) {
      applyingRemote = true;
      try {
        if (value === null || value === undefined) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }
        knownValues[key] = value === undefined ? null : value;
      } finally {
        applyingRemote = false;
      }
    }

    // A save is queued first (so it survives a closed tab or a dropped
    // connection), then sent in a way that merges with anything another
    // person saved in the meantime.
    function pushToFirestore(key, value) {
      if (applyingRemote) return;
      knownValues[key] = value === undefined ? null : value;
      markPending(key);
      flushKey(key);
    }

    function flushKey(key) {
      if (flushing[key]) { again[key] = true; return flushing[key]; }
      var p = doFlush(key).catch(function (err) {
        console.error("MFD sync: could not save '" + key + "' yet — it will be retried.", err);
        if (err && err.code === 'permission-denied') { kickOut(); return; }
        scheduleRetry();
      }).then(function () {
        flushing[key] = null;
        if (again[key]) { again[key] = false; return flushKey(key); }
      });
      flushing[key] = p;
      return p;
    }

    function doFlush(key) {
      var localSnap = window.localStorage.getItem(key);
      var ref = fsMod.doc(db, COLLECTION, key);
      if (localSnap === null) {
        return fsMod.setDoc(ref, { value: null, deleted: true, updatedAt: fsMod.serverTimestamp() }).then(function () {
          if (window.localStorage.getItem(key) === null) { bases[key] = null; clearPending(key); }
        });
      }
      var base = bases[key];
      return fsMod.runTransaction(db, function (tx) {
        return tx.get(ref).then(function (s) {
          var d = s.exists() ? s.data() : null;
          var remote = (d && !d.deleted && typeof d.value === 'string') ? d.value : null;
          var merged = remote === null ? localSnap : mergeValues(base, localSnap, remote);
          if (merged !== remote) tx.set(ref, { value: merged, deleted: false, updatedAt: fsMod.serverTimestamp() });
          return merged;
        });
      }).then(function (merged) { finishFlush(key, localSnap, merged); });
    }

    function finishFlush(key, localSnap, merged) {
      var cur = window.localStorage.getItem(key), mustReload = false;
      knownValues[key] = merged;
      bases[key] = merged;
      if (cur === localSnap) {
        if (merged !== localSnap) { writeLocalOnly(key, merged); mustReload = true; } // someone else's changes were merged in
        clearPending(key);
      } else {
        // This device saved again while that save was in flight: fold the newer edits into the merged result and send again.
        if (cur !== null) {
          var next = mergeValues(localSnap, cur, merged);
          if (next !== cur) { writeLocalOnly(key, next); mustReload = true; }
          knownValues[key] = next;
        }
        saveBase(key, merged);
        again[key] = true;
      }
      if (mustReload) safeReload();
    }

    function flushAllPending() {
      var ks = Object.keys(pending);
      return Promise.all(ks.map(flushKey));
    }
    function scheduleRetry() {
      if (retryTimer) return;
      retryTimer = setTimeout(function () { retryTimer = null; if (Object.keys(pending).length) flushAllPending(); }, 15000);
    }
    window.addEventListener('online', function () { if (syncStarted) flushAllPending(); });
    window.addEventListener('focus', function () { if (syncStarted && Object.keys(pending).length) flushAllPending(); });
    document.addEventListener('visibilitychange', function () { if (syncStarted && !document.hidden && Object.keys(pending).length) flushAllPending(); });

    function patchStorage() {
      var origSetItem = window.localStorage.setItem.bind(window.localStorage);
      var origRemoveItem = window.localStorage.removeItem.bind(window.localStorage);

      window.localStorage.setItem = function (key, value) {
        origSetItem(key, value);
        if (shouldSync(key)) pushToFirestore(key, value);
      };
      window.localStorage.removeItem = function (key) {
        origRemoveItem(key);
        if (shouldSync(key)) pushToFirestore(key, null);
      };
    }

    function hydrateThenReload() {
      return fsMod.getDocs(fsMod.collection(db, COLLECTION)).then(function (snap) {
        snap.forEach(function (docSnap) {
          var key = docSnap.id;
          if (!shouldSync(key)) return;
          if (pending[key]) return; // an unsent save on this device is never overwritten
          var data = docSnap.data();
          if (data.deleted) {
            window.localStorage.removeItem(key);
          } else if (typeof data.value === "string") {
            window.localStorage.setItem(key, data.value);
          }
        });
        window.sessionStorage.setItem(BOOTSTRAP_FLAG, "1");
        safeReload();
      }).catch(function (err) {
        console.error("MFD sync: initial data load failed.", err);
        FB.state('hydrate-failed', err && err.code);
      });
    }

    function listenForRemoteChanges() {
      fsMod.onSnapshot(fsMod.collection(db, COLLECTION), function (snap) {
        var changed = false;
        snap.docChanges().forEach(function (change) {
          if (change.doc.metadata.hasPendingWrites) return; // our own local write echoing back
          var key = change.doc.id;
          if (!shouldSync(key)) return;
          if (pending[key]) return; // this device has an unsent save: it gets merged with this when it is sent
          var data = change.doc.data();
          var newValue = data.deleted ? null : data.value;
          if (knownValues[key] === newValue) return; // nothing actually changed
          writeLocalOnly(key, newValue);
          bases[key] = newValue;
          changed = true;
        });
        if (changed) safeReload();
      }, function (err) {
        console.error("MFD sync: live updates stopped working.", err);
        if (err && err.code === 'permission-denied') kickOut();
      });
    }

    // If the database refuses us (account removed, rules changed) sign out
    // and go back to the sign-in screen instead of failing silently.
    var kicked = false;
    function kickOut() {
      if (kicked) return; kicked = true;
      window.sessionStorage.removeItem(BOOTSTRAP_FLAG);
      authMod.signOut(auth).then(safeReload, safeReload);
    }

    // ---------- accounts ----------
    function loadAccount(user) {
      return fsMod.getDoc(fsMod.doc(db, ACCOUNTS, user.uid)).then(function (s) {
        if (!s.exists()) return null;
        var d = s.data() || {};
        d.uid = user.uid;
        return d;
      });
    }

    // The sign-in screen only knows a last name. This public lookup (one
    // document per last name, readable without signing in, never listable)
    // tells it which account address(es) belong to that name.
    function directoryEmails(slug) {
      return fsMod.getDoc(fsMod.doc(db, DIRECTORY, slug)).then(function (s) {
        var d = s.exists() ? s.data() : null;
        return (d && Array.isArray(d.emails)) ? d.emails.slice(0, 8) : [];
      }).catch(function () { return []; });
    }

    FB.signIn = function (lastName, password) {
      var slug = slugify(lastName);
      if (!slug || !password) return Promise.reject(fail('auth/invalid-credential'));
      return directoryEmails(slug).then(function (emails) {
        if (!emails.length) emails = [slug + '@' + EMAIL_DOMAIN]; // first admin created by hand in the Firebase console
        var i = 0, lastErr = null;
        function next() {
          if (i >= emails.length) return Promise.reject(lastErr || fail('auth/invalid-credential'));
          var email = emails[i++];
          return authMod.signInWithEmailAndPassword(auth, email, password).catch(function (e) {
            lastErr = e;
            var c = e && e.code;
            if (c === 'auth/too-many-requests' || c === 'auth/network-request-failed') return Promise.reject(e);
            return next();
          });
        }
        return next();
      });
    };

    FB.signOut = function () {
      var sent = Promise.race([
        Object.keys(pending).length ? flushAllPending().catch(function () {}) : Promise.resolve(),
        new Promise(function (res) { setTimeout(res, 8000); })
      ]);
      var p = sent.then(function () { return fsMod.waitForPendingWrites ? fsMod.waitForPendingWrites(db).catch(function () {}) : null; });
      return p.then(function () {
        window.sessionStorage.removeItem(BOOTSTRAP_FLAG);
        return authMod.signOut(auth);
      });
    };

    FB.changePassword = function (current, next) {
      var user = auth.currentUser;
      if (!user || !user.email) return Promise.reject(fail('auth/no-user', 'Not signed in.'));
      if (!next || next.length < MIN_PASSWORD) return Promise.reject(fail('auth/weak-password', 'Password must be at least ' + MIN_PASSWORD + ' characters.'));
      var cred = authMod.EmailAuthProvider.credential(user.email, current);
      return authMod.reauthenticateWithCredential(user, cred).then(function () {
        return authMod.updatePassword(user, next);
      }).then(function () {
        if (FB.account && FB.account.tempPassword) {
          return fsMod.updateDoc(fsMod.doc(db, ACCOUNTS, user.uid), { tempPassword: false }).then(function () { FB.account.tempPassword = false; }, function () {});
        }
      });
    };

    function requireAdmin() {
      if (!FB.account || FB.account.role !== 'admin') throw fail('mfd/admin-only', 'Only Admin accounts can do this.');
    }

    // Admin: create a sign-in for a member. Uses a second, throw-away Firebase
    // app instance so the Admin stays signed in as themself.
    FB.createAccount = function (o) {
      try { requireAdmin(); } catch (e) { return Promise.reject(e); }
      var slug = slugify(o.lastName);
      if (!slug) return Promise.reject(fail('mfd/no-name', 'This member needs a last name first.'));
      if (!o.password || o.password.length < MIN_PASSWORD) return Promise.reject(fail('auth/weak-password', 'Password must be at least ' + MIN_PASSWORD + ' characters.'));
      var email = slug + '.' + randomSuffix() + '@' + EMAIL_DOMAIN;
      var secApp;
      try { secApp = appMod.getApp('mfd-creator'); } catch (e) { secApp = appMod.initializeApp(FIREBASE_CONFIG, 'mfd-creator'); }
      var secAuth = authMod.getAuth(secApp);
      var uid;
      return authMod.setPersistence(secAuth, authMod.inMemoryPersistence).catch(function () {}).then(function () {
        return authMod.createUserWithEmailAndPassword(secAuth, email, o.password);
      }).then(function (cred) {
        uid = cred.user.uid;
        return authMod.signOut(secAuth).catch(function () {});
      }).then(function () {
        return fsMod.setDoc(fsMod.doc(db, ACCOUNTS, uid), {
          email: email, memberId: o.memberId || '', name: o.name || '', role: o.role === 'admin' ? 'admin' : 'personnel',
          tempPassword: !!o.temp, createdAt: fsMod.serverTimestamp(), createdBy: auth.currentUser ? auth.currentUser.uid : ''
        });
      }).then(function () {
        return fsMod.setDoc(fsMod.doc(db, DIRECTORY, slug), { emails: fsMod.arrayUnion(email) }, { merge: true });
      }).then(function () { return { uid: uid, email: email }; });
    };

    FB.setAccountRole = function (uid, role) {
      try { requireAdmin(); } catch (e) { return Promise.reject(e); }
      return fsMod.updateDoc(fsMod.doc(db, ACCOUNTS, uid), { role: role === 'admin' ? 'admin' : 'personnel' });
    };

    // Admin: take a member's access away (their Firebase login can then no
    // longer read or write anything, even if they still know the password).
    FB.removeAccount = function (uid, email, lastName) {
      try { requireAdmin(); } catch (e) { return Promise.reject(e); }
      if (FB.account && uid === FB.account.uid) return Promise.reject(fail('mfd/self', 'You cannot remove your own login.'));
      return fsMod.deleteDoc(fsMod.doc(db, ACCOUNTS, uid)).then(function () {
        if (!email) return;
        var slugs = [];
        [slugify(lastName), (email || '').split('@')[0].split('.')[0]].forEach(function (x) { if (x && slugs.indexOf(x) < 0) slugs.push(x); });
        return Promise.all(slugs.map(function (sl) {
          return fsMod.setDoc(fsMod.doc(db, DIRECTORY, sl), { emails: fsMod.arrayRemove(email) }, { merge: true });
        }));
      });
    };

    // First-Admin set-up: remember which roster member this login belongs to.
    FB.linkMember = function (memberId) {
      var user = auth.currentUser;
      if (!user || !FB.account) return Promise.reject(fail('auth/no-user', 'Not signed in.'));
      return fsMod.updateDoc(fsMod.doc(db, ACCOUNTS, user.uid), { memberId: memberId }).then(function () { FB.account.memberId = memberId; });
    };

    // Admin: a member's last name changed, so sign-in must find them under the new name.
    FB.moveDirectory = function (oldLast, newLast, email) {
      try { requireAdmin(); } catch (e) { return Promise.reject(e); }
      var o = slugify(oldLast), n = slugify(newLast);
      if (!email || !n || o === n) return Promise.resolve();
      return fsMod.setDoc(fsMod.doc(db, DIRECTORY, n), { emails: fsMod.arrayUnion(email) }, { merge: true }).then(function () {
        if (o) return fsMod.setDoc(fsMod.doc(db, DIRECTORY, o), { emails: fsMod.arrayRemove(email) }, { merge: true });
      });
    };

    // ---------- start-up ----------
    function startSync() {
      if (syncStarted) return; syncStarted = true;
      pending = loadPending();
      // Send anything left unsent from earlier (closed tab, no signal) before loading shared data.
      var pre = Object.keys(pending).length ? flushAllPending().catch(function () {}) : Promise.resolve();
      pre.then(function () {
        if (FB.needsHydrate()) {
          hydrateThenReload();
        } else {
          primeKnownValues();
          patchStorage();
          listenForRemoteChanges();
        }
      });
    }

    // Keep the sign-in for this browser tab only (same as before: closing the
    // tab signs you out), shared by every page open in that tab.
    authMod.setPersistence(auth, authMod.browserSessionPersistence).catch(function () {}).then(function () {
      authMod.onAuthStateChanged(auth, function (user) {
        if (!user) { FB.user = null; FB.account = null; finishReady({ user: null }); return; }
        if (user.isAnonymous) { // left over from the old open-access version
          authMod.signOut(auth).catch(function () {}); return;
        }
        loadAccount(user).then(function (acc) {
          if (!acc) {
            finishReady({ user: null, error: 'no-access' });
            FB.state('no-access');
            return authMod.signOut(auth).catch(function () {});
          }
          FB.user = user; FB.account = acc;
          // Admin: make sure the sign-in lookup knows this account (first-admin bootstrap).
          if (acc.role === 'admin' && user.email) {
            var slug = user.email.split('@')[0].split('.')[0];
            fsMod.setDoc(fsMod.doc(db, DIRECTORY, slug), { emails: fsMod.arrayUnion(user.email) }, { merge: true }).catch(function () {});
          }
          finishReady({ user: user, account: acc });
          FB.state('signed-in');
          startSync();
        }).catch(function (err) {
          console.error("MFD sync: could not check this account.", err);
          authMod.signOut(auth).catch(function () {});
          FB.state('error', err && err.code);
          finishReady({ user: null, error: 'account-check' });
        });
      });
    });
  }).catch(function (err) {
    console.error("MFD sync: Firebase could not be loaded.", err);
    finishReady({ user: null, error: 'sdk' });
  });
})();
