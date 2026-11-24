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

  function fail(code, message) { var e = new Error(message || code); e.code = code; return e; }

  var FB = window.MFD_FB = {
    config: FIREBASE_CONFIG,
    emailDomain: EMAIL_DOMAIN,
    minPassword: MIN_PASSWORD,
    slugify: slugify,
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
    function primeKnownValues() {
      try {
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (shouldSync(k)) knownValues[k] = window.localStorage.getItem(k);
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

    function pushToFirestore(key, value) {
      if (applyingRemote) return;
      knownValues[key] = value === undefined ? null : value;
      var ref = fsMod.doc(db, COLLECTION, key);
      fsMod.setDoc(ref, {
        value: value === undefined ? null : value,
        deleted: value === null || value === undefined,
        updatedAt: fsMod.serverTimestamp()
      }).catch(function (err) {
        console.error("MFD sync: failed to save '" + key + "' to the shared database.", err);
        if (err && err.code === 'permission-denied') kickOut();
      });
    }

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
          var data = change.doc.data();
          var newValue = data.deleted ? null : data.value;
          if (knownValues[key] === newValue) return; // nothing actually changed
          writeLocalOnly(key, newValue);
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
      var p = fsMod.waitForPendingWrites ? fsMod.waitForPendingWrites(db).catch(function () {}) : Promise.resolve();
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
      if (FB.needsHydrate()) {
        hydrateThenReload();
      } else {
        primeKnownValues();
        patchStorage();
        listenForRemoteChanges();
      }
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
