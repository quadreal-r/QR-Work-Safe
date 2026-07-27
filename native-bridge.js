/**
 * Capacitor native bridge for Work Safe.
 * Keep-awake + navigator.geolocation shim via @capacitor/geolocation.
 * Bundled by scripts/build-web.mjs into www/native-bridge.js (IIFE).
 */
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Geolocation } from '@capacitor/geolocation';

function isNative() {
  try {
    return !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  } catch (_) {
    return false;
  }
}

window.AndroidBridge = window.AndroidBridge || {
  setKeepScreenOn(on) {
    if (!isNative()) return;
    const enable = !!on;
    (async () => {
      try {
        if (enable) await KeepAwake.keepAwake();
        else await KeepAwake.allowSleep();
      } catch (_) {}
    })();
  },
};

if (isNative()) {
  const geoCallbacks = {};
  let geoSeq = 0;

  function toPosition(coords) {
    const c = coords.coords || coords;
    return {
      coords: {
        latitude: c.latitude,
        longitude: c.longitude,
        accuracy: c.accuracy != null ? c.accuracy : null,
        altitude: c.altitude != null ? c.altitude : null,
        altitudeAccuracy: c.altitudeAccuracy != null ? c.altitudeAccuracy : null,
        heading: c.heading != null ? c.heading : null,
        speed: c.speed != null ? c.speed : null,
      },
      timestamp: coords.timestamp || Date.now(),
    };
  }

  async function ensureLocationPermission() {
    try {
      let status = await Geolocation.checkPermissions();
      if (status.location !== 'granted' && status.coarseLocation !== 'granted') {
        status = await Geolocation.requestPermissions();
      }
      return status.location === 'granted' || status.coarseLocation === 'granted';
    } catch (_) {
      return false;
    }
  }

  const nativeGeo = {
    getCurrentPosition(success, error, options) {
      const id = 'g' + (++geoSeq);
      geoCallbacks[id] = { success, error };
      (async () => {
        try {
          const ok = await ensureLocationPermission();
          if (!ok) {
            const cb = geoCallbacks[id];
            delete geoCallbacks[id];
            if (cb && cb.error) {
              cb.error({
                code: 1,
                message: 'Location permission denied',
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3,
              });
            }
            return;
          }
          const pos = await Geolocation.getCurrentPosition({
            enableHighAccuracy: !(options && options.enableHighAccuracy === false),
            timeout: (options && options.timeout) || 15000,
            maximumAge: (options && options.maximumAge) || 0,
          });
          const cb = geoCallbacks[id];
          delete geoCallbacks[id];
          if (cb && cb.success) cb.success(toPosition(pos));
        } catch (e) {
          const cb = geoCallbacks[id];
          delete geoCallbacks[id];
          if (cb && cb.error) {
            cb.error({
              code: 2,
              message: (e && e.message) || 'Location unavailable',
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3,
            });
          }
        }
      })();
    },
    watchPosition(success, error, options) {
      this.getCurrentPosition(success, error, options);
      return 0;
    },
    clearWatch() {},
  };

  try {
    Object.defineProperty(navigator, 'geolocation', {
      value: nativeGeo,
      configurable: true,
    });
  } catch (_) {
    navigator.geolocation = nativeGeo;
  }
}
