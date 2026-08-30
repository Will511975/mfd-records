/*
 * MFD Records — Firestore sync shim
 * ----------------------------------
 * Makes the existing localStorage-based app share live data across
 * browsers and devices, WITHOUT changing any of the app's own logic.
 *
 * How it works:
 *  1. On the very first load in a browser tab, it signs in anonymously,
 *     downloads every synced key from Firestore into localStorage, then
 *     reloads the page once so the rest of the app boots with fresh data.
 *  2. After that, it transparently mirrors every localStorage.setItem /
 *     removeItem call (for app keys) up to Firestore, and listens for
 *     changes made by other users/tabs/devices, applying them to
 *     localStorage and reloading so the page reflects the shared data.
 *
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
  var COLLECTION = "mfd_data";
  var BOOTSTRAP_FLAG = "mfd_sync_bootstrapped";

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

    var applyingRemote = false; // guard against write-back loops
    var knownValues = {};       // last value seen/written for each key, by key

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
        console.error("MFD sync: initial data load failed; continuing with local data only.", err);
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
      });
    }

    authMod.onAuthStateChanged(auth, function (user) {
      if (!user) {
        authMod.signInAnonymously(auth).catch(function (err) {
          console.error("MFD sync: sign-in failed; app will run in local-only mode.", err);
        });
        return;
      }

      var bootstrapped = window.sessionStorage.getItem(BOOTSTRAP_FLAG) === "1";
      if (!bootstrapped) {
        hydrateThenReload();
      } else {
        primeKnownValues();
        patchStorage();
        listenForRemoteChanges();
      }
    });
  }).catch(function (err) {
    console.error("MFD sync: Firebase could not be loaded; app will run in local-only mode.", err);
  });
})();
