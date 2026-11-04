// Chromecast support.
// With a registered Cast receiver app id (CAST_APP_ID on the server), the
// Chromecast opens receiver.html and joins the room directly, so the video goes
// peer-to-peer to the TV. Without an app id we fall back to Chrome's own
// "Cast tab" feature on the viewer page.
import { loadConfig } from './common.js';

export const CAST_NAMESPACE = 'urn:x-cast:app.castshare';

let ready;

export function initCast() {
  ready ??= loadConfig().then(
    (config) =>
      new Promise((resolve) => {
        if (!config.castAppId || !/Chrome/.test(navigator.userAgent)) return resolve(false);
        window.__onGCastApiAvailable = (ok) => {
          if (!ok) return resolve(false);
          cast.framework.CastContext.getInstance().setOptions({
            receiverApplicationId: config.castAppId,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
          });
          resolve(true);
        };
        const s = document.createElement('script');
        s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      }),
  );
  return ready;
}

export async function castRoom(room) {
  const ctx = cast.framework.CastContext.getInstance();
  await ctx.requestSession();
  const session = ctx.getCurrentSession();
  await session.sendMessage(CAST_NAMESPACE, { room });
}
